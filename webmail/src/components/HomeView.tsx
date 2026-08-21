/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { decide, loadQueues, type Verdict } from "../lib/approvals/api";
import { expiryLabel, isNearExpiry, rowClocks, waitedLabel } from "../lib/approvals/clocks";
import { applyEdit, editorFor, type EditorForm } from "../lib/approvals/edit";
import {
  declineNeedsReason,
  REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  accountLabel,
  approvalsAccounts,
  rowAuthority,
  approvalsGate,
  approveVerb,
  summarizeProposal,
  tierLabel,
} from "../lib/approvals/rows";
import type { ApprovalsAccount } from "../lib/approvals/rows";
import type { ActionProposal, RejectReason } from "../lib/approvals/types";
import { loadWindow } from "../lib/calendar/api";
import { browserTimeZone } from "../lib/calendar/civil";
import { queryWindow } from "../lib/calendar/grid";
import type { Occurrence } from "../lib/calendar/types";
import { horizonDays, lookingAhead, type HorizonItem } from "../lib/home/horizon";
import { waitingApprovals } from "../lib/home/waiting";
import { commitments, waitingOn } from "../lib/home/commitments";
import { loadAnnotations } from "../lib/annotations/api";
import type { Annotation } from "../lib/annotations/types";
import { CALENDARS_CAP, hasCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The home VIEW (s07 T0) — *Looking Ahead* + *Waiting Approvals*, the two
// stacks that answer "what is about to happen and what needs me". `/` is not a
// section and not a dashboard of counts: you arrive here to DECIDE something,
// which is the whole claim that keeps this a collaboration space rather than a
// file manager with a notifications tray (s07 devPlan, "What this is NOT").
//
// Deliberately THIN, the split every island here follows: vitest runs in plain
// Node with no jsdom, so every rule lives in a tested pure module —
//   • what goes in each stack, the ordering, the horizon window → `lib/home/*`
//     (which itself reuses `lib/approvals/clocks` and `lib/calendar/place`);
//   • the two-clock arithmetic, the queue order, the verbs, the JMAP calls →
//     `lib/approvals/*`, shared verbatim with `/approvals` — no second clock,
//     no second decision path.
// This file is state plumbing and markup. Waiting Approvals here is the
// CONDENSED cousin of `/approvals`: pending only, capped, no evidence and no
// diff — the "what needs me now" glance, with a link through to the full queue.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  /** Fixes the clock for a deterministic render; live ticking otherwise. */
  now?: number;
}

/** The one inline panel a pending row can open. */
type Panel =
  | { id: string; kind: "edit"; form: EditorForm }
  | { id: string; kind: "decline"; reason?: RejectReason; note: string };

