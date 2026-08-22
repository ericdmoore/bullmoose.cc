/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import type { EditorForm } from "../lib/approvals/edit";
import { applyEdit, diffLines, editorFor, payloadDiff } from "../lib/approvals/edit";
import {
  NEEDS_INFO_HINT,
  NEEDS_INFO_VERB,
  WAITING_ON_AGENT_NOTE,
  answeredRounds,
  openQuestion,
  questionProblem,
} from "../lib/approvals/needsInfo";
import {
  HOLD_UNWIRED_NOTE,
  declineNeedsReason,
  REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  approveVerb,
  describeReason,
  payloadText,
  rowAuthority,
  costLabel,
  summarizeProposal,
  tierLabel,
  type ApprovalsAccount,
} from "../lib/approvals/rows";
import {
  dueFromInput,
  dueInputValue,
  dueLabel,
  expiryLabel,
  holdLabel,
  isNearExpiry,
  rowClocks,
  waitedLabel,
} from "../lib/approvals/clocks";
import type { ActionProposal, RejectReason } from "../lib/approvals/types";
import { Alert, Badge, Button, DescList, DescRow, Field, Input, Textarea } from "./ui";
import type { BadgeTone } from "../lib/ui/classes";

type Panel =
  | { id: string; kind: "edit"; form: EditorForm }
  | { id: string; kind: "decline"; reason?: RejectReason; note: string }
  | { id: string; kind: "needs-info"; question: string }
  | { id: string; kind: "due"; value: string };

export type { Panel };

function tierTone(tier: number): BadgeTone {
  if (tier >= 3) return "error";
  if (tier === 2) return "warn";
  return "accent";
}

function statusTone(status: ActionProposal["status"]): BadgeTone {
  if (status === "rejected" || status === "expired") return "error";
  if (status === "approved") return "success";
  if (status === "held" || status === "info-requested") return "warn";
  return "neutral";
}

function ActionBar({ children }: { children: ComponentChildren }) {
  return <div class="mt-4 flex flex-wrap items-center gap-2">{children}</div>;
}

function Payload({ text }: { text: string }) {
  return (
    <pre class="max-h-36 overflow-y-auto rounded-md bg-gray-50 px-3 py-2 text-xs/5 whitespace-pre-wrap text-gray-700 dark:bg-white/5 dark:text-gray-300">
      {text}
    </pre>
  );
}

