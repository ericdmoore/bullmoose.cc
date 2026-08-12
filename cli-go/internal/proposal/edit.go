package proposal

import (
	"encoding/json"
	"sort"
	"strings"
)

// Edit — the load-bearing verb (s07 devPlan §T4), a port of
// webmail/src/lib/approvals/edit.ts.
//
// Approve/Decline is a gate; Edit is collaboration: the human amends the proposal
// and approves the amended thing. The data contract that makes it worth having is
// retention — the human's version goes to `editedPayload` and the agent's
// `payload` is NEVER overwritten (actionProposal.ts:222-228), so the diff between
// the two survives as the highest-signal feedback the system collects.
//
// The subtle rule, tested because it is easy to lose: an edit session that
// changes NOTHING must send NO `editedPayload`. "Approved clean" and "approved
// after edit" are different outcomes for the agent (s07 §T4), and opening the
// editor must not be able to move a row from one column to the other.

// EditorForm is what the human edits over: a reply-shaped payload (the two fields
// a person actually rewrites) or, for anything else structured, the payload as
// JSON edited whole (edit.ts:22).
type EditorForm struct {
	Shape   string // "reply" | "json"
	Subject string
	Text    string
	JSON    string
}

// EditorFor opens an editor over the payload, or reports that this kind is not
// editable — edit.ts:34. `grant-request` is not editable: the ask is approve/deny
// as asked (arch.md §1); silently rewriting a permission request would grant
// something nobody requested.
func EditorFor(kind string, payload map[string]any) (EditorForm, bool) {
	if kind == "grant-request" {
		return EditorForm{}, false
	}
	if kind == "reply-draft" || kind == "start-thread" {
		return EditorForm{
			Shape:   "reply",
			Subject: strField(payload, "subject"),
			Text:    strField(payload, "text"),
		}, true
	}
	pretty, _ := json.MarshalIndent(payload, "", "  ")
	return EditorForm{Shape: "json", JSON: string(pretty)}, true
}

// ApplyEdit merges the human's fields back over the agent's payload — edit.ts:63.
// Reply edits touch only subject/text; the send-shaped fields the server
// validates (to/blobId/inReplyTo, actionProposal.ts:429-436) ride through
// untouched.
//
// The return contract encodes the no-op rule:
//
//	(nil, "")       no change — approve WITHOUT editedPayload ("approved clean")
//	(payload, "")   a real edit — approve WITH editedPayload
//	(nil, problem)  cannot apply (bad JSON / not an object) — send nothing
func ApplyEdit(payload map[string]any, form EditorForm) (edited map[string]any, problem string) {
	if form.Shape == "reply" {
		next := cloneMap(payload)
		next["subject"] = form.Subject
		next["text"] = form.Text
		if SameJSON(next, payload) {
			return nil, ""
		}
		return next, ""
	}

	var parsed any
	if err := json.Unmarshal([]byte(form.JSON), &parsed); err != nil {
		return nil, "Edited payload is not valid JSON — nothing was sent."
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		// Mirrors the server's own check: "editedPayload must be an object"
		// (actionProposal.ts:226-228). Refusing here keeps it local.
		return nil, "Edited payload must be a JSON object — nothing was sent."
	}
	if SameJSON(obj, payload) {
		return nil, ""
	}
	return obj, ""
}

// FieldDiff is one payload key that differs between the agent's version and the
// human's (edit.ts:87).
type FieldDiff struct {
	Key     string
	Before  any
	After   any
	Added   bool // key added by the edit (no Before)
	Removed bool // key removed by the edit (no After)
}

// PayloadDiff is a key-level diff of `payload` vs `editedPayload` — what `show`
// renders under "edited before approval" (edit.ts:101). Unlike edit.ts it walks
// keys in sorted order rather than insertion order, because a Go map has none;
// the set of diffs is identical, only their listing order differs.
func PayloadDiff(original, edited map[string]any) []FieldDiff {
	var out []FieldDiff
	for _, k := range sortedKeys(original) {
		ev, ok := edited[k]
		switch {
		case !ok:
			out = append(out, FieldDiff{Key: k, Before: original[k], Removed: true})
		case !SameJSON(original[k], ev):
			out = append(out, FieldDiff{Key: k, Before: original[k], After: ev})
		}
	}
	for _, k := range sortedKeys(edited) {
		if _, ok := original[k]; !ok {
			out = append(out, FieldDiff{Key: k, After: edited[k], Added: true})
		}
	}
	return out
}

// SameJSON is structural equality via stable JSON — key order must not count as
// an edit (edit.ts:164). This is what makes the no-op rule robust: reformatting
// the JSON editor buffer without changing a value sends no editedPayload.
func SameJSON(a, b any) bool { return stable(a) == stable(b) }

// stable is a canonical serialization with object keys sorted — edit.ts:168.
func stable(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case map[string]any:
		keys := sortedKeys(t)
		var sb strings.Builder
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			sb.Write(kb)
			sb.WriteByte(':')
			sb.WriteString(stable(t[k]))
		}
		sb.WriteByte('}')
		return sb.String()
	case []any:
		var sb strings.Builder
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(stable(e))
		}
		sb.WriteByte(']')
		return sb.String()
	default:
		// Scalars (string, bool, and JSON numbers decoded as float64) — Go's
		// encoder renders a whole float64 without a decimal point, matching
		// JSON.stringify (5.0 → "5"), which the diff/no-op comparison relies on.
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	return out
}

func strField(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}
