/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { decide, getProposal } from "../lib/approvals/api";
import { applyEdit, editorFor, type EditorForm } from "../lib/approvals/edit";
import type { ActionProposal, RejectReason } from "../lib/approvals/types";

/**
 * The rung-2 popover (s31): `[mark junk]` → "Making the rule…" → the composed
 * rule with its blast radius → [ Approve | Edit | Retry | Decline ] — and (X).
 *
 * A SECOND UI OVER THE SAME ROW, never a second row: the proposal it shows is
 * the one `ruleVerb.ts` minted on the invocation's own id, the verbs are
 * `ActionProposal/set` verbatim, and everything decided here reads back
 * identically in /approvals. The two surfaces cannot disagree because there
 * is only one state.
 *
 * ## (X) is "not now", and it is terminal
 *
 * Escape, the backdrop, and the ✕ all mean the same thing: `closed` — the
 * no-reason, no-training-signal ending (the server refuses a smuggled
 * reason). A graze DURING composition closes the proposal the moment it
 * lands, via a detached wait that outlives this component — never queue
 * debris, never a decision fabricated on the reader's behalf.
 *
 * ## Retry follows the successor
 *
 * A retry supersedes: the server closes this row and names the successor
 * invocation (`successorId`), whose id IS the next proposal's id — so the
 * popover swaps back to "Making the rule…" and polls the successor rather
 * than guessing by query.
 */

/** How the fresh proposal is awaited: the id is KNOWN (proposal id ==
 *  invocation id), so this is a poll on /get, not a search. */
const POLL_MS = 900;
const POLL_TRIES = 28; // ~25s — past that, composition failed or stalled

export type RuleState =
  | { kind: "minting" }
  | { kind: "ready"; p: ActionProposal }
  | { kind: "editing"; p: ActionProposal; form: EditorForm }
  | { kind: "declining"; p: ActionProposal }
  | { kind: "retrying"; p: ActionProposal; nudge: string }
  | { kind: "held" }
  | { kind: "declined" }
  | { kind: "stalled" }
  | { kind: "error"; message: string };

export interface RuleViewHandlers {
  onApprove: () => void;
  onEditOpen: () => void;
  onEditChange: (form: EditorForm) => void;
  onEditSave: () => void;
  onDeclineOpen: () => void;
  onDecline: (reason: RejectReason) => void;
  onRetryOpen: () => void;
  onRetryChange: (nudge: string) => void;
  onRetrySend: () => void;
  onBack: () => void;
  onClose: () => void;
}

/** One line of the rule, from the payload the server holds — the same shape
 *  `summarizeProposal` reads; repeated here so the popover can lead with the
 *  conditions and keep the blast radius as its own sentence. */
function ruleLine(p: ActionProposal): string {
  const rule = p.payload.rule as { all?: Array<{ field?: string; name?: string; value?: string; kind?: string }> };
  const parts = (Array.isArray(rule?.all) ? rule.all : []).map(
    (c) => `${c.field ?? c.name ?? "?"} ~ “${c.value ?? "present"}”`,
  );
  return parts.join(" AND ") || "(no conditions)";
}

function blastLine(p: ActionProposal): string | null {
  const b = p.payload.blastRadius as { tested?: number; caught?: number; answeredCaught?: number } | undefined;
  if (typeof b?.tested !== "number" || typeof b?.caught !== "number") return null;
  const replied = b.answeredCaught ? ` — ${b.answeredCaught} you replied to` : "";
  return b.caught === 0
    ? `Backtested over your last ${b.tested} messages: none would have been held.`
    : `Would have held ${b.caught} of your last ${b.tested} messages${replied}.`;
}

