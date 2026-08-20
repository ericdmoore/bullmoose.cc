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
import { Badge, DescList, DescRow, StackedRow, StatusDot } from "./ui";
import type { BadgeTone, StatusDotTone } from "../lib/ui/classes";
import { ChevronRightIcon } from "./icons";

function absolute(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

function wordTone(word: string): { badge: BadgeTone; dot: StatusDotTone } {
  if (word === "approved" || word === "accepted") return { badge: "success", dot: "success" };
  if (word === "declined" || word === "rejected" || word === "expired") return { badge: "error", dot: "error" };
  if (word === "yanked" || word === "held") return { badge: "warn", dot: "warn" };
  if (word === "fired") return { badge: "accent", dot: "success" };
  return { badge: "neutral", dot: "neutral" };
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
  const word = statusWord(item);
  const tone = wordTone(word);
  return (
    <StackedRow active={active} onSelect={props.onSelect}>
      <StatusDot tone={tone.dot} />
      <div class="min-w-0 flex-auto">
        <p class="line-clamp-2 text-sm/6 font-semibold text-gray-900 dark:text-white">{summarizeItem(item)}</p>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 text-xs/5 text-gray-500 dark:text-gray-400">
          <span>{actorLabel(item)}</span>
          {label ? <span>· {label}</span> : null}
          <span>· {agoLabel(item.occurredAt, now)}</span>
          {item.type === "decided" && item.proposal.costMicros ? (
            <span>· {costLabel({ costMicros: item.proposal.costMicros, costModel: null })}</span>
          ) : null}
        </div>
      </div>
      <Badge tone={tone.badge}>{word}</Badge>
      <ChevronRightIcon class="size-5 flex-none text-gray-400" />
    </StackedRow>
  );
}

export function DecidedDetail({ item, now, label }: { item: DecidedItem; now: number; label: string }) {
  const p = item.proposal;
  const text = payloadText(p.editedPayload ?? p.payload);
  const word = statusWord(item);
  return (
    <article class="px-4 py-5 sm:px-6">
      <header class="flex flex-wrap items-center gap-2">
        <Badge>{p.agent}</Badge>
        {label ? <Badge>{label}</Badge> : null}
        <Badge>{p.kind}</Badge>
        <Badge>{tierLabel(p.tier)}</Badge>
        <Badge title={p.tokensIn !== null ? `${p.tokensIn} in / ${p.tokensOut} out tokens` : undefined}>
          {costLabel(p)}
        </Badge>
        <Badge tone={wordTone(word).badge}>{word}</Badge>
      </header>
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeProposal(p)}</h3>
      <p class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">
        {decisionLabel(item)}
        {p.decision?.note ? ` — “${p.decision.note}”` : ""}
      </p>
      <DescList class="mt-4">
        <DescRow term="When">
          {agoLabel(item.occurredAt, now)}
          {item.occurredAt > 0 ? ` · ${absolute(item.occurredAt)}` : ""} · {satWithYouLabel(item, now)}
        </DescRow>
        {p.rationale ? (
          <DescRow term="The agent's why">
            <span class="text-gray-500 dark:text-gray-400">the agent's why:</span> {p.rationale}
          </DescRow>
        ) : null}
        {p.evidence.length > 0 ? (
          <DescRow term="Looked at">
            <span class="text-gray-500 dark:text-gray-400">looked at:</span>{" "}
            {p.evidence.map((e, i) => (
              <span key={i}>
                {e.realm} {e.objectId}
                {e.note ? ` — ${e.note}` : ""}
                {i < p.evidence.length - 1 ? "; " : ""}
              </span>
            ))}
          </DescRow>
        ) : null}
        {text ? (
          <DescRow term={p.editedPayload ? "Your version" : "Payload"}>
            {p.editedPayload ? (
              <p class="mb-2 text-xs text-gray-500 dark:text-gray-400">
                edited before approval — the version below is yours, kept beside the agent's:
              </p>
            ) : null}
            <pre class="max-h-56 overflow-y-auto rounded-md bg-gray-50 px-3 py-2 text-xs/5 whitespace-pre-wrap text-gray-700 dark:bg-white/5 dark:text-gray-300">
              {text}
            </pre>
          </DescRow>
        ) : null}
      </DescList>
    </article>
  );
}

export function WatchDetail({ item, now }: { item: WatchItem; now: number }) {
  const w = item.watch;
  return (
    <article class="px-4 py-5 sm:px-6">
      <header class="flex flex-wrap items-center gap-2">
        <Badge>watch</Badge>
        <Badge>{w.conditionType}</Badge>
        <Badge>{w.actionType}</Badge>
        <Badge tone="accent">fired</Badge>
      </header>
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeWatch(w)}</h3>
      <DescList class="mt-4">
        <DescRow term="When">
          {agoLabel(item.occurredAt, now)}
          {item.occurredAt > 0 ? ` · ${absolute(item.occurredAt)}` : ""}
        </DescRow>
        {w.deadlineAt !== null ? <DescRow term="the deadline it watched:">{absolute(w.deadlineAt)}</DescRow> : null}
        {w.sourceRef ? <DescRow term="set from:">{w.sourceRef}</DescRow> : null}
        {w.proposalId ? (
          <DescRow term="Proposal">
            Firing produced proposal <code>{w.proposalId}</code> — if it still needs deciding, it is waiting in{" "}
            <a href="/approvals" class="font-medium text-brand-600 hover:text-brand-500">
              Approvals
            </a>
            .
          </DescRow>
        ) : null}
        <DescRow term="Note">
          A fired watch is a record, not a task — nothing here to re-arm or cancel. New watches are armed from the
          threads they guard.
        </DescRow>
      </DescList>
    </article>
  );
}
