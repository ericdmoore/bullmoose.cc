// The out-of-office responder (RFC 8621 §8) — the other half of HumanSettings
// (sVOL `024`, s07 T2).
//
// The datatype is a FACADE over one row of the armed-responder primitive
// (`services/jmap/src/methods/vacation.ts:4-9`), and the id is the literal
// string `"singleton"` (`:19`). `VacationResponse/set` requires
// `update.singleton` to be present and throws `invalidArguments` otherwise
// (`:36-39`); `create` and `destroy` are never read at all.
//
// Three server behaviours drive everything in this file. Each one is a place
// where the honest client and the obvious client differ.

import type { JmapClient } from "../jmap/JmapClient";

/**
 * ⚠️ **`htmlBody` is permanently `null` server-side, so this editor is
 * plain-text and there is no rich-text path to add.**
 *
 * Verified in the method source, both halves:
 *   • `VacationResponse/get` hardcodes `htmlBody: null` on every response —
 *     `services/jmap/src/methods/vacation.ts:25`. There is no column behind it.
 *   • `VacationResponse/set` never reads `patch.htmlBody`. `next` is built from
 *     `isEnabled`, `subject`, `textBody`, `fromDate`, `toDate` only
 *     (`vacation.ts:42-48`), and the `INSERT … ON CONFLICT` at `:50-60` writes
 *     exactly those five columns.
 *
 * RFC 8621 §8.1 does define the field, so this is a server gap and not a spec
 * one — but it is not in the ledger today (sVOL `024:113-118`). A rich editor
 * over this field would send its markup, receive a success response, and lose
 * the output with no error anywhere: the write "succeeds" and the value is
 * simply never stored. `vacationPatch` therefore never emits an `htmlBody` key,
 * and `vacation.test.ts` asserts that it never does.
 */
export const VACATION_PLAIN_TEXT_ONLY =
  "Out-of-office replies are plain text. The server has no HTML body for this — " +
  "VacationResponse/get always returns null and VacationResponse/set never reads one — " +
  "so anything formatted here would be discarded without an error.";

/**
 * ⚠️ **`VacationResponse/set` does NOT honour `ifInState`, so we do not send
 * it.** sVOL `024:96-99` says both halves of this screen "honour the account
 * state string, so thread `state` into `ifInState` and get optimistic
 * concurrency for free". That is true of `Identity/set` — which compares it and
 * throws `stateMismatch` (`identity.ts:207-210`) — and false here:
 * `VacationResponse/set` (`vacation.ts:32-73`) reads `args.update` and nothing
 * else. `args.ifInState` appears nowhere in the file.
 *
 * The consequence of sending it anyway would be worse than not having it: the
 * argument is accepted and ignored, so the UI would claim a concurrency guard
 * it does not have. `packages/cli/src/main.ts:799` does exactly that today —
 * `bullmoose vacation on --if-state …` passes the argument into a method that
 * never looks at it.
 *
 * There is a second reason the guard could not work as written even if the
 * comparison existed: this method commits no `ChangeEntry`, so the account state
 * does not move when the responder changes. `oldState` and `newState` in its own
 * response are two reads of the same unchanged value (`vacation.ts:34,65`).
 */
export const VACATION_NO_OPTIMISTIC_GUARD =
  "The server does not support a concurrency check on this write. If someone changes the " +
  "responder elsewhere while this form is open, saving overwrites it without warning.";

/** What `VacationResponse/get` returns (`vacation.ts:17-27`). */
export interface VacationResponse {
  id: string;
  isEnabled: boolean;
  /** ISO-8601, or null for "no start bound". */
  fromDate: string | null;
  /** ISO-8601, or null for "no end bound". */
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
  /** ⚠️ Always null — see VACATION_PLAIN_TEXT_ONLY. Typed so it cannot be read as content. */
  htmlBody: null;
}

/** What the inputs hold. Dates are `<input type="datetime-local">` values. */
export interface VacationForm {
  isEnabled: boolean;
  subject: string;
  textBody: string;
  /** `YYYY-MM-DDTHH:mm` in the browser's local zone, or "" for unbounded. */
  fromDate: string;
  toDate: string;
}

export function vacationToForm(v: VacationResponse): VacationForm {
  return {
    isEnabled: v.isEnabled,
    subject: v.subject ?? "",
    textBody: v.textBody ?? "",
    fromDate: toLocalInput(v.fromDate),
    toDate: toLocalInput(v.toDate),
  };
}

// ── dates ─────────────────────────────────────────────────────────────────

