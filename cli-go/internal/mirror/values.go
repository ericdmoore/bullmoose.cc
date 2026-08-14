package mirror

import (
	"bytes"
	"encoding/json"
	"sort"
	"time"
)

// The value coercions the mirror columns need, each pinned to the TypeScript
// expression it replaces. They are small enough to look obvious and were each
// wrong in an obvious way first — `Date.parse` of an unparseable string is NaN
// in JS, `Object.keys` keeps a false-valued key, and `JSON.stringify` does not
// HTML-escape.

// nowMillis is Date.now() (sync.ts:246, the last_sync column).
func nowMillis() int64 { return time.Now().UnixMilli() }

// ParseMillis is Date.parse(receivedAt) — sync.ts:373. An unparseable timestamp
// is 0 rather than JS's NaN: NaN would land in an INTEGER NOT NULL column as
// something no reader expects, and 1970 is at least sortable.
func ParseMillis(iso string) int64 {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// jsonList renders a stored JSON array column. The server's own bytes pass
// through compacted (json.Compact only strips insignificant whitespace); an
// absent or null list becomes "[]", which is the column default and what
// `JSON.stringify(e.cc ?? [])` produces.
func jsonList(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "[]"
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, trimmed); err != nil {
		return "[]"
	}
	return buf.String()
}

// stateString is `String(r.newState)` (sync.ts:113) — the probe compares the
// server's state to the stored cursor, and the TypeScript stringifies whatever
// came back rather than assuming a string. An ABSENT newState is "undefined",
// which cannot equal a real cursor, so the account is dirty; that is the answer
// this function has to keep giving.
func stateString(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "undefined"
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err == nil {
		return s
	}
	return string(trimmed) // a number, a bool or null prints as its literal
}

// ParseAddresses decodes an address-list column/field for rendering. A malformed
// list is empty rather than fatal — the row is already stored; failing to print
// a sender is not worth losing the message over.
func ParseAddresses(raw json.RawMessage) []Address {
	var out []Address
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// firstOrNil is `e.messageId?.[0] ?? null` (sync.ts:363) — a nil interface so
// database/sql writes SQL NULL rather than an empty string.
func firstOrNil(list []string) any {
	if len(list) == 0 {
		return nil
	}
	return list[0]
}

// deref is `x ?? ""`.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// boolInt is `x ? 1 : 0` (sync.ts:374).
func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// sortedKeys is Object.keys() with a deterministic order. Note it keeps keys
// whose value is FALSE, exactly as Object.keys does: a JMAP `mailboxIds` map is
// a set, and a client that filtered on the boolean would drop rows.
func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
