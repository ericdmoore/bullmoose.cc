package cmd

// `--occurrence` — the recurrence-id half of `calendar event edit` (#222,
// s05 T3's unmet Done-when).
//
// Two small, exacting pieces: the recurrence id must be a JSCalendar
// LocalDateTime (it is a KEY in `recurrenceOverrides`, not a free string —
// a typo'd key silently creates an override for an occurrence that does not
// exist, which reads as "the edit did nothing"), and JSON-Pointer escaping,
// because the patch path is a pointer and the id contains no `/` or `~`
// today but the property names it is joined with are not this file's to
// promise.

import (
	"regexp"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"strings"
)

// JSCalendar LocalDateTime: `YYYY-MM-DDTHH:MM:SS`, no zone, no fraction
// (RFC 8984 §1.4.4). This is the exact shape `getOccurrences` returns as
// `recurrenceId`, which is where a caller gets one.
var localDateTime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`)

func occurrenceKey(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if !localDateTime.MatchString(v) {
		return "", bmio.Fail(
			"--occurrence takes a recurrence id in JSCalendar LocalDateTime form "+
				"(YYYY-MM-DDTHH:MM:SS, no timezone) — copy one from `calendar agenda --json` "+
				"(`recurrenceId`); got \""+v+"\"",
			bmio.ExitUsage)
	}
	return v, nil
}

// jmapPointerEscape is RFC 6901 §3, which JMAP PatchObject paths use: `~`
// becomes `~0` and `/` becomes `~1`. Order matters — escaping `/` first
// would then re-escape the `~` it just wrote.
func jmapPointerEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
