// Identity settings — "who I am when I send" (sVOL `024`, s07 T2).
//
// The load-bearing fact about this screen is that `Identity/get` does not
// always describe a STORED row. When the `identities` table is empty the server
// SYNTHESIZES one from the principal (`services/jmap/src/methods/identity.ts:78-95`):
// `id: "identity_default"`, `email: ctx.principal.username`, `name: access.name`,
// and null/empty for the rest. sVOL `024:72-76` reads that as "every response
// hardcodes replyTo / bcc / both signatures, so they can never be edited" —
// which was true before `006` and is not true now. The difference cuts in two
// directions and both matter to a form:
//
//   • **The five writable properties round-trip even on the synthetic identity.**
//     `Identity/set` MATERIALISES it: the first patch writes a real row under
//     the same id (`identity.ts:242-252`) and then applies the patch. So the
//     form may accept input for all five, and the field-note below says the row
//     does not exist yet rather than pretending the edit is impossible.
//   • **`email` genuinely cannot round-trip.** `validateIdentityPatch` refuses
//     it outright (`identity.ts:478-483` — RFC 8621 §6.3 immutability, and it is
//     half of `UNIQUE (account_id, email)`). It is rendered read-only with the
//     reason rather than accepting a change that would be thrown away.
//   • **`id` and `mayDelete` are server-set, and naming them is fatal to the
//     whole patch.** `rejectServerSet` (`identity.ts:430-437`) fails the entire
//     update if either appears. That is why `identityPatch` emits a DIFF of
//     writable properties and never echoes the object it was handed back at the
//     server — the obvious `{...identity, name}` shape is refused every time.
//
// Everything here is pure except the two functions at the bottom that take a
// `JmapClient`; vitest runs `environment: "node"` with no DOM, so the rules live
// here and `components/SettingsPanel.tsx` stays a renderer.

import type { JmapClient } from "../jmap/JmapClient";
// Reused rather than reimplemented: the composer already parses a human's
// comma-separated recipient input, and Reply-To / Bcc take exactly the same
// input. A second parser here would be a second set of quoting bugs.
import { parseAddressList } from "../mail/compose";
import { formatAddress, type EmailAddress, type Identity } from "../mail/types";

/**
 * The properties `Identity/set update` accepts — the exact `IDENTITY_WRITABLE`
 * list at `services/jmap/src/methods/identity.ts:33-39`.
 *
 * A MIRROR, not the source of truth, for the reason `lib/mail/triage.ts:71-77`
 * records: the server is Worker code that cannot be imported into a DOM bundle.
 * Drift here shows up as a refused save with the offending property named, which
 * is ugly but not silent.
 */
export const IDENTITY_WRITABLE = [
  "name",
  "replyTo",
  "bcc",
  "textSignature",
  "htmlSignature",
] as const;

export type IdentityWritable = (typeof IDENTITY_WRITABLE)[number];

/**
 * The id `Identity/get` synthesizes when the table is empty
 * (`identity.ts:23`). Named here for the same reason it is named there — the
 * two only stay compatible with one spelling of it.
 */
export const SYNTHETIC_IDENTITY_ID = "identity_default";

// ── what the UI is allowed to offer ───────────────────────────────────────

export type FieldStatus =
  /** Round-trips: type into it, `Identity/set` stores it, `Identity/get` reads it back. */
  | "writable"
  /** The server refuses a change. Render it, do not accept input for it. */
  | "immutable"
  /** The server owns the value and refuses a patch that even mentions it. */
  | "server-set";

export interface IdentityFieldNote {
  property: string;
  status: FieldStatus;
  /** Shown next to the field when the status is not `writable`. */
  note: string;
}

/**
 * Every property `Identity/get` returns, and whether a person may edit it.
 *
 * This exists so the failure mode sVOL `024` warns about — a settings screen
 * that lets someone "edit" a field the server discards — is a data question
 * with one answer, not a judgement call spread across JSX.
 */
