package markdown

// Local file references in rendered Markdown, resolved three ways — a port of
// packages/cli/src/assets.ts.
//
//	local <img>  under linkMax → a CID inline part (multipart/related)
//	local <a>    under linkMax → a real attachment, its link text annotated
//	anything     over  linkMax → uploaded, and the reference rewritten to an
//	                             expiring signed URL
//
// Remote references (http, https, mailto, #, cid, data) pass through untouched.
//
// ## Two decisions inherited from the TypeScript, both worth keeping
//
// **cid:, not data: URLs.** Gmail and Outlook strip data: URLs, so an inline
// image encoded that way silently vanishes for most recipients. cid: is the
// email-native mechanism and it is the reason this step exists at all.
//
// **An attachment cannot be hyperlinked to.** Mail has no way to point an <a>
// at a part of itself, so a local link under the size limit becomes an
// attachment and the anchor is replaced by its text plus a note. Leaving the
// href would produce a link that resolves to the SENDER'S filesystem — dead
// for the recipient, and on a bad day pointing at something real on theirs.
//
// ## A missing file is a WARNING, not an error
//
// A body that references a file which is not there still sends, with the
// reference left as written and a line on stderr. The alternative — refusing —
// means a typo'd image path blocks a message the human already wrote, and mail
// is not a build.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// InlinePart is an image carried in the message and referenced by `cid:`.
type InlinePart struct {
	CID     string
	Type    string
	Name    string
	Content []byte
}

// AttachmentPart is a file carried in the message.
type AttachmentPart struct {
	Type    string
	Name    string
	Content []byte
}

// LinkedFile is one that was too large to carry and became a URL instead.
type LinkedFile struct {
	Name string
	URL  string
}

// ShareFn uploads a file and returns a public, expiring URL for it. Injected
// so this package neither knows about JMAP nor needs a server to be tested.
type ShareFn func(name, mediaType string, content []byte) (string, error)

// Processed is the result: rewritten bodies plus everything to attach.
type Processed struct {
	HTML        string
	Text        string
	Inline      []InlinePart
	Attachments []AttachmentPart
	Linked      []LinkedFile
	Warnings    []string
}

var (
	imgRe = regexp.MustCompile(`(?i)<img\b[^>]*\bsrc="([^"]+)"[^>]*>`)
	// (?s) so an anchor spanning lines still matches — rendered HTML wraps.
	anchorRe = regexp.MustCompile(`(?is)<a\b[^>]*\bhref="([^"]+)"[^>]*>(.*?)</a>`)
	// A scheme, a protocol-relative //, or a fragment: all NOT ours to load.
	remoteRe = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*:|//|#)`)
)

// ProcessAssets rewrites html/text and collects the parts to carry.
func ProcessAssets(markdown, html, baseDir string, linkMaxBytes int64, share ShareFn) (*Processed, error) {
	out := &Processed{HTML: html, Text: markdown}
	seen := map[string]bool{}

	for _, m := range imgRe.FindAllStringSubmatch(html, -1) {
		src := m[1]
		if isRemote(src) {
			continue
		}
		file, ok := loadLocal(src, baseDir, out)
		if !ok {
			continue
		}
		if int64(len(file.Content)) <= linkMaxBytes {
			cid, err := newCID(len(out.Inline))
			if err != nil {
				return nil, err
			}
			out.Inline = append(out.Inline, InlinePart{CID: cid, Type: file.Type, Name: file.Name, Content: file.Content})
			out.HTML = strings.ReplaceAll(out.HTML, `src="`+src+`"`, `src="cid:`+cid+`"`)
			continue
		}
		u, err := share(file.Name, file.Type, file.Content)
		if err != nil {
			return nil, err
		}
		out.Linked = append(out.Linked, LinkedFile{Name: file.Name, URL: u})
		out.HTML = strings.ReplaceAll(out.HTML, `src="`+src+`"`, `src="`+u+`"`)
		// The TEXT part too: a plain-text reader must not be left with a path
		// that only means something on the sender's machine.
		out.Text = strings.ReplaceAll(out.Text, src, u)
	}

	for _, m := range anchorRe.FindAllStringSubmatch(out.HTML, -1) {
		anchor, href, inner := m[0], m[1], m[2]
		if isRemote(href) {
			continue
		}
		file, ok := loadLocal(href, baseDir, out)
		if !ok {
			continue
		}
		if int64(len(file.Content)) <= linkMaxBytes {
			key, err := filepath.Abs(filepath.Join(baseDir, href))
			if err != nil {
				key = href
			}
			// Deduped by resolved PATH: the same file linked twice is carried
			// once, but both anchors are still annotated.
			if !seen[key] {
				out.Attachments = append(out.Attachments, AttachmentPart{Type: file.Type, Name: file.Name, Content: file.Content})
				seen[key] = true
			}
			out.HTML = strings.ReplaceAll(out.HTML, anchor, inner+` <em>[attached: `+file.Name+`]</em>`)
			continue
		}
		u, err := share(file.Name, file.Type, file.Content)
		if err != nil {
			return nil, err
		}
		out.Linked = append(out.Linked, LinkedFile{Name: file.Name, URL: u})
		out.HTML = strings.ReplaceAll(out.HTML, `href="`+href+`"`, `href="`+u+`"`)
		out.Text = strings.ReplaceAll(out.Text, href, u)
	}

	return out, nil
}

func isRemote(ref string) bool { return remoteRe.MatchString(ref) }

type localFile struct {
	Name    string
	Type    string
	Content []byte
}

// loadLocal reads a referenced file, or records a warning and returns false.
func loadLocal(ref, baseDir string, out *Processed) (localFile, bool) {
	path := ref
	if !filepath.IsAbs(path) {
		// decodeURI first: the renderer percent-encodes spaces in hrefs, and
		// `my%20file.png` does not exist on disk.
		if dec, err := url.PathUnescape(ref); err == nil {
			path = dec
		}
		path = filepath.Join(baseDir, path)
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		out.Warnings = append(out.Warnings, "local reference not found, left as-is: "+ref)
		return localFile{}, false
	}
	content, err := os.ReadFile(path)
	if err != nil {
		out.Warnings = append(out.Warnings, "could not read "+ref+": "+err.Error())
		return localFile{}, false
	}
	return localFile{Name: filepath.Base(path), Type: mimeType(path), Content: content}, true
}

// newCID mints a Content-ID. The index keeps them ordered for a reader looking
// at the raw source; the random half keeps two sends from colliding.
func newCID(index int) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d.%s@bullmoose", index, hex.EncodeToString(b)), nil
}

var mimeTypes = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml",
	"avif": "image/avif", "pdf": "application/pdf", "txt": "text/plain",
	"md": "text/markdown", "csv": "text/csv", "json": "application/json",
	"html": "text/html", "zip": "application/zip", "mp4": "video/mp4",
	"mp3": "audio/mpeg",
}

// mimeType is a fixed table, not a sniff. What a file IS decides how a client
// renders it, and guessing from content would mean a mislabelled part is a
// silent rendering bug rather than a visible unknown.
func mimeType(path string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	if t, ok := mimeTypes[ext]; ok {
		return t
	}
	return "application/octet-stream"
}