/**
 * ISO → the value a `datetime-local` input wants, in the browser's zone.
 *
 * Local rather than UTC because the window is a human intention ("back on the
 * 15th"), and the server stores epoch milliseconds either way (`vacation.ts:46-47`).
 * Showing someone a UTC clock for a decision they made in their own is how an
 * out-of-office ends a day early.
 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export type DateParse = { ok: true; iso: string | null } | { ok: false; error: string };

/**
 * The input value → ISO, or a refusal.
 *
 * ⚠️ **The client has to be the one that rejects this.** `dateMs`
 * (`vacation.ts:97-104`) falls back to the EXISTING stored value on anything it
 * cannot parse — so an unparseable date is swallowed silently, the write
 * reports success, and the user is left looking at their old date believing the
 * new one took. sVOL `024:119-121` flags the same thing: "an invalid date in a
 * form field is swallowed, not rejected. Validate client-side or the user gets
 * no feedback."
 *
 * An empty field is not an error — it is the explicit unbound case, and `null`
 * is the value that clears the column (`vacation.ts:98`).
 *
 * Second line of defence, not the first: `<input type="datetime-local">` refuses
 * to hold an unparseable string at all, so on a browser that implements it this
 * branch is unreachable through the UI (verified by driving the built page —
 * setting `.value = "not-a-date"` leaves `""`). It still earns its place,
 * because an input whose `type` a browser does not support falls back to
 * `type=text` per the HTML spec, and then free text is exactly what arrives.
 */
export function fromLocalInput(value: string): DateParse {
  const raw = value.trim();
  if (raw === "") return { ok: true, iso: null };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `“${raw}” is not a date the server can read.` };
  }
  return { ok: true, iso: new Date(ms).toISOString() };
}

// ── the patch ─────────────────────────────────────────────────────────────

export interface VacationPatchResult {
  /** Ready for `VacationResponse/set update.singleton`. Never carries `htmlBody`. */
  patch: Record<string, unknown>;
  /** Blocking. Non-empty means do not send. */
  problems: string[];
  /** Worth saying, but the save is legitimate. */
  warnings: string[];
}

/**
 * Diff a form against the responder it was loaded from.
 *
 * A diff rather than a whole object because the server merges: `next` is built
 * field by field from the patch with the existing row as fallback
 * (`vacation.ts:42-48`), so an absent key means "leave it". `null` is different
 * from absent and means "clear it" (`str`/`dateMs`, `:94-104`) — which is why
 * an emptied date field sends an explicit `null` rather than being omitted.
 */
export function vacationPatch(
  current: VacationResponse,
  form: VacationForm,
  now: Date = new Date(),
): VacationPatchResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const patch: Record<string, unknown> = {};

  if (form.isEnabled !== current.isEnabled) patch.isEnabled = form.isEnabled;

  // "" and null are different stored values, and only one of them is what a
  // person means by clearing a field. Send null so the column is cleared
  // rather than set to an empty string that renders as a blank subject line.
  const subject = form.subject.trim() === "" ? null : form.subject.trim();
  if (subject !== (current.subject ?? null)) patch.subject = subject;

  const textBody = form.textBody.trim() === "" ? null : form.textBody;
  if (textBody !== (current.textBody ?? null)) patch.textBody = textBody;

  const from = fromLocalInput(form.fromDate);
  const to = fromLocalInput(form.toDate);
  if (!from.ok) problems.push(`Start date: ${from.error}`);
  if (!to.ok) problems.push(`End date: ${to.error}`);

  if (from.ok && !sameInstant(from.iso, current.fromDate)) patch.fromDate = from.iso;
  if (to.ok && !sameInstant(to.iso, current.toDate)) patch.toDate = to.iso;

  if (from.ok && to.ok && from.iso && to.iso && Date.parse(from.iso) > Date.parse(to.iso)) {
    // Not a warning. Delivery skips a responder whose window does not contain
    // `now` — `if (from_date !== null && now < from_date) continue` and the
    // matching `to_date` guard (`services/ingest/src/index.ts:360-361`) — so a
    // start after the end is a window no instant can satisfy. It would store
    // cleanly, report success, and never send a single reply.
    problems.push("The start is after the end, so the responder could never fire. Swap them.");
  }

  // Only worth complaining about a message when the thing is actually going to
  // send one. An empty body on a DISABLED responder is just an unfinished draft.
  if (form.isEnabled) {
    if (form.textBody.trim() === "") {
      problems.push("Write the message people will receive — an empty auto-reply is worse than none.");
    }
    if (form.subject.trim() === "") {
      warnings.push("With no subject, replies go out with an empty subject line.");
    }
    if (to.ok && to.iso && Date.parse(to.iso) < now.getTime()) {
      warnings.push("The end date has already passed, so no replies will be sent.");
    }
    if (from.ok && from.iso && Date.parse(from.iso) > now.getTime()) {
      warnings.push(`Replies start on ${new Date(from.iso).toLocaleString()}.`);
    }
  }

  return { patch, problems, warnings };
}