export const IDENTITY_FIELD_NOTES: readonly IdentityFieldNote[] = [
  {
    property: "id",
    status: "server-set",
    note: "The server assigns identity ids; a patch that mentions one is refused entirely.",
  },
  {
    property: "email",
    status: "immutable",
    note:
      "The sending address cannot be changed. RFC 8621 §6.3 makes it immutable, and here it is " +
      "also half of the (account, email) uniqueness key — an “update” would be a delete plus a " +
      "create that skipped the active-domain check. Add a second identity instead.",
  },
  { property: "name", status: "writable", note: "" },
  { property: "replyTo", status: "writable", note: "" },
  { property: "bcc", status: "writable", note: "" },
  { property: "textSignature", status: "writable", note: "" },
  {
    property: "htmlSignature",
    status: "writable",
    // Worth stating positively, because the sibling field on the OTHER half of
    // this screen looks identical and is not stored at all — see
    // `vacation.ts` VACATION_PLAIN_TEXT_ONLY. Confusing the two is the exact
    // shape of the bug s07 T2 was told to avoid.
    note: "",
  },
  {
    property: "mayDelete",
    status: "server-set",
    note: "Whether this identity can be destroyed is the server's answer, not a setting.",
  },
];

export function identityFieldNote(property: string): IdentityFieldNote | undefined {
  return IDENTITY_FIELD_NOTES.find((f) => f.property === property);
}

/**
 * Has this identity actually been written, or is it the synthesized default?
 *
 * Not cosmetic. Until a first write lands there is no row: `Identity/changes`
 * has never reported it, the CLI's `identity list` shows the same synthetic
 * placeholder, and `bullmoose send` picks it up from the same fallback. Saying
 * so is the difference between "your signature is empty" and "you have not set
 * one up yet".
 */
export function isSynthetic(identity: Pick<Identity, "id">): boolean {
  return identity.id === SYNTHETIC_IDENTITY_ID;
}

export interface DeleteVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * May this identity be destroyed?
 *
 * `Identity/set destroy` refuses when `mayDelete` is false (`identity.ts:305-312`),
 * and `may_delete` is 0 for every identity that predates the
 * `identities-jmap-properties` migration — its `up` ends with a blanket
 * `UPDATE identities SET may_delete = 0` (`infra/migrations.mjs:143-148`),
 * because those rows were provisioned by the platform. On a typical account
 * that means the primary is undeletable and the answer here is "no", so the UI
 * must not render a delete button it knows will be refused.
 */
export function deleteVerdict(identity: Pick<Identity, "mayDelete">): DeleteVerdict {
  if (identity.mayDelete) {
    return {
      allowed: true,
      reason: "This identity was added after provisioning and can be removed.",
    };
  }
  return {
    allowed: false,
    reason:
      "This is the account's primary sending address and the server will not destroy it — " +
      "removing it would leave the account unable to send.",
  };
}

// ── the form ──────────────────────────────────────────────────────────────

/** What the inputs hold: strings, exactly as typed. */
export interface IdentityForm {
  name: string;
  /** Comma-separated addresses, the same input shape as a To: field. */
  replyTo: string;
  bcc: string;
  textSignature: string;
  htmlSignature: string;
}

export function identityToForm(identity: Identity): IdentityForm {
  return {
    name: identity.name ?? "",
    replyTo: formatAddressList(identity.replyTo),
    bcc: formatAddressList(identity.bcc),
    textSignature: identity.textSignature ?? "",
    htmlSignature: identity.htmlSignature ?? "",
  };
}

function formatAddressList(list: EmailAddress[] | null): string {
  return (list ?? []).map(formatAddress).join(", ");
}

/**
 * MIRROR of the server's address check (`identity.ts:418-423`), including its
 * looseness — exactly one `@`, a non-empty localpart, a dotted domain. Copying
 * the loose version rather than tightening it is deliberate: "rejecting more
 * than that is how a mail system refuses addresses that work", and a client
 * stricter than its server refuses addresses the server would have taken.
 */
