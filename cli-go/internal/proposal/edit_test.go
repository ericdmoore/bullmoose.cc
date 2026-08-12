package proposal

import "testing"

// TestApplyEdit_NoOpSendsNothing is the subtle, load-bearing rule (s07 §T4): an
// edit session that changes nothing must produce NO editedPayload, so "approved
// clean" is never faked into "approved after edit".
func TestApplyEdit_NoOpSendsNothing(t *testing.T) {
	payload := map[string]any{
		"to":      "outside@example.com",
		"subject": "Re: the thread",
		"text":    "the agent's draft",
		"blobId":  "b_1",
	}

	// Reply edit that re-supplies the SAME subject/text → no-op.
	edited, problem := ApplyEdit(payload, EditorForm{
		Shape: "reply", Subject: "Re: the thread", Text: "the agent's draft",
	})
	if problem != "" {
		t.Fatalf("unexpected problem: %s", problem)
	}
	if edited != nil {
		t.Errorf("no-op reply edit produced editedPayload %v — must be nil", edited)
	}

	// A real change → editedPayload, with the send-shaped fields preserved.
	edited, problem = ApplyEdit(payload, EditorForm{
		Shape: "reply", Subject: "Re: the thread", Text: "a human rewrite",
	})
	if problem != "" || edited == nil {
		t.Fatalf("real edit: edited=%v problem=%q", edited, problem)
	}
	if edited["text"] != "a human rewrite" {
		t.Errorf("edited text = %v", edited["text"])
	}
	if edited["to"] != "outside@example.com" || edited["blobId"] != "b_1" {
		t.Errorf("edit must preserve to/blobId, got %v", edited)
	}
}

func TestApplyEdit_JSONShape(t *testing.T) {
	payload := map[string]any{"a": float64(1), "b": float64(2)}

	// Reformatting only (key order flipped) is NOT an edit.
	edited, problem := ApplyEdit(payload, EditorForm{Shape: "json", JSON: `{"b":2,"a":1}`})
	if problem != "" || edited != nil {
		t.Errorf("reformat-only json: edited=%v problem=%q — must be a no-op", edited, problem)
	}

	// A value change is an edit.
	edited, problem = ApplyEdit(payload, EditorForm{Shape: "json", JSON: `{"a":1,"b":3}`})
	if problem != "" || edited == nil || edited["b"] != float64(3) {
		t.Errorf("changed json: edited=%v problem=%q", edited, problem)
	}

	// Bad JSON and non-object JSON both refuse and send nothing.
	if _, p := ApplyEdit(payload, EditorForm{Shape: "json", JSON: `{oops`}); p == "" {
		t.Error("malformed json must report a problem")
	}
	if _, p := ApplyEdit(payload, EditorForm{Shape: "json", JSON: `[1,2,3]`}); p == "" {
		t.Error("a JSON array is not a payload object — must refuse")
	}
}

func TestSameJSON_KeyOrderIndependent(t *testing.T) {
	a := map[string]any{"x": float64(1), "y": []any{float64(1), float64(2)}}
	b := map[string]any{"y": []any{float64(1), float64(2)}, "x": float64(1)}
	if !SameJSON(a, b) {
		t.Error("SameJSON must ignore key order")
	}
	c := map[string]any{"x": float64(1), "y": []any{float64(2), float64(1)}} // array order matters
	if SameJSON(a, c) {
		t.Error("SameJSON must respect array order")
	}
}

func TestEditorFor(t *testing.T) {
	// grant-request is not editable — approve/deny as asked (arch.md §1).
	if _, ok := EditorFor("grant-request", map[string]any{}); ok {
		t.Error("grant-request must not be editable")
	}
	// reply-draft opens a reply form pre-filled from the payload.
	form, ok := EditorFor("reply-draft", map[string]any{"subject": "S", "text": "T"})
	if !ok || form.Shape != "reply" || form.Subject != "S" || form.Text != "T" {
		t.Errorf("reply-draft editor = %+v ok=%v", form, ok)
	}
	// anything else opens a whole-payload JSON editor.
	form, ok = EditorFor("organize-files", map[string]any{"moves": float64(3)})
	if !ok || form.Shape != "json" {
		t.Errorf("organize-files editor = %+v ok=%v", form, ok)
	}
}

func TestPayloadDiff(t *testing.T) {
	orig := map[string]any{"keep": float64(1), "change": "old", "drop": true}
	edit := map[string]any{"keep": float64(1), "change": "new", "add": "x"}
	diffs := PayloadDiff(orig, edit)

	byKey := map[string]FieldDiff{}
	for _, d := range diffs {
		byKey[d.Key] = d
	}
	if _, ok := byKey["keep"]; ok {
		t.Error("unchanged key must not appear in the diff")
	}
	if d := byKey["change"]; d.Before != "old" || d.After != "new" {
		t.Errorf("change diff = %+v", d)
	}
	if d := byKey["drop"]; !d.Removed {
		t.Errorf("dropped key must be marked Removed, got %+v", d)
	}
	if d := byKey["add"]; !d.Added || d.After != "x" {
		t.Errorf("added key must be marked Added, got %+v", d)
	}
}
