package markdown

import (
	"reflect"
	"testing"
)

// s40 T1 — the closed-set reader. Four keys, and the SHAPE is the security
// decision: no YAML features can be reached through it.
func TestParseFrontmatterKeys(t *testing.T) {
	fk := ParseFrontmatterKeys("to: a@b.c, d@e.f\ncc: g@h.i\nsubject: Project Elk kickoff\nto: j@k.l")
	if !reflect.DeepEqual(fk.To, []string{"a@b.c", "d@e.f", "j@k.l"}) {
		t.Fatalf("to: %v", fk.To)
	}
	if !reflect.DeepEqual(fk.Cc, []string{"g@h.i"}) || fk.Subject != "Project Elk kickoff" || !fk.HasSubject {
		t.Fatalf("cc/subject: %+v", fk)
	}
	if len(fk.Unknown) != 0 {
		t.Fatalf("unknown: %v", fk.Unknown)
	}
}

func TestParseFrontmatterKeys_UnknownNamed(t *testing.T) {
	// A `subjcet:` typo is NAMED, never silently nothing — and `from` is
	// deliberately not a key: "who I am" never comes from file content, so it
	// lands in Unknown like any stranger.
	fk := ParseFrontmatterKeys("subjcet: oops\nfrom: attacker@evil.example\nnot a key value line")
	if !reflect.DeepEqual(fk.Unknown, []string{"subjcet", "from", "not a key value line"}) {
		t.Fatalf("unknown: %v", fk.Unknown)
	}
	if fk.HasSubject || len(fk.To) != 0 {
		t.Fatalf("honoured something it should not: %+v", fk)
	}
}

func TestParseFrontmatterKeys_SubjectPresentButEmpty(t *testing.T) {
	// `subject:` written and left empty is MEANT (no confirm prompt); absent
	// is the ask-first case. HasSubject carries the difference.
	fk := ParseFrontmatterKeys("to: a@b.c\nsubject:")
	if !fk.HasSubject || fk.Subject != "" {
		t.Fatalf("want present-but-empty, got %+v", fk)
	}
}
