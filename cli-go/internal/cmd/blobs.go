package cmd

// `bullmoose blobs` — what R2 actually holds for this account, and the explicit
// delete (s08 T6 wave 5; a port of packages/cli/src/blobs.ts cmdBlobs):
//
//	blobs list            every stored object, largest first
//	blobs rm <blobId>     explicit delete; refused if mail or a share needs it
//
// ⚠️ Those are the WHOLE verb set. There is no `blobs download` and no
// `blobs share`, and this port does not invent either:
//
//   - DOWNLOAD exists as a ROUTE (`/api/download/{accountId}/{blobId}`, bearer
//     header) reached through the session resource's RFC 8620 §2 `downloadUrl`
//     template, and the only CLI caller is `read --raw` (jmap.ts:274). Adding a
//     `blobs download` verb would be new CLI surface, not a port.
//   - SHARE is its own top-level command (`bullmoose share list|revoke`,
//     blobs.ts:77) over `/api/shares/…`, still delegated to Node. Minting a link
//     (`POST /api/share/{accountId}/{blobId}`, jmap.ts:198) has NO verb at all on
//     either side — it happens only as a side effect of `send --expandMD html`'s
//     big-file path. Reported as a gap rather than filled here.
//
// The listing endpoint is not a JMAP method: `/api/blobs/…` is a REST path on the
// base URL, because RFC 8620 defines a session template for download only
// (jmap.ts:218). Its refusals therefore carry an HTTP STATUS rather than a JMAP
// error type — which is exactly why bmio.ExitCodeFor consults the status when the
// type is unrecognised: the contract suite's `blobs rm b_0` answers 409
// `blobInUse`, a word no JMAP vocabulary knows, and it must still exit 5.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// blobListing is `GET /api/blobs/{accountId}` — jmap.ts:32 BlobListing. The
// entries stay RAW: `blobs list --json` emits `{accountId, ...b}`, which in
// JavaScript is the server's object with its own keys in its own order and one
// key prepended.
type blobListing struct {
	Blobs     []json.RawMessage `json:"blobs"`
	TotalSize *float64          `json:"totalSize"`
	Cursor    string            `json:"cursor"`
}

// blobEntry is the part of one entry this command reads: the id it prints and the
// size it sorts by. Everything else passes through untouched.
type blobEntry struct {
	raw    json.RawMessage
	blobID string
	// size is NaN when the server sent none, not 0: `b.size - a.size` over an
	// absent size is NaN in JavaScript, which the sort reads as "equal" and
	// leaves the pair where it was. Reading it as 0 would REORDER the list.
	size     float64
	uploaded string
}

func runBlobs(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	// blobs.ts:37 pickAccountId — the cli/009 single-account rule. Resolved
	// before the verb switch, so an unresolvable account costs zero requests.
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		return die(s, err)
	}
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	sub, arg := a.at(1), a.at(2)
	switch sub {
	case "list":
		return blobsList(ctx, s, client, acc.AccountID, a)
	case "rm":
		return blobsRemove(ctx, s, client, acc.AccountID, a, arg)
	default:
		named := sub
		if named == "" {
			named = "(none)"
		}
		return die(s, bmio.Usage("unknown blobs subcommand: "+named+" (list|rm)"))
	}
}

func blobsList(ctx context.Context, s *bmio.Streams, client *jmap.Client, accountID string, a args) int {
	raw, err := client.ListBlobs(ctx, accountID)
	if err != nil {
		return die(s, err)
	}
	var listing blobListing
	if err := json.Unmarshal(raw, &listing); err != nil {
		return die(s, err)
	}
	entries := make([]blobEntry, 0, len(listing.Blobs))
	for _, item := range listing.Blobs {
		var meta struct {
			BlobID   string   `json:"blobId"`
			Size     *float64 `json:"size"`
			Uploaded string   `json:"uploaded"`
		}
		if err := json.Unmarshal(item, &meta); err != nil {
			return die(s, err)
		}
		e := blobEntry{raw: item, blobID: meta.BlobID, uploaded: meta.Uploaded}
		if meta.Size != nil {
			e.size = *meta.Size
		} else {
			e.size = math.NaN()
		}
		entries = append(entries, e)
	}

	if a.IDs {
		// The SERVER's order, not the sorted one — blobs.ts:44 maps the
		// unsorted array, and an id list is for `| xargs`, not for reading.
		ids := make([]string, len(entries))
		for i, e := range entries {
			ids[i] = e.blobID
		}
		s.EmitIDs(ids)
		return 0
	}

	if a.JSON {
		// §1.3 — the COLLECTION streams; the totals below are a summary, and a
		// summary is chrome. `| head` on a 10k-object account still works.
		for _, e := range sortedBySize(entries) {
			// `{accountId, ...b}`: accountId FIRST, then the server's own keys
			// in the server's own order. jsobj is what preserves that; a
			// map[string]any would sort them and every line would differ from
			// Node's.
			record, err := jsobj.Parse(e.raw)
			if err != nil {
				return die(s, err)
			}
			out := jsobj.New()
			if err := out.Set("accountId", accountID); err != nil {
				return die(s, err)
			}
			for _, key := range record.Keys() {
				value, _ := record.Raw(key)
				// SetRaw keeps an existing key's POSITION, which is JavaScript's
				// spread semantics: a server-sent accountId would overwrite the
				// value without moving to the end.
				out.SetRaw(key, value)
			}
			if err := s.EmitJSON(out); err != nil {
				return die(s, err)
			}
		}
		s.Note(fmt.Sprintf("%d object(s), %s total", len(entries), formatSize(totalSize(listing))))
		if listing.Cursor != "" {
			s.Note("(more — listing is paginated)")
		}
		return 0
	}

	s.Out(renderBlobs(entries))
	s.Note(fmt.Sprintf("\n  %d object(s), %s total", len(entries), formatSize(totalSize(listing))))
	if listing.Cursor != "" {
		s.Note("  (more — listing is paginated)")
	}
	return 0
}