/** The pure face — every state renderable without a client, for tests. */
export function RulePopoverView({ state, h }: { state: RuleState; h: RuleViewHandlers }) {
  const body = () => {
    switch (state.kind) {
      case "minting":
        return <p class="rule-pop-status">Making the rule…</p>;
      case "stalled":
        return (
          <p class="rule-pop-status" role="alert">
            The composer has not answered yet. The offer will appear in <a href="/approvals">approvals</a> when it does
            — nothing further is needed here.
          </p>
        );
      case "error":
        return (
          <p class="rule-pop-status" role="alert">
            {state.message}
          </p>
        );
      case "held":
        return (
          <p class="rule-pop-status">
            In the <a href="/approvals">hold tray</a> — a few minutes to take it back, then the rule lands in your
            rulebook.
          </p>
        );
      case "declined":
        return <p class="rule-pop-status">Declined — nothing was added.</p>;
      case "editing":
        return (
          <div class="rule-pop-edit">
            <textarea
              class="rule-pop-json"
              rows={8}
              aria-label="The rule, as JSON — your edit is what lands"
              value={state.form.shape === "json" ? state.form.json : ""}
              onInput={(e) => h.onEditChange({ shape: "json", json: (e.target as HTMLTextAreaElement).value })}
            />
            <div class="rule-pop-verbs">
              <button type="button" class="agent-verb" onClick={h.onEditSave}>
                Save &amp; approve
              </button>
              <button type="button" class="agent-verb" onClick={h.onBack}>
                Back
              </button>
            </div>
          </div>
        );
      case "declining":
        return (
          <div class="rule-pop-verbs" role="group" aria-label="Why decline?">
            <button type="button" class="agent-verb" onClick={() => h.onDecline("unintendedInvocation")}>
              My slip
            </button>
            <button type="button" class="agent-verb" onClick={() => h.onDecline("wrongContent")}>
              Bad rule
            </button>
            <button type="button" class="agent-verb" onClick={() => h.onDecline("wrongAction")}>
              Should not have offered
            </button>
            <button type="button" class="agent-verb" onClick={h.onBack}>
              Back
            </button>
          </div>
        );
      case "retrying":
        return (
          <div class="rule-pop-edit">
            <input
              type="text"
              class="agent-verb-input"
              placeholder="What should change? (“broader — the whole domain”)"
              aria-label="The nudge for a new composition"
              value={state.nudge}
              onInput={(e) => h.onRetryChange((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") h.onRetrySend();
              }}
            />
            <div class="rule-pop-verbs">
              <button type="button" class="agent-verb" onClick={h.onRetrySend}>
                Compose again
              </button>
              <button type="button" class="agent-verb" onClick={h.onBack}>
                Back
              </button>
            </div>
          </div>
        );
      case "ready": {
        const blast = blastLine(state.p);
        return (
          <div>
            <p class="rule-pop-rule">
              <strong>Hold mail where</strong> {ruleLine(state.p)}
            </p>
            {blast ? <p class="rule-pop-blast">{blast}</p> : null}
            <p class="rule-pop-fine">
              Matches land in Quarantined — reviewable, never deleted. Approving is standing authority: it changes how
              future mail is handled.
            </p>
            <div class="rule-pop-verbs">
              <button type="button" class="agent-verb margin-verb-approve" onClick={h.onApprove}>
                Approve
              </button>
              <button type="button" class="agent-verb" onClick={h.onEditOpen}>
                Edit
              </button>
              <button type="button" class="agent-verb" onClick={h.onRetryOpen}>
                Retry…
              </button>
              <button type="button" class="agent-verb" onClick={h.onDeclineOpen}>
                Decline
              </button>
            </div>
          </div>
        );
      }
    }
  };

  return (
    <div class="rule-pop-backdrop">
      {/* The backdrop is a real button: tap-outside is (X), and (X) is "not
          now" — a phone must not be stranded (ContactsApp's rule). */}
      <button type="button" class="rule-pop-scrim" aria-label="Not now" onClick={h.onClose} />
      <div role="dialog" aria-modal="true" aria-label="A standing rule, proposed" class="rule-pop-panel" tabIndex={-1}>
        <div class="rule-pop-head">
          <h2 class="rule-pop-title">Never again?</h2>
          <button type="button" class="rule-pop-x" aria-label="Not now" onClick={h.onClose}>
            ✕
          </button>
        </div>
        {body()}
      </div>
    </div>
  );
}

/** Close-when-it-lands, DETACHED from the component: a graze during
 *  composition must still end as `closed` once the proposal exists, or the
 *  popover's (X) would leave queue debris exactly where the design promised
 *  none. Bounded; a composition that never lands is the stalled case and
 *  expires on its own. */
export async function closeWhenReady(client: JmapClient, accountId: string, id: string): Promise<void> {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const p = await getProposal(client, accountId, id).catch(() => null);
    if (p) {
      if (p.status === "pending") await decide(client, accountId, id, { status: "closed" }).catch(() => undefined);
      return;
    }
  }
}

