package markdown

import "strings"

// The CLOSED-SET frontmatter reader (s40 T1). Four keys, ~40 lines, zero
// dependencies — and that shape is the security decision, not asceticism:
// the honoured keys are a closed set, and a full YAML parser brings anchors,
// aliases, merge keys and type coercion that cannot be reached through four
// keys and therefore cannot help, but that an attacker-supplied file CAN
// reach. A reader that only understands `key: value` cannot grow an
// injection through a parser feature nobody meant to enable. If the
// vocabulary ever opens (templating), the argument reverses and
// goldmark-meta becomes right — .plans/s40 records both halves.
//
// `from` is deliberately NOT a key: "this file says where to send" and
// "this file says who I am" are different risk classes, and the sending
// identity comes from the CLI's own configuration, never file content.

// FrontmatterKeys is what a message file may say about its envelope.
type FrontmatterKeys struct {
	To      []string
	Cc      []string
	Bcc     []string
	Subject string
	// HasSubject distinguishes `subject:` present-but-empty (meant) from
	// absent (the confirm-prompt case).
	HasSubject bool
	// Unknown carries every key that was not honoured, verbatim, so a
	// `subjcet:` typo is NAMED on stderr rather than silently doing nothing.
	Unknown []string
}

// ParseFrontmatterKeys reads the raw block SplitFrontmatter returned.
// Lists (to/cc/bcc) accept comma-separated values and repeated keys, both
// accumulating. A line with no colon is malformed and lands in Unknown too —
// the same visibility rule as an unrecognised key.
func ParseFrontmatterKeys(front string) FrontmatterKeys {
	var fk FrontmatterKeys
	addrs := func(v string) []string {
		var out []string
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	for _, line := range strings.Split(front, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			fk.Unknown = append(fk.Unknown, trimmed)
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "to":
			fk.To = append(fk.To, addrs(value)...)
		case "cc":
			fk.Cc = append(fk.Cc, addrs(value)...)
		case "bcc":
			fk.Bcc = append(fk.Bcc, addrs(value)...)
		case "subject":
			fk.Subject = value
			fk.HasSubject = true
		default:
			fk.Unknown = append(fk.Unknown, strings.TrimSpace(key))
		}
	}
	return fk
}