export function PendingRow(props: {
  p: ActionProposal;
  account: ApprovalsAccount | undefined;
  showAccount: boolean;
  now: number;
  busy: boolean;
  error: string | undefined;
  /** s36 V2 — set when this row waits on an undecided cause. Replaces the
   *  approve verb with the sentence: visible-but-blocked, not grey mystery. */
  waitsNote?: string | null;
  panel: Panel | undefined;
  setPanel: (panel: Panel | undefined) => void;
  onApprove: () => void;
  onDecline: (reason: RejectReason | undefined, note: string) => void;
  onNeedsInfo: (question: string) => void;
  onSubmitEdit: (form: EditorForm) => void;
  onCorrectDue: (dueAt: string | null) => void;
}) {
  const { p, account, now, busy, error, panel, setPanel } = props;
  const clocks = rowClocks(p, now);
  const editor = editorFor(p);
  const text = payloadText(p.payload);
  const authority = rowAuthority(p, account);
  const near = isNearExpiry(clocks);

  return (
    <article class={near ? "px-4 py-5 ring-1 ring-inset ring-amber-400/50 sm:px-6" : "px-4 py-5 sm:px-6"}>
      <RowHead p={p} label={props.showAccount ? (account?.name ?? p.accountId) : ""} />
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeProposal(p)}</h3>
      {p.rationale ? <p class="mt-1 text-sm/6 text-gray-600 dark:text-gray-400">{p.rationale}</p> : null}
      <DescList class="mt-4">
        {p.evidence.length > 0 ? (
          <DescRow term="Looked at">
            {p.evidence.map((e, i) => (
              <span key={i}>
                {e.realm} {e.objectId}
                {e.note ? ` — ${e.note}` : ""}
                {i < p.evidence.length - 1 ? "; " : ""}
              </span>
            ))}
          </DescRow>
        ) : null}
        <DescRow term="Waited">{waitedLabel(p, clocks)}</DescRow>
        <DescRow term="Expires">
          <span class={near ? "font-semibold text-red-600 dark:text-red-400" : ""}>
            {expiryLabel(clocks.expiresInMs)}
          </span>
        </DescRow>
        <DescRow term="Due">
          <span class="inline-flex flex-wrap items-center gap-2">
            {dueLabel(p.dueAt, now)}
            <Button
              size="sm"
              disabled={busy}
              title="The agent inferred this from the message — fix it if it mis-read"
              onClick={() => setPanel({ id: p.id, kind: "due", value: dueInputValue(p.dueAt) })}
            >
              Correct
            </Button>
          </span>
        </DescRow>
        {text ? (
          <DescRow term="Payload">
            <Payload text={text} />
          </DescRow>
        ) : null}
      </DescList>
      <Dialogue p={p} />

      {p.tier === 3 ? (
        <Alert tone="warn" class="mt-4">
          {TIER3_CAPABILITY_NOTE}
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" class="mt-4">
          {error}
        </Alert>
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
      ) : panel?.kind === "needs-info" ? (
        <NeedsInfoPanel
          question={panel.question}
          busy={busy}
          onChange={(question) => setPanel({ id: p.id, kind: "needs-info", question })}
          onSubmit={() => props.onNeedsInfo(panel.question.trim())}
          onCancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "due" ? (
        <DuePanel
          value={panel.value}
          busy={busy}
          onChange={(value) => setPanel({ id: p.id, kind: "due", value })}
          onSubmit={() => props.onCorrectDue(dueFromInput(panel.value))}
          onClear={() => props.onCorrectDue(null)}
          onCancel={() => setPanel(undefined)}
        />
      ) : (
        <ActionBar>
          {props.waitsNote ? (
            // Blocked, and it says why — the approve verb would only refuse.
            // Decline stays: saying no to a blocked consequence is always open.
            <span class="text-sm text-amber-700 dark:text-amber-300">{props.waitsNote}</span>
          ) : authority.canApprove ? (
            <>
              <Button variant="primary" disabled={busy} onClick={props.onApprove}>
                {approveVerb(p.tier)}
              </Button>
              {editor ? (
                <Button disabled={busy} onClick={() => setPanel({ id: p.id, kind: "edit", form: editor })}>
                  Edit
                </Button>
              ) : null}
            </>
          ) : null}
          {authority.canDecline ? (
            <>
              <Button disabled={busy} onClick={() => setPanel({ id: p.id, kind: "needs-info", question: "" })}>
                {NEEDS_INFO_VERB}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setPanel({ id: p.id, kind: "decline", note: "" })}
              >
                Decline
              </Button>
            </>
          ) : null}
          {authority.note ? <span class="text-sm text-amber-700 dark:text-amber-300">{authority.note}</span> : null}
        </ActionBar>
      )}
    </article>
  );
}

export function InfoRequestedRow({ p, label }: { p: ActionProposal; label: string }) {
  const open = openQuestion(p);
  return (
    <article class="px-4 py-5 sm:px-6">
      <RowHead p={p} label={label} />
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeProposal(p)}</h3>
      {p.rationale ? <p class="mt-1 text-sm/6 text-gray-600 dark:text-gray-400">{p.rationale}</p> : null}
      <Dialogue p={p} />
      <DescList class="mt-4">
        {open ? <DescRow term="You asked">“{open.question}”</DescRow> : null}
        <DescRow term="Status">{WAITING_ON_AGENT_NOTE}</DescRow>
      </DescList>
    </article>
  );
}

export function HeldRow({ p, now, label }: { p: ActionProposal; now: number; label: string }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="px-4 py-5 sm:px-6">
      <RowHead p={p} label={label} />
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeProposal(p)}</h3>
      <DescList class="mt-4">
        <DescRow term="Waited">{waitedLabel(p, clocks)}</DescRow>
        <DescRow term="Hold">{holdLabel(clocks.holdRemainingMs)}</DescRow>
      </DescList>
      <EditedDiff p={p} />
      <ActionBar>
        <Button disabled title={HOLD_UNWIRED_NOTE}>
          Commit now
        </Button>
        <Button variant="danger" disabled title={HOLD_UNWIRED_NOTE}>
          Yank
        </Button>
        <span class="text-xs text-gray-500 dark:text-gray-400">{HOLD_UNWIRED_NOTE}</span>
      </ActionBar>
    </article>
  );
}

