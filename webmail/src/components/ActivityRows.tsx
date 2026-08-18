/** @jsxImportSource preact */
// The Activity feed's STATELESS pieces (s23 v1) — list rows and the two
// read-only detail panels, split out of the island so they render-test via
// `preact-render-to-string` in plain Node (the s24 T0 bar). No hooks, no
// fetching: props in, markup out. The wording all comes from `lib/activity/
// feed.ts` and `lib/approvals/rows.ts`, tested as functions.
//
// These are deliberately NOT the ApprovalsQueue row components: that island
// is a decision surface and its rows carry verbs. This is a record — the only
// interaction is selection, and the detail renders no button at all.

import { costLabel, payloadText, summarizeProposal, tierLabel } from "../lib/approvals/rows";
import {
  actorLabel,
  agoLabel,
  decisionLabel,
  satWithYouLabel,
  statusWord,
  summarizeItem,
  summarizeWatch,
} from "../lib/activity/feed";
import type { ActivityItem, DecidedItem, WatchItem } from "../lib/activity/types";

/** Absolute instant for a detail line; the relative label leads, this anchors. */
function absolute(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

/** One selectable row in the feed's list column. */
export function FeedRow(props: {
  item: ActivityItem;
  now: number;
  active: boolean;
  /** The row's account — only worth showing on a merged feed. */
  label: string;
  onSelect: () => void;
}) {
  const { item, now, active, label } = props;
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={active ? "true" : undefined}
        class={
          "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm " +
          (active ? "bg-brand-50 ring-1 ring-brand-500/30 dark:bg-white/10" : "hover:bg-gray-50 dark:hover:bg-white/5")
        }
      >
        <span class="line-clamp-2 font-medium text-gray-900 dark:text-white">{summarizeItem(item)}</span>
        <span class="flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
          <span class="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-white/10">{statusWord(item)}</span>
          <span>{actorLabel(item)}</span>
          {label ? <span>· {label}</span> : null}
          <span>· {agoLabel(item.occurredAt, now)}</span>
          {item.type === "decided" && item.proposal.costMicros ? (
            <span>· {costLabel({ costMicros: item.proposal.costMicros, costModel: null })}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * A decided proposal, read-only: WHAT the agent wanted, WHO decided it and on
 * what grounds, WHEN, and what it cost. The retained-payload discipline shows
 * through — when an edit landed, the body shown is the HUMAN's version and
 * says so, because that is what actually carried their word.
 */
export function DecidedDetail({ item, now, label }: { item: DecidedItem; now: number; label: string }) {
  const p = item.proposal;
  const text = payloadText(p.editedPayload ?? p.payload);
  return (
    <article class="act-row">
      <header class="act-rowhead">
        <span class="pill">{p.agent}</span>
        {label ? <span class="pill">{label}</span> : null}
        <span class="pill">{p.kind}</span>
        <span class="pill">{tierLabel(p.tier)}</span>
        <span class="pill" title={p.tokensIn !== null ? `${p.tokensIn} in / ${p.tokensOut} out tokens` : undefined}>
          {costLabel(p)}
        </span>
        <span class={`pill act-status-${item.status}`}>{statusWord(item)}</span>
      </header>
      <p class="act-summary">{summarizeProposal(p)}</p>
      {/* The line the whole section exists for: whose authority. */}
      <p class="act-decision">
        {decisionLabel(item)}
        {p.decision?.note ? ` — “${p.decision.note}”` : ""}
      </p>
      <p class="act-when">
        {agoLabel(item.occurredAt, now)}
        {item.occurredAt > 0 ? ` · ${absolute(item.occurredAt)}` : ""} · {satWithYouLabel(item, now)}
      </p>
      {p.rationale ? (
        <p class="act-rationale">
          <span class="muted">the agent's why:</span> {p.rationale}
        </p>
      ) : null}
      {p.evidence.length > 0 ? (
        <p class="act-evidence">
          <span class="muted">looked at:</span>{" "}
          {p.evidence.map((e, i) => (
            <span key={i}>
              {e.realm} {e.objectId}
              {e.note ? ` — ${e.note}` : ""}
              {i < p.evidence.length - 1 ? "; " : ""}
            </span>
          ))}
        </p>
      ) : null}
      {text ? (
        <>
          {p.editedPayload ? (
            <p class="act-fine">edited before approval — the version below is yours, kept beside the agent's:</p>
          ) : null}
          <pre class="act-body">{text}</pre>
        </>
      ) : null}
    </article>
  );
}

/** A fired watch, read-only: what was being watched, what firing did, and —
 *  when the fire drafted something — where the resulting decision lives. */
export function WatchDetail({ item, now }: { item: WatchItem; now: number }) {
  const w = item.watch;
  return (
    <article class="act-row">
      <header class="act-rowhead">
        <span class="pill">watch</span>
        <span class="pill">{w.conditionType}</span>
        <span class="pill">{w.actionType}</span>
        <span class="pill act-status-fired">fired</span>
      </header>
      <p class="act-summary">{summarizeWatch(w)}</p>
      <p class="act-when">
        {agoLabel(item.occurredAt, now)}
        {item.occurredAt > 0 ? ` · ${absolute(item.occurredAt)}` : ""}
      </p>
      {w.deadlineAt !== null ? <p class="act-fine">the deadline it watched: {absolute(w.deadlineAt)}</p> : null}
      {w.sourceRef ? <p class="act-fine">set from: {w.sourceRef}</p> : null}
      {w.proposalId ? (
        <p class="act-fine">
          Firing produced proposal <code>{w.proposalId}</code> — if it still needs deciding, it is waiting in{" "}
          <a href="/approvals">Approvals</a>.
        </p>
      ) : null}
      <p class="act-fine muted">
        A fired watch is a record, not a task — nothing here to re-arm or cancel. New watches are armed from the threads
        they guard.
      </p>
    </article>
  );
}