func blobsRemove(ctx context.Context, s *bmio.Streams, client *jmap.Client, accountID string, a args, blobID string) int {
	if blobID == "" {
		return die(s, bmio.Usage("bullmoose blobs rm <blobId> [--account <sel>] [--dry-run]"))
	}
	if a.DryRun {
		// Invariant 4: the rehearsal costs ZERO writes. Unlike `mailbox rm`
		// there is nothing to resolve first — a blob id is content-addressed,
		// so there is no selector that could be wrong in an interesting way.
		s.Note("dry run: would delete blob " + blobID + "; nothing was written")
		if a.JSON {
			_ = s.EmitJSON(ordered{{"dryRun", true}, {"blobId", blobID}})
		}
		return 0
	}
	raw, err := client.DeleteBlob(ctx, accountID, blobID)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		// The server's own object, repeated rather than re-derived — the same
		// choice `read --json` makes, and the reason this is jsobj.Compact and
		// not a decode into a struct.
		line, err := jsobj.Compact(raw)
		if err != nil {
			return die(s, err)
		}
		s.Out(line)
		return 0
	}
	s.Out("deleted " + blobID)
	return 0
}

// ---- rendering (pure; this is what the tests hold) --------------------------

// sortedBySize is `[...blobs].sort((a, b) => b.size - a.size)` — largest first,
// on a COPY, and stable, because V8's sort is stable and two equal-sized objects
// must keep the server's order on both implementations.
func sortedBySize(entries []blobEntry) []blobEntry {
	out := append([]blobEntry(nil), entries...)
	sort.SliceStable(out, func(i, j int) bool { return out[j].size < out[i].size })
	return out
}

// renderBlobs is blobs.ts:137. Sorted largest-first: the question this command
// exists to answer is "what is R2 billing me for", and that is the top of the
// list.
func renderBlobs(entries []blobEntry) string {
	if len(entries) == 0 {
		return "  (no blobs)"
	}
	lines := make([]string, 0, len(entries))
	for _, e := range sortedBySize(entries) {
		lines = append(lines, fmt.Sprintf("  %s  %9s  %s",
			e.blobID, formatSize(e.size), jsSliceUTF16(e.uploaded, 10)))
	}
	return strings.Join(lines, "\n")
}

// totalSize is `res.totalSize` as JavaScript reads it: an absent one is
// `undefined`, whose arithmetic is NaN — and formatSize then prints "NaN KB"
// rather than a comforting zero that would hide a broken server.
func totalSize(l blobListing) float64 {
	if l.TotalSize == nil {
		return math.NaN()
	}
	return *l.TotalSize
}

// formatSize is blobs.ts:166, including its rounding rule: one decimal below 10,
// a whole number above, and TB as the last unit rather than inventing one.
func formatSize(bytes float64) string {
	if bytes < 1024 {
		return jsNumberString(bytes) + " B"
	}
	units := []string{"KB", "MB", "GB", "TB"}
	n := bytes / 1024
	i := 0
	for n >= 1024 && i < len(units)-1 {
		n /= 1024
		i++
	}
	if n < 10 {
		return jsToFixed1(n) + " " + units[i]
	}
	return jsNumberString(jsMathRound(n)) + " " + units[i]
}

// jsMathRound is `Math.round`: floor(x + 0.5), so a .5 goes UP rather than to
// even. math.Round rounds half AWAY FROM ZERO, which agrees here only because a
// size is never negative — spelling it out keeps that an observation rather than
// a coincidence.
func jsMathRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	return math.Floor(x + 0.5)
}

// jsNumberString is `String(n)` for the integral values formatSize prints.
func jsNumberString(n float64) string {
	if math.IsNaN(n) {
		return "NaN"
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// jsToFixed1 is `Number.prototype.toFixed(1)`, and it is NOT
// strconv.FormatFloat(n, 'f', 1, 64).
//
// ECMA-262 §21.1.3.3 picks the integer n minimising |n/10 − x| and, on a TIE, the
// LARGER n. Go rounds ties to even. They disagree on every exact quarter: 1280
// bytes is 1.25 KB, which JavaScript prints "1.3 KB" and FormatFloat prints
// "1.2 KB". big.Rat makes the comparison exact rather than approximately right,
// which matters because the whole point of the port is that the two
// implementations print the same bytes.
func jsToFixed1(x float64) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.IsInf(x, 0) {
		if x > 0 {
			return "Infinity"
		}
		return "-Infinity"
	}
	r := new(big.Rat).SetFloat64(x) // exact: a float64 IS a rational
	r.Mul(r, big.NewRat(10, 1))
	r.Add(r, big.NewRat(1, 2))
	// big.Int.Div is Euclidean, so with a positive denominator it is floor —
	// floor(10x + 1/2) is exactly "the larger n on a tie".
	n := new(big.Int).Div(r.Num(), r.Denom())
	sign := ""
	if n.Sign() < 0 {
		sign = "-"
		n.Neg(n)
	}
	whole := new(big.Int)
	frac := new(big.Int)
	whole.DivMod(n, big.NewInt(10), frac)
	return sign + whole.String() + "." + frac.String()
}

// jsSliceUTF16 is `s.slice(0, n)` — counted in UTF-16 code units, which is what
// JavaScript slices by. The dates this formats are ASCII, but a port that used
// bytes would truncate mid-character on anything else.
func jsSliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		if units >= n {
			return s[:i]
		}
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return s
}