export function HistoryRow({ p, now, label }: { p: ActionProposal; now: number; label: string }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="px-4 py-5 sm:px-6">
      <RowHead p={p} label={label} />
      <h3 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{summarizeProposal(p)}</h3>
      <DescList class="mt-4">
        <DescRow term="Waited">{waitedLabel(p, clocks)}</DescRow>
        {p.status === "expired" ? (
          <DescRow term="Outcome">
            <span class="font-semibold text-red-600 dark:text-red-400">expired undecided — the chance lapsed</span>
          </DescRow>
        ) : null}
        {p.decision ? (
          <DescRow term="Decision">
            {p.status} by {p.decision.by}
            {p.decision.reason ? ` — ${describeReason(p.decision.reason)}` : ""}
            {p.decision.note ? ` — “${p.decision.note}”` : ""}
          </DescRow>
        ) : null}
      </DescList>
      <Dialogue p={p} />
      <EditedDiff p={p} />
    </article>
  );
}

function Dialogue({ p }: { p: ActionProposal }) {
  const rounds = answeredRounds(p);
  if (rounds.length === 0) return null;
  return (
    <div class="mt-4 border-l-2 border-gray-200 pl-4 dark:border-white/10">
      {rounds.map((a, i) => (
        <div key={i} class="py-1">
          <p class="text-sm text-gray-700 dark:text-gray-300">
            <span class="text-gray-500 dark:text-gray-400">{a.askedBy} asked:</span> “{a.question}”
          </p>
          <p class="text-sm text-gray-700 dark:text-gray-300">
            <span class="text-gray-500 dark:text-gray-400">{p.agent} answered:</span> {a.answer}
          </p>
        </div>
      ))}
    </div>
  );
}

function RowHead({ p, label }: { p: ActionProposal; label: string }) {
  return (
    <header class="flex flex-wrap items-center gap-2">
      <Badge>{p.agent}</Badge>
      {label ? <Badge>{label}</Badge> : null}
      <Badge>{p.kind}</Badge>
      <Badge tone={tierTone(p.tier)}>{tierLabel(p.tier)}</Badge>
      <Badge title={p.tokensIn !== null ? `${p.tokensIn} in / ${p.tokensOut} out tokens` : undefined}>
        {costLabel(p)}
      </Badge>
      {p.status !== "pending" ? <Badge tone={statusTone(p.status)}>{p.status}</Badge> : null}
    </header>
  );
}