/** Two ISO strings for the same moment are the same value, however spelled. */
function sameInstant(next: string | null, prev: string | null): boolean {
  if (next === null || prev === null) return next === prev;
  return Date.parse(next) === Date.parse(prev);
}

// ── what it is doing right now ────────────────────────────────────────────

export type VacationActivity = "off" | "active" | "scheduled" | "ended";

export interface VacationStatus {
  activity: VacationActivity;
  /** One sentence for the screen. */
  summary: string;
}

/**
 * What the responder will do to the next message that arrives.
 *
 * Computed from the SAME three facts delivery uses — `enabled`, `from_date`,
 * `to_date` (`services/ingest/src/index.ts:346-362`) — rather than from
 * `isEnabled` alone. A checkbox that says "on" above a window that ended last
 * month is a UI telling the truth about the wrong thing.
 *
 * It deliberately does not model the RFC 3834 gate or the 7-day per-sender
 * suppression (`suppress_seconds` at `vacation.ts:53`). Those decide whether a
 * PARTICULAR message gets a reply; this answers whether the responder is armed
 * at all, which is the question the settings screen is for.
 */
export function vacationStatus(v: VacationResponse, now: Date = new Date()): VacationStatus {
  if (!v.isEnabled) return { activity: "off", summary: "Off. Incoming mail gets no automatic reply." };

  const t = now.getTime();
  const from = v.fromDate ? Date.parse(v.fromDate) : null;
  const to = v.toDate ? Date.parse(v.toDate) : null;

  if (from !== null && Number.isFinite(from) && t < from) {
    return {
      activity: "scheduled",
      summary: `Scheduled — replies start ${new Date(from).toLocaleString()}.`,
    };
  }
  if (to !== null && Number.isFinite(to) && t > to) {
    return {
      activity: "ended",
      summary: `The window ended ${new Date(to).toLocaleString()}, so no replies are being sent.`,
    };
  }
  return {
    activity: "active",
    summary:
      to !== null && Number.isFinite(to)
        ? `Replying now, until ${new Date(to).toLocaleString()}.`
        : "Replying now, with no end date set.",
  };
}

// ── talking to the server ─────────────────────────────────────────────────

/**
 * `VacationResponse/get`. The list is always exactly one row, present or not —
 * the server builds it from a possibly-missing `responders` row and reports the
 * singleton regardless (`vacation.ts:13-29`), so there is no not-found case.
 */
export async function loadVacation(
  client: JmapClient,
  accountId: string,
): Promise<VacationResponse> {
  const result = await client.requestOne("VacationResponse/get", { accountId, ids: null });
  const row = (result.list as VacationResponse[] | undefined)?.[0];
  return {
    id: row?.id ?? "singleton",
    isEnabled: row?.isEnabled === true,
    fromDate: row?.fromDate ?? null,
    toDate: row?.toDate ?? null,
    subject: row?.subject ?? null,
    textBody: row?.textBody ?? null,
    htmlBody: null,
  };
}

export type VacationSaveOutcome =
  | { ok: true; noop: boolean }
  | { ok: false; kind: "forbidden" | "invalid" | "error"; message: string };

/**
 * One `VacationResponse/set`, keyed on the literal `singleton`.
 *
 * No `ifInState` — see VACATION_NO_OPTIMISTIC_GUARD. There is also no
 * `notUpdated` branch to handle: the method has no per-id failure path, it
 * upserts and returns `updated: { singleton: null }` unconditionally
 * (`vacation.ts:68`). Anything that goes wrong arrives as a method-level error.
 */
export async function saveVacation(
  client: JmapClient,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<VacationSaveOutcome> {
  if (Object.keys(patch).length === 0) return { ok: true, noop: true };

  const [response] = await client.request([
    ["VacationResponse/set", { accountId, update: { singleton: patch } }, "v0"],
  ]);
  if (!response) return { ok: false, kind: "error", message: "VacationResponse/set returned nothing." };

  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    if (detail.type === "forbidden") {
      return {
        ok: false,
        kind: "forbidden",
        // `requireAccount(ctx, args, "draft")` (`vacation.ts:33`) — the same
        // scope `Identity/set update` charges, so the two halves of this screen
        // fail together rather than one silently working.
        message:
          "This session is not allowed to change the responder. It needs the “draft” permission.",
      };
    }
    return {
      ok: false,
      kind: detail.type === "invalidArguments" ? "invalid" : "error",
      message: detail.description || `The server refused: ${detail.type ?? "unknown error"}.`,
    };
  }
  return { ok: true, noop: false };
}