const SERVER_EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface IdentityPatchResult {
  /** Ready for `Identity/set update` — writable properties only, diffed. */
  patch: Record<string, unknown>;
  /** Blocking. Non-empty means do not send. */
  problems: string[];
  /** Which properties the patch actually carries. */
  changed: IdentityWritable[];
}

/**
 * Diff a form against the identity it was loaded from.
 *
 * A DIFF and not a snapshot, for the reason in the header: a patch carrying
 * `id` or `mayDelete` is refused wholesale by `rejectServerSet`, and `email`
 * is refused by name. Sending only what changed also makes a no-op save a
 * genuine no-op — `commitIdentityEntry` (`identity.ts:346-356`) skips the
 * Durable Object round trip and does not burn a state bump on an empty write,
 * so an empty patch here means the state string the next save guards on stays
 * valid.
 */
export function identityPatch(original: Identity, form: IdentityForm): IdentityPatchResult {
  const problems: string[] = [];
  const patch: Record<string, unknown> = {};
  const changed: IdentityWritable[] = [];

  const name = form.name.trim();
  if (name !== (original.name ?? "")) {
    patch.name = name;
    changed.push("name");
  }

  for (const property of ["replyTo", "bcc"] as const) {
    const parsed = parseAddresses(form[property], property, problems);
    if (parsed === undefined) continue;
    if (!sameAddresses(parsed, original[property])) {
      patch[property] = parsed;
      changed.push(property);
    }
  }

  for (const property of ["textSignature", "htmlSignature"] as const) {
    // Signatures are NOT trimmed. A trailing newline is part of a signature,
    // and `""` is meaningful: `Identity/set` writes it and `Identity/get` reads
    // it back as cleared rather than absent (`identity.test.ts:273`).
    if (form[property] !== (original[property] ?? "")) {
      patch[property] = form[property];
      changed.push(property);
    }
  }

  return { patch, problems, changed };
}

/**
 * Parse one address field. Returns `null` for an empty field — RFC 8621's
 * "unset", which the server stores as a NULL column
 * (`addressListJson`, `identity.ts:401-403`) — or `undefined` when the input
 * was bad, so the caller knows not to diff against garbage.
 */
function parseAddresses(
  raw: string,
  property: "replyTo" | "bcc",
  problems: string[],
): EmailAddress[] | null | undefined {
  if (raw.trim() === "") return null;
  const parsed = parseAddressList(raw);
  const bad = parsed.filter((a) => !SERVER_EMAIL.test(a.email.trim()));
  if (bad.length > 0) {
    problems.push(
      `${property === "replyTo" ? "Reply-To" : "Bcc"}: ${bad
        .map((a) => `“${a.email}”`)
        .join(", ")} ${bad.length > 1 ? "are not addresses" : "is not an address"}.`,
    );
    return undefined;
  }
  return parsed.map((a) => ({ name: a.name, email: a.email.trim() }));
}

/** Order-sensitive, because the server stores and returns the array as given. */
function sameAddresses(next: EmailAddress[] | null, prev: EmailAddress[] | null): boolean {
  const a = next ?? [];
  const b = prev ?? [];
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as EmailAddress;
    // The server drops a non-string `name` rather than storing null
    // (`identity.ts:410-413`), so `{name: null}` and an absent name are the
    // same stored value and must compare equal or every save re-sends.
    return x.email === y.email && (x.name ?? "") === (y.name ?? "");
  });
}

// ── talking to the server ─────────────────────────────────────────────────

export interface IdentitySettings {
  identities: Identity[];
  /** The account state string, for `ifInState` on the next write. */
  state: string;
}

/**
 * `Identity/get` plus the state string.
 *
 * Deliberately NOT `lib/mail/compose.ts`'s `loadIdentities`, which discards
 * `state`: a composer only reads, so it has nothing to guard. A settings screen
 * writes, so the state is half of what it came for.
 */