function EditedDiff({ p }: { p: ActionProposal }) {
  if (!p.editedPayload) return null;
  const fields = payloadDiff(p.payload, p.editedPayload);
  if (fields.length === 0) return null;
  return (
    <details class="mt-4 text-sm text-gray-600 dark:text-gray-400">
      <summary class="cursor-pointer">edited before approval — the agent's version vs yours</summary>
      {fields.map((f) =>
        f.key === "text" && typeof f.before === "string" && typeof f.after === "string" ? (
          <pre
            key={f.key}
            class="mt-2 overflow-x-auto rounded-md bg-gray-50 px-3 py-2 text-xs whitespace-pre-wrap dark:bg-white/5"
          >
            {diffLines(f.before, f.after).map((line, i) => (
              <span
                key={i}
                class={
                  line.op === "del"
                    ? "text-red-600 line-through dark:text-red-400"
                    : line.op === "add"
                      ? "text-brand-700 dark:text-brand-300"
                      : ""
                }
              >
                {line.op === "del" ? "− " : line.op === "add" ? "+ " : "  "}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <p key={f.key} class="mt-1 text-xs">
            <code>{f.key}</code>: {JSON.stringify(f.before ?? null)} → {JSON.stringify(f.after ?? null)}
          </p>
        ),
      )}
    </details>
  );
}

function EditPanel(props: {
  form: EditorForm;
  original: Record<string, unknown>;
  busy: boolean;
  onChange: (form: EditorForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { form, original, busy } = props;
  const preview = applyEdit(original, form);
  return (
    <div class="mt-4 flex flex-col gap-4 border-t border-gray-100 pt-4 dark:border-white/10">
      {form.shape === "reply" ? (
        <>
          <Field label="Subject">
            <Input
              type="text"
              value={form.subject}
              onInput={(e) => props.onChange({ ...form, subject: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <Field label="Body">
            <Textarea
              rows={8}
              value={form.text}
              onInput={(e) => props.onChange({ ...form, text: (e.target as HTMLTextAreaElement).value })}
            />
          </Field>
        </>
      ) : (
        <Field label="Payload (JSON)">
          <Textarea
            rows={10}
            spellcheck={false}
            value={form.json}
            onInput={(e) => props.onChange({ ...form, json: (e.target as HTMLTextAreaElement).value })}
          />
        </Field>
      )}
      <p class="text-xs text-gray-500 dark:text-gray-400">
        {preview.problem
          ? preview.problem
          : preview.editedPayload
            ? "Your version is kept beside the agent's original — the diff is the signal."
            : "No changes yet — approving now approves the agent's version unchanged."}
      </p>
      <ActionBar>
        <Button variant="primary" disabled={busy || Boolean(preview.problem)} onClick={props.onSubmit}>
          {preview.editedPayload ? "Approve with edits" : "Approve unchanged"}
        </Button>
        <Button disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}

function DeclinePanel(props: {
  reason: RejectReason | undefined;
  note: string;
  busy: boolean;
  needsReason: boolean;
  onChange: (reason: RejectReason | undefined, note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-white/10">
      <p class="text-sm text-gray-600 dark:text-gray-400">
        {props.needsReason
          ? "Why not? Each reason steers a different correction — the last one is a hard stop, not a stronger no."
          : "Declining this is an answer, not a complaint: nothing negative is recorded about the agent."}
      </p>
      {(props.needsReason ? REJECT_REASONS : []).map((r) => (
        <label
          key={r.reason}
          class={
            r.severe
              ? "flex items-baseline gap-2 border-l-2 border-red-500 pl-2 text-sm text-red-700 dark:text-red-300"
              : "flex items-baseline gap-2 text-sm text-gray-900 dark:text-white"
          }
        >
          <input
            type="radio"
            name="decline-reason"
            checked={props.reason === r.reason}
            onChange={() => props.onChange(r.reason, props.note)}
          />
          <span>
            {r.label} <span class="text-gray-500 dark:text-gray-400">— {r.hint}</span>
          </span>
        </label>
      ))}
      <Field label="Note (optional)">
        <Input
          type="text"
          value={props.note}
          onInput={(e) => props.onChange(props.reason, (e.target as HTMLInputElement).value)}
        />
      </Field>
      <ActionBar>
        <Button variant="danger" disabled={props.busy || (props.needsReason && !props.reason)} onClick={props.onSubmit}>
          Decline
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}

function DuePanel(props: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-white/10">
      <p class="text-sm text-gray-600 dark:text-gray-400">
        When the work itself is due — the agent read it out of the message, so fix it if the reading is wrong. Clearing
        it means "no deadline": the work is never treated as urgent.
      </p>
      <Field label="Due (your local time)">
        <Input
          type="datetime-local"
          value={props.value}
          onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        />
      </Field>
      <ActionBar>
        <Button variant="primary" disabled={props.busy || props.value.trim().length === 0} onClick={props.onSubmit}>
          Save due date
        </Button>
        <Button disabled={props.busy} onClick={props.onClear}>
          Clear — no deadline
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}

function NeedsInfoPanel(props: {
  question: string;
  busy: boolean;
  onChange: (question: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const problem = questionProblem(props.question);
  return (
    <div class="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-white/10">
      <p class="text-sm text-gray-600 dark:text-gray-400">{NEEDS_INFO_HINT}</p>
      <Field label="Your question (required)">
        <Input
          type="text"
          value={props.question}
          placeholder="Why do you need this?"
          onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        />
      </Field>
      <ActionBar>
        <Button variant="primary" disabled={props.busy || Boolean(problem)} onClick={props.onSubmit}>
          Ask the agent
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}