export default function HomeView({ client: injectedClient, now: fixedNow }: Props) {
  const viewerZone = useMemo(() => browserTimeZone(), []);
  // Fixed at mount: the calendar FETCH window must not shift every second.
  const mountNow = useMemo(() => fixedNow ?? Date.now(), [fixedNow]);

  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  /** Per-account `ifInState` — the queue spans every reachable account (s10
   *  T7), and each carries its own state string. */
  const [states, setStates] = useState<Record<string, string>>({});
  const [loadingApprovals, setLoadingApprovals] = useState(true);

  // s18 A4 — the two chief-of-staff glances, queried over the annotations table.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loadingAnnotations, setLoadingAnnotations] = useState(true);

  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // The label clocks tick once a second — that is what makes "waited-for grows,
  // expires-in shrinks" watchable, and the horizon countdowns move.
  const [now, setNow] = useState<number>(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  // ── bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // `/`'s one non-negotiable job: an unauthenticated visitor lands on
          // the door, never on a convincing sample home a stranger could
          // mistake for theirs (lib/app/client.ts).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only and loaded on demand, so the fixtures and fake `/set`
            // never reach a live bundle (the demoCalendar.ts pattern). Home's
            // demo is the union of the approvals and calendar fakes.
            const { installHomeDemo } = await import("../lib/home/demoHome");
            installHomeDemo(resolved.demo.client, {
              now: mountNow,
              viewerZone,
              search: location.search,
            });
            if (!cancelled) setIsDemo(true);
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient]);

  const gate = approvalsGate(session);
  // Home answers "what needs me", so it must ask the same question the full
  // queue does: every account this human can reach, agents included (s10 T7).
  const approvalsAccts = useMemo(() => (session ? approvalsAccounts(session) : []), [session]);
  const approvalsKey = approvalsAccts.map((a) => a.accountId).join(",");
  const hasCalendar = session ? hasCapability(session, CALENDARS_CAP) : false;
  const calendarAcct = session
    ? (session.primaryAccounts[CALENDARS_CAP] ?? Object.keys(session.accounts)[0] ?? "")
    : "";

  // ── Waiting Approvals — the pending queue, only when there is an agent ─────
  useEffect(() => {
    if (!client || gate.state !== "open" || approvalsAccts.length === 0) {
      setLoadingApprovals(false);
      return;
    }
    let cancelled = false;
    setLoadingApprovals(true);
    void loadQueues(
      client,
      approvalsAccts.map((a) => a.accountId),
    )
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        setStates(res.states);
        setLoadingApprovals(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setFatal(message(err));
          setLoadingApprovals(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, gate.state, approvalsKey]);

  // ── Waiting-on / Commitments — the annotation glances (s18 A4) ────────────
  // Same account set and gate as the queue (both are agent-cap surfaces), but
  // AMBIENT: a failed fetch leaves the glances empty, it never takes home down.
  useEffect(() => {
    if (!client || gate.state !== "open" || approvalsAccts.length === 0) {
      setLoadingAnnotations(false);
      return;
    }
    let cancelled = false;
    setLoadingAnnotations(true);
    void loadAnnotations(
      client,
      approvalsAccts.map((a) => a.accountId),
    )
      .then((res) => {
        if (cancelled) return;
        setAnnotations(res.annotations);
        setLoadingAnnotations(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingAnnotations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, gate.state, approvalsKey]);

  // ── Looking Ahead — today/tomorrow occurrences (server-expanded) ──────────
  useEffect(() => {
    if (!client || !hasCalendar || !calendarAcct) return;
    let cancelled = false;
    const window = queryWindow(horizonDays(mountNow, viewerZone));
    void loadWindow(client, calendarAcct, window)
      .then((res) => {
        if (!cancelled) setOccurrences(res.occurrences);
      })
      // The horizon degrades gracefully: a calendar that will not load must not
      // take the whole home view down, so this failure is swallowed and Looking
      // Ahead falls back to its proposal-derived items.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, hasCalendar, calendarAcct]);

  const waiting = useMemo(() => waitingApprovals(proposals), [proposals]);
  const waits = useMemo(() => waitingOn(annotations), [annotations]);
  const promised = useMemo(() => commitments(annotations), [annotations]);
  const horizon = useMemo(
    () => lookingAhead({ proposals, occurrences, viewerZone, now }),
    [proposals, occurrences, viewerZone, now],
  );

  async function reload(): Promise<void> {
    if (!client || gate.state !== "open" || approvalsAccts.length === 0) return;
    const res = await loadQueues(
      client,
      approvalsAccts.map((a) => a.accountId),
    );
    setProposals(res.proposals);
    setStates(res.states);
  }

  async function act(id: string, verdict: Verdict): Promise<void> {
    if (!client || busyId) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const row = proposals.find((r) => r.id === id);
    if (!row) return;
    // The proposal's OWN account, and its own state — never the session's
    // default, which for an agent's proposal is the wrong account entirely.
    const outcome = await decide(client, row.accountId, id, verdict, {
      ...(states[row.accountId] ? { ifInState: states[row.accountId] as string } : {}),
    });
    if (!outcome.ok) {
      // The server's sentence, verbatim — a tier-3 capability refusal reads as
      // the wall it is (lib/approvals/api.ts).
      setRowErrors((prev) => ({ ...prev, [id]: outcome.message }));
      await reload().catch(() => undefined);
      setBusyId(undefined);
      return;
    }
    setPanel(undefined);
    await reload().catch((err) => setFatal(message(err)));
    setBusyId(undefined);
  }

  function submitEdit(p: ActionProposal, form: EditorForm): void {
    const { editedPayload, problem } = applyEdit(p.payload, form);
    if (problem) {
      setRowErrors((prev) => ({ ...prev, [p.id]: problem }));
      return;
    }
    // A no-op edit approves clean — the row must not masquerade as "approved
    // after edit" (lib/approvals/edit.ts).
    void act(p.id, { status: "approved", ...(editedPayload ? { editedPayload } : {}) });
  }

  // ── shells ────────────────────────────────────────────────────────────────
  if (fatal) {
    return (
      <div class="home home-error">
        <p role="alert">Could not reach the server: {fatal}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div class="home">
        <p class="muted home-pad">Connecting…</p>
      </div>
    );
  }

  return (
    <div class="home">
      {isDemo ? (
        <p class="home-banner">Sample data. Decisions here are kept in this browser tab and reach no server.</p>
      ) : null}

      <div class="home-cols">
        {/* Waiting Approvals leads: this product is decision-centric, and the
            first thing home answers is "what needs me". Omitted ENTIRELY — no
            dead region — for a session with no agent capability. */}
        {gate.state === "open" ? (
          <section class="home-stack" aria-label="Waiting Approvals">
            <header class="home-stack-head">
              <h2 class="home-h2">Waiting Approvals</h2>
              <a class="home-more" href="/approvals">
                full queue →
              </a>
            </header>

            {loadingApprovals ? <p class="muted home-pad">Loading what needs you…</p> : null}

            {!loadingApprovals && waiting.rows.length === 0 ? (
              <p class="muted home-pad">Nothing is waiting on you right now.</p>
            ) : null}

            {waiting.rows.map((p) => (
              <WaitingRow
                key={p.id}
                p={p}
                account={approvalsAccts.find((a) => a.accountId === p.accountId)}
                label={approvalsAccts.length > 1 ? accountLabel(approvalsAccts, p.accountId) : ""}
                now={now}
                busy={busyId === p.id}
                error={rowErrors[p.id]}
                panel={panel && panel.id === p.id ? panel : undefined}
                setPanel={setPanel}
                onApprove={() => void act(p.id, { status: "approved" })}
                onDecline={(reason, note) => void act(p.id, { status: "rejected", reason, ...(note ? { note } : {}) })}
                onSubmitEdit={(form) => submitEdit(p, form)}
              />
            ))}

            {waiting.more > 0 ? (
              <a class="home-more home-more-row" href="/approvals">
                {waiting.more} more waiting → full queue
              </a>
            ) : null}
          </section>
        ) : null}

        <section class="home-stack" aria-label="Looking Ahead">
          <header class="home-stack-head">
            <h2 class="home-h2">Looking Ahead</h2>
            <span class="muted home-fine">today & tomorrow</span>
          </header>

          {horizon.length === 0 ? (
            <p class="muted home-pad">Nothing on the horizon for today or tomorrow.</p>
          ) : (
            <ul class="home-horizon">
              {horizon.map((item) => (
                <HorizonRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>

        {/* The two chief-of-staff questions (s18 A4), each a query over the
            annotations table. Agent-cap gated like the queue: no agent, no
            commentary, no dead region. */}
        {gate.state === "open" ? (
          <section class="home-stack" aria-label="Waiting on">
            <header class="home-stack-head">
              <h2 class="home-h2">Waiting on</h2>
              <span class="muted home-fine">replies you're expecting</span>
            </header>
            {loadingAnnotations ? <p class="muted home-pad">Loading…</p> : null}
            {!loadingAnnotations && waits.rows.length === 0 ? (
              <p class="muted home-pad">You're not waiting on anyone right now.</p>
            ) : null}
            {waits.rows.length > 0 ? (
              <ul class="home-annos">
                {waits.rows.map((a) => (
                  <AnnotationRow key={a.id} a={a} />
                ))}
              </ul>
            ) : null}
            {waits.more > 0 ? <p class="muted home-pad home-fine">+{waits.more} more</p> : null}
          </section>
        ) : null}

        {gate.state === "open" ? (
          <section class="home-stack" aria-label="Commitments">
            <header class="home-stack-head">
              <h2 class="home-h2">Commitments</h2>
              <span class="muted home-fine">what you promised</span>
            </header>
            {loadingAnnotations ? <p class="muted home-pad">Loading…</p> : null}
            {!loadingAnnotations && promised.rows.length === 0 ? (
              <p class="muted home-pad">No open commitments — nothing you've promised is outstanding.</p>
            ) : null}
            {promised.rows.length > 0 ? (
              <ul class="home-annos">
                {promised.rows.map((a) => (
                  <AnnotationRow key={a.id} a={a} />
                ))}
              </ul>
            ) : null}
            {promised.more > 0 ? <p class="muted home-pad home-fine">+{promised.more} more</p> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ── An annotation glance row (s18 A4) ───────────────────────────────────────
// Display-only: the click-through to the anchored message is A3's margin, not
// here. The panel header carries the category, so the row shows the claim and
// — for an agent extraction — how sure it was. A human-filed claim (confidence
// null) shows no badge: it is true because a human said so.
function AnnotationRow({ a }: { a: Annotation }) {
  const pct = a.confidence != null ? `${Math.round(a.confidence * 100)}%` : null;
  return (
    <li class="home-anno">
      <span class="home-anno-body">{a.body}</span>
      {pct ? (
        <span class="home-anno-conf" title="the agent's confidence in this reading">
          {pct}
        </span>
      ) : null}
    </li>
  );
}

// ── Waiting Approvals row (condensed) ───────────────────────────────────────

function WaitingRow(props: {
  p: ActionProposal;
  /** The account the row came off — its authority decides the verbs. */
  account: ApprovalsAccount | undefined;
  /** The account label, on a merged queue only. */
  label: string;
  now: number;
  busy: boolean;
  error: string | undefined;
  panel: Panel | undefined;
  setPanel: (panel: Panel | undefined) => void;
  onApprove: () => void;
  onDecline: (reason: RejectReason | undefined, note: string) => void;
  onSubmitEdit: (form: EditorForm) => void;
}) {
  const { p, now, busy, error, panel, setPanel } = props;
  const clocks = rowClocks(p, now);
  const editor = editorFor(p);
  // Same honesty rule as the full queue: no verb is offered that the account's
  // authority cannot carry (lib/approvals/accounts.ts).
  const authority = rowAuthority(p, props.account);

  return (
    <article class={`home-row${isNearExpiry(clocks) ? " home-urgent" : ""}`}>
      <header class="home-rowhead">
        <span class="pill">{p.agent}</span>
        {props.label ? <span class="pill home-account">{props.label}</span> : null}
        <span class="pill">{p.kind}</span>
        <span class={`pill home-tier-${p.tier}`}>{tierLabel(p.tier)}</span>
      </header>
      <p class="home-summary">{summarizeProposal(p)}</p>
      {/* The rationale one-liner survives the condensing; evidence, the body
          preview and the diff do not — those are the full page's job. */}
      <p class="home-rationale">{p.rationale}</p>

      {/* The two opposed marks. `expiresAt` only — `holdUntil` is a different
          clock and never renders on a pending row (lib/approvals/clocks.ts). */}
      <p class="home-clocks">
        <span class="home-waited">{waitedLabel(p, clocks)}</span>
        <span class={`home-expiry${isNearExpiry(clocks) ? " home-expiry-near" : ""}`}>
          {expiryLabel(clocks.expiresInMs)}
        </span>
      </p>

      {p.tier === 3 ? <p class="home-fine home-warn">{TIER3_CAPABILITY_NOTE}</p> : null}
      {error ? (
        <p class="home-error-line" role="alert">
          {error}
        </p>
      ) : null}

      {panel?.kind === "edit" ? (
        <EditPanel
          form={panel.form}
          original={p.payload}
          busy={busy}
          onChange={(form) => setPanel({ id: p.id, kind: "edit", form })}
          onSubmit={() => props.onSubmitEdit(panel.form)}
          onCancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "decline" ? (
        <DeclinePanel
          reason={panel.reason}
          note={panel.note}
          busy={busy}
          needsReason={declineNeedsReason(p.kind)}
          onChange={(reason, note) => setPanel({ id: p.id, kind: "decline", reason, note })}
          onSubmit={() => {
            if (declineNeedsReason(p.kind) && !panel.reason) return;
            props.onDecline(panel.reason, panel.note);
          }}
          onCancel={() => setPanel(undefined)}
        />
      ) : (
        <div class="home-actions">
          {authority.canApprove ? (
            <>
              <button type="button" disabled={busy} onClick={props.onApprove}>
                {approveVerb(p.tier)}
              </button>
              {editor ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPanel({ id: p.id, kind: "edit", form: editor })}
                >
                  Edit
                </button>
              ) : null}
            </>
          ) : null}
          {authority.canDecline ? (
            <button
              type="button"
              class="home-danger"
              disabled={busy}
              onClick={() => setPanel({ id: p.id, kind: "decline", note: "" })}
            >
              Decline
            </button>
          ) : null}
          {/* A withheld verb is explained here too — the full queue's sentence,
              so the two surfaces say the same thing about the same row. */}
          {authority.note ? <span class="home-fine home-warn">{authority.note}</span> : null}
        </div>
      )}
    </article>
  );
}

// ── Looking Ahead row ───────────────────────────────────────────────────────

function HorizonRow({ item }: { item: HorizonItem }) {
  return (
    <li class={`home-hz home-hz-${item.kind}`}>
      <a class="home-hz-link" href={item.href}>
        <span class={`home-hz-tag home-hz-tag-${item.kind}`}>{HORIZON_TAG[item.kind]}</span>
        <span class="home-hz-title">{item.title}</span>
        {item.agent ? <span class="home-hz-agent">{item.agent}</span> : null}
        <span class="home-hz-clock">{item.clockLabel}</span>
      </a>
    </li>
  );
}

/** What each horizon kind is called on its tag — the meaning, not the field. */
const HORIZON_TAG: Record<HorizonItem["kind"], string> = {
  event: "event",
  expiring: "decide by",
  hold: "hold",
};

// ── inline panels (reused shape from /approvals, condensed markup) ──────────

function EditPanel(props: {
  form: EditorForm;
  original: Record<string, unknown>;
  busy: boolean;
  onChange: (form: EditorForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { form, original, busy } = props;
  // Live preview of what will be retained: a no-op edit approves clean.
  const preview = applyEdit(original, form);
  return (
    <div class="home-editor">
      {form.shape === "reply" ? (
        <>
          <label class="home-label">
            Subject
            <input
              type="text"
              value={form.subject}
              onInput={(e) => props.onChange({ ...form, subject: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="home-label">
            Body
            <textarea
              rows={6}
              value={form.text}
              onInput={(e) => props.onChange({ ...form, text: (e.target as HTMLTextAreaElement).value })}
            />
          </label>
        </>
      ) : (
        <label class="home-label">
          Payload (JSON)
          <textarea
            rows={8}
            spellcheck={false}
            value={form.json}
            onInput={(e) => props.onChange({ ...form, json: (e.target as HTMLTextAreaElement).value })}
          />
        </label>
      )}
      <p class="home-fine">
        {preview.problem
          ? preview.problem
          : preview.editedPayload
            ? "Your version is kept beside the agent's original — the diff is the signal."
            : "No changes yet — approving now approves the agent's version unchanged."}
      </p>
      <div class="home-actions">
        <button type="button" disabled={busy || Boolean(preview.problem)} onClick={props.onSubmit}>
          {preview.editedPayload ? "Approve with edits" : "Approve unchanged"}
        </button>
        <button type="button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeclinePanel(props: {
  reason: RejectReason | undefined;
  note: string;
  busy: boolean;
  /** False on a NO-FAULT kind: the server refuses a reason there, so asking
   * for one would make the verb unsendable (`declineNeedsReason`). */
  needsReason: boolean;
  onChange: (reason: RejectReason | undefined, note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="home-editor">
      <p class="home-fine">
        {props.needsReason
          ? "Why not? Each reason steers a different correction — the last one is a hard stop, not a stronger no."
          : "Declining this is an answer, not a complaint: nothing negative is recorded about the agent."}
      </p>
      {(props.needsReason ? REJECT_REASONS : []).map((r) => (
        <label key={r.reason} class={r.severe ? "home-reason home-reason-severe" : "home-reason"}>
          <input
            type="radio"
            name="home-decline-reason"
            checked={props.reason === r.reason}
            onChange={() => props.onChange(r.reason, props.note)}
          />
          <span>
            {r.label} <span class="muted">— {r.hint}</span>
          </span>
        </label>
      ))}
      <div class="home-actions">
        <button
          type="button"
          class="home-danger"
          disabled={props.busy || (props.needsReason && !props.reason)}
          onClick={props.onSubmit}
        >
          Decline
        </button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