export default function RulePopover({
  client,
  accountId,
  invocationId,
  onDone,
}: {
  client: JmapClient;
  accountId: string;
  invocationId: string;
  /** Called when the popover is finished with the screen — decided, closed,
   *  or stalled-and-acknowledged. The caller owns what happens next. */
  onDone: () => void;
}) {
  const [state, setState] = useState<RuleState>({ kind: "minting" });
  const [followId, setFollowId] = useState(invocationId);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // The poll: the id is known, so this is /get until the row exists.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "minting" });
    void (async () => {
      for (let i = 0; i < POLL_TRIES && !cancelled; i++) {
        const p = await getProposal(client, accountId, followId).catch(() => null);
        if (cancelled) return;
        if (p) {
          setState(p.status === "pending" ? { kind: "ready", p } : { kind: "error", message: `already ${p.status}` });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!cancelled) setState({ kind: "stalled" });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, accountId, followId]);

  const fail = (message: string) => setState({ kind: "error", message });

  const close = useCallback(() => {
    setState((s) => {
      if (s.kind === "ready" || s.kind === "editing" || s.kind === "declining" || s.kind === "retrying") {
        void decide(client, accountId, followId, { status: "closed" }).catch(() => undefined);
      } else if (s.kind === "minting") {
        // Not yet mintable-closeable: park a detached waiter so the (X)
        // still ends as `closed` when the row lands.
        void closeWhenReady(client, accountId, followId);
      }
      return s;
    });
    onDone();
  }, [client, accountId, followId, onDone]);

  // Escape is (X). Registered while mounted; the popover is the only dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const h: RuleViewHandlers = {
    onClose: close,
    onBack: () => setState((s) => ("p" in s ? { kind: "ready", p: s.p } : s)),
    onApprove: () => {
      setState((s) => {
        if (s.kind !== "ready") return s;
        void decide(client, accountId, followId, { status: "approved" }).then((r) => {
          if (!alive.current) return;
          if (r.ok) setState({ kind: "held" });
          else fail(r.message);
        });
        return s;
      });
    },
    onEditOpen: () =>
      setState((s) =>
        s.kind === "ready" ? { kind: "editing", p: s.p, form: editorFor(s.p) ?? { shape: "json", json: "{}" } } : s,
      ),
    onEditChange: (form) => setState((s) => (s.kind === "editing" ? { ...s, form } : s)),
    onEditSave: () => {
      setState((s) => {
        if (s.kind !== "editing") return s;
        const edit = applyEdit(s.p.payload, s.form);
        if (edit.problem) {
          fail(edit.problem);
          return s;
        }
        void decide(client, accountId, followId, {
          status: "approved",
          ...(edit.editedPayload ? { editedPayload: edit.editedPayload } : {}),
        }).then((r) => {
          if (!alive.current) return;
          if (r.ok) setState({ kind: "held" });
          else fail(r.message);
        });
        return s;
      });
    },
    onDeclineOpen: () => setState((s) => (s.kind === "ready" ? { kind: "declining", p: s.p } : s)),
    onDecline: (reason) => {
      void decide(client, accountId, followId, { status: "rejected", reason }).then((r) => {
        if (!alive.current) return;
        if (r.ok) setState({ kind: "declined" });
        else fail(r.message);
      });
    },
    onRetryOpen: () => setState((s) => (s.kind === "ready" ? { kind: "retrying", p: s.p, nudge: "" } : s)),
    onRetryChange: (nudge) => setState((s) => (s.kind === "retrying" ? { ...s, nudge } : s)),
    onRetrySend: () => {
      setState((s) => {
        if (s.kind !== "retrying") return s;
        const nudge = s.nudge.trim();
        void decide(client, accountId, followId, { status: "retry", ...(nudge ? { note: nudge } : {}) }).then((r) => {
          if (!alive.current) return;
          if (!r.ok) return fail(r.message);
          if (r.successorId)
            setFollowId(r.successorId); // → minting, polls the successor
          else fail("the server did not name the successor");
        });
        return s;
      });
    },
  };

  return <RulePopoverView state={state} h={h} />;
}
