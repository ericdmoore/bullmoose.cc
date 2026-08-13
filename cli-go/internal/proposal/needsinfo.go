package proposal

// needsInfo — the third verb (s10 T3, .plans/s03.D-coexistence/decline-taxonomy.md),
// pure rules only, the same split as clocks.go / edit.go. A straight port of
// webmail/src/lib/approvals/needsInfo.ts, so the terminal and the browser refuse
// and word the same things.
//
// What it encodes, verbatim from the taxonomy: "I'm not ardently opposed — but
// it's pushing against some principle I'm holding. Help me better understand why
// exactly you need to do XYZ."
//
// ⚠️ It is an ACTION, never a reject reason. It carries a required human-authored
// question, moves the row `pending` → `info-requested` (out of the human's queue,
// into the agent's court, decision clock PAUSED), and records NO decision — which
// is what keeps a learning pipeline from reading it as negative feedback
// (decline-taxonomy.md, "the rule a learning pipeline must not break"). The
// reject-reason set is enforced separately (cmd/approvals.go rejectReasons) and
// `needsInfo` must never appear in it.

import "strings"

// NeedsInfoVerb is the CLI spelling of the verb, kept next to the rules so the
// refusal messages that point at it cannot drift from the command that exists.
const NeedsInfoVerb = "needs-info"

// WaitingOnAgentNote is what an `info-requested` row renders INSTEAD of a clock
// (needsInfo.ts WAITING_ON_AGENT_NOTE). There is no deadline to show: the server
// nulled `expires_at` and banked the remainder, so "expired" would be a lie and
// a countdown would be an invention.
const WaitingOnAgentNote = "waiting on the agent to answer — the decision clock is paused"

// NeedsInfoHint is why the verb exists at all, for the usage surface
// (needsInfo.ts NEEDS_INFO_HINT).
const NeedsInfoHint = "Not a decline: the agent answers your question and the proposal returns to " +
	"the queue with the dialogue attached. The decision deadline pauses while " +
	"the ball is in the agent's court."

// NeedsInfoAvailable — the verb exists on pending rows only, everywhere decline
// is offered (needsInfo.ts:17). The server enforces the same (`status = 'pending'`
// in the UPDATE's WHERE), so this only fails the obvious case early.
func NeedsInfoAvailable(status string) bool { return status == "pending" }

// QuestionProblem returns the refusal for an unusable question, or "" when it is
// fine (needsInfo.ts:26). The question is REQUIRED and human-authored: the server
// refuses an empty one, and refusing locally keeps the refusal a keystroke away
// instead of a round trip — the ApplyEdit pattern.
func QuestionProblem(question string) string {
	if strings.TrimSpace(question) == "" {
		return "a question is required — needsInfo asks the agent to justify, " +
			"and an empty ask is a decline in disguise"
	}
	return ""
}

// OpenQuestion is the round the agent still owes an answer to, or nil. The server
// mirrors it in `question` too, but the dialogue is the durable record, so it is
// what is read here (needsInfo.ts:39).
func (p *Proposal) OpenQuestion() *Amendment {
	if len(p.Amendments) == 0 {
		return nil
	}
	last := p.Amendments[len(p.Amendments)-1]
	if last.Answered() {
		return nil
	}
	return &last
}

// AnsweredRounds are the completed rounds — the Q&A a row renders under its
// rationale, wherever it renders (needsInfo.ts:47). The record travels with the
// proposal through pending, decided and history: a challenged-then-approved
// grant carrying its question and answer is the strongest "why" the provenance
// chain can hold.
func (p *Proposal) AnsweredRounds() []Amendment {
	out := make([]Amendment, 0, len(p.Amendments))
	for _, a := range p.Amendments {
		if a.Answered() {
			out = append(out, a)
		}
	}
	return out
}