export async function loadIdentitySettings(
  client: JmapClient,
  accountId: string,
): Promise<IdentitySettings> {
  const result = await client.requestOne("Identity/get", { accountId, ids: null });
  return {
    identities: (result.list as Identity[] | undefined) ?? [],
    state: typeof result.state === "string" ? result.state : "",
  };
}

export type SaveOutcome =
  | { ok: true; newState: string; noop: boolean }
  | {
      ok: false;
      kind: "stale" | "forbidden" | "invalid" | "error";
      message: string;
      /** Properties the server named, when it named any. */
      properties?: string[];
    };

/**
 * One `Identity/set update`, guarded by `ifInState`.
 *
 * `Identity/set` DOES honour it — `identity.ts:207-210` compares it to the
 * account state and throws `stateMismatch` before writing anything, which
 * `identity.test.ts:222` holds ("refuses the whole call on a stale ifInState,
 * writing nothing"). So a form loaded ten minutes ago cannot silently clobber a
 * signature the CLI set in the meantime. Contrast `saveVacation`, where the
 * server ignores the argument and we therefore do not send it.
 *
 * Two failure shapes, kept apart because they mean different things: a
 * method-level `error` refused the whole call (stale state, missing `draft`
 * scope, a sharee touching a container), while `notUpdated[id]` means the call
 * ran and this identity's patch was bad.
 */
export async function saveIdentity(
  client: JmapClient,
  accountId: string,
  id: string,
  patch: Record<string, unknown>,
  opts: { ifInState?: string } = {},
): Promise<SaveOutcome> {
  if (Object.keys(patch).length === 0) {
    return { ok: true, newState: opts.ifInState ?? "", noop: true };
  }

  const args: Record<string, unknown> = { accountId, update: { [id]: patch } };
  if (opts.ifInState) args.ifInState = opts.ifInState;

  const [response] = await client.request([["Identity/set", args, "i0"]]);
  if (!response) return { ok: false, kind: "error", message: "Identity/set returned nothing." };

  if (response[0] === "error") {
    return describeIdentityRefusal(response[1] as { type?: string; description?: string });
  }

  const result = response[1] as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: string; description?: string; properties?: string[] }>;
    newState?: string;
  };
  const failed = result.notUpdated?.[id];
  if (failed) {
    return {
      ok: false,
      kind: failed.type === "forbidden" ? "forbidden" : "invalid",
      message: failed.description ?? `The server refused the change: ${failed.type ?? "unknown"}.`,
      ...(failed.properties ? { properties: failed.properties } : {}),
    };
  }
  if (!(id in (result.updated ?? {}))) {
    return {
      ok: false,
      kind: "error",
      message: "The server neither applied nor refused the change.",
    };
  }
  return { ok: true, newState: result.newState ?? "", noop: false };
}

/** Turn a method-level error into a sentence naming what to do about it. */
export function describeIdentityRefusal(detail: {
  type?: string;
  description?: string;
}): Extract<SaveOutcome, { ok: false }> {
  switch (detail.type) {
    case "stateMismatch":
      return {
        ok: false,
        kind: "stale",
        message:
          "These settings changed somewhere else while this form was open — nothing was written. " +
          "Reload to see the current values, then make the change again.",
      };
    case "forbidden":
      return {
        ok: false,
        kind: "forbidden",
        // Two different refusals share this type and both are worth naming: an
        // update charges the `draft` scope (`requiredScopesForIdentitySet`,
        // identity.ts:133-143), and a grant-reached account refuses outright —
        // "only the account owner manages identities" (identity.ts:203).
        message:
          detail.description ??
          "This session is not allowed to change identities. Editing one needs the “draft” " +
            "permission, and an account reached through a grant cannot manage identities at all.",
      };
    default:
      return {
        ok: false,
        kind: "error",
        message: detail.description || `The server refused: ${detail.type ?? "unknown error"}.`,
      };
  }
}
