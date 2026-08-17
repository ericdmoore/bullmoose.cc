import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { AccountAccess } from "../auth";
import type { EmailAddress, IdentityColumns, IdentityRow, Mailstore } from "@bullmoose/mailstore";
import {
  accountState,
  proxyChanges,
  requireAccount,
  requireAccountScopes,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * The id `Identity/get` synthesizes when the table is empty.
 *
 * Named rather than inlined because `Identity/set` MATERIALISES it — a real
 * row is written under this exact id — and the two only stay compatible if
 * there is one spelling of it in the tree.
 */
export const SYNTHETIC_IDENTITY_ID = "identity_default";

/**
 * Properties the server owns. A client that sends one is told so rather than
 * having it silently dropped. `email` is here for UPDATE only (RFC 8621 §6.3
 * makes it immutable, and it is half of `UNIQUE (account_id, email)`); it is
 * settable — required, in fact — on create.
 */
const IDENTITY_SERVER_SET = ["id", "mayDelete"] as const;

const IDENTITY_WRITABLE = ["name", "replyTo", "bcc", "textSignature", "htmlSignature"] as const;

/**
 * The account's sending identities — the single authoritative answer to
 * "which addresses may this account send as", shared by `Identity/get`,
 * `Identity/set` and `EmailSubmission/set` so the three cannot drift.
 *
 * Until provisioning seeds the identities table, synthesize one from the
 * principal so sending works out of the box for the dev account — but
 * **only when the table is empty**. On a provisioned account the rows are
 * authoritative; offering `identity_default` alongside them would smuggle
 * the *login* email in as a sender, and on a grant-reached account that
 * login email belongs to a different person entirely.
 */
export async function resolveIdentities(
  ctx: RequestContext,
  access: AccountAccess,
  store: Mailstore,
): Promise<IdentityRow[]> {
  return (await resolveIdentitySet(ctx, access, store)).identities;
}

/**
 * `resolveIdentities` plus the one fact `/set` needs and the readers do not:
 * whether the list was READ or SYNTHESIZED.
 *
 * A sibling of `resolveIdentities` rather than a second implementation of it.
 * `.feedback/fromCodex/002` was exactly this logic being forked — `submitOne`
 * accepted `identity_default` unconditionally while `Identity/get` only
 * offered it on an empty table, so a client could send as its *login* email
 * on a provisioned account. Every consumer therefore goes through this one
 * function; `resolveIdentities` is a projection of it, not a copy.
 */
export async function resolveIdentitySet(
  ctx: RequestContext,
  access: AccountAccess,
  store: Mailstore,
): Promise<{ identities: IdentityRow[]; synthesized: boolean }> {
  const rows = await store.getIdentities(access.accountId);
  if (rows.length > 0) return { identities: rows, synthesized: false };
  return {
    identities: [
      {
        id: SYNTHETIC_IDENTITY_ID,
        email: ctx.principal.username,
        name: access.name,
        replyTo: null,
        bcc: null,
        textSignature: "",
        htmlSignature: "",
        // The synthesized default is the only address the account has. It is
        // not deletable, and materialising it preserves that.
        mayDelete: false,
      },
    ],
    synthesized: true,
  };
}

function identityToJmap(row: IdentityRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    replyTo: row.replyTo,
    bcc: row.bcc,
    textSignature: row.textSignature,
    htmlSignature: row.htmlSignature,
    mayDelete: row.mayDelete,
  };
}

/**
 * Per-operation scope charging, the house style of `requiredScopesForEmailSet`
 * (`email.ts`) and `requiredScopesForMailboxSet` (`mailbox.ts`).
 *
 * ⚠️ `hasScope` is a FLAT SET, not an ordered lattice
 * (`.feedback/fromClaude/common/027`): `send` does not imply `draft`, and no
 * write verb implies another (the one implication is that every write implies
 * `read`, which is irrelevant to charging a write). So these are three
 * independent demands, each picked on its own merits, not on a chain position.
 *
 *  create  → `send`. A new row is a new address `EmailSubmission/set` will
 *            accept in `From:` — `submitOne` resolves against exactly this
 *            table. Widening what the account may send as is a send-capability
 *            change, whatever else the create also sets.
 *  update  → `draft`. Signature, replyTo, bcc and name are composition-time
 *            hints (RFC 8621 §6.1 — "a signature the client SHOULD insert"),
 *            which is what `VacationResponse/set` — the repo's other settings
 *            writer — already charges `draft` for (`vacation.ts`). Note this
 *            deliberately does NOT let a `send`-only token edit a signature,
 *            and does not let a `draft`-only token mint a sender.
 *  destroy → `delete`, matching `Mailbox/set`.
 */
export function requiredScopesForIdentitySet(args: Record<string, unknown>): string[] {
  const need = new Set<string>();
  const create = args.create as Record<string, unknown> | undefined;
  const update = args.update as Record<string, unknown> | undefined;
  const destroy = args.destroy as string[] | undefined;

  if (create && Object.keys(create).length > 0) need.add("send");
  if (update && Object.keys(update).length > 0) need.add("draft");
  if (destroy && destroy.length > 0) need.add("delete");
  return [...need];
}

export function registerIdentityMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Identity/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const store = storeFor(ctx);

    const identities = await resolveIdentities(ctx, access, store);

    const requested = args.ids === null || args.ids === undefined ? null : (args.ids as string[]);
    const list = identities.filter((i) => requested === null || requested.includes(i.id)).map(identityToJmap);
    const found = new Set(list.map((i) => i.id));

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (requested ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Identity/set", identitySet);

  /**
   * RFC 8621 §6.2.
   *
   * Deliberately NOT the `Thread/changes` trap sVOL 027 documents: there the
   * collection string was already in `proxyChanges`' union while nothing ever
   * committed a Thread entry, so registering the method would have returned an
   * eternally empty delta — worse than `unknownMethod`, because a client
   * cannot tell "no changes" from "not implemented". Here the producer ships
   * in the same commit as the consumer: `identitySet` commits an `Identity`
   * entry for every write, so this reports real ids from its first call.
   */
  registry.register("Identity/changes", async (args, ctx) => proxyChanges(ctx, args, "Identity"));
}

/**
 * RFC 8621 §6.3 Identity/set.
 *
 * Before this, signatures and send-as were unreachable on every surface: the
 * table had four columns, `Identity/get` hardcoded `replyTo`/`bcc`/both
 * signatures, and no code path in the repository wrote an identity row after
 * account creation.
 */
async function identitySet(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccountScopes(ctx, args, requiredScopesForIdentitySet(args));
  if (access.granted) {
    // Same refusal as Mailbox/set, AddressBook/set and Calendar/set: a sharee
    // acts on CONTENTS, never on the container. Sharper here — the synthesized
    // fallback below is built from `ctx.principal.username`, and on a
    // grant-reached account that login email belongs to a different person, so
    // letting a sharee materialise it would persist THEIR address as a sender
    // for someone else's account (the shape of .feedback/fromCodex/002).
    throw new MethodError("forbidden", "only the account owner manages identities");
  }
  const store = storeFor(ctx);

  const oldState = await accountState(ctx, access.accountId);
  if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const created: Record<string, Record<string, unknown>> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  const entry: ChangeEntry = { collection: "Identity", created: [], updated: [], destroyed: [] };

  const resolved = await resolveIdentitySet(ctx, access, store);
  const byId = new Map(resolved.identities.map((r) => [r.id, r]));
  /** The synthesized default has not been written yet — see materialise(). */
  let pendingSynthetic = resolved.synthesized;

  /**
   * Turn the synthesized default into a real row, keeping its id and email.
   *
   * The moment ANY row exists, `resolveIdentitySet` stops synthesizing — so
   * an account whose table is empty would lose its only sender the instant a
   * second identity was created, and `EmailSubmission/set` (which resolves
   * through the same function) would start refusing `identity_default`. Every
   * write path therefore materialises first.
   *
   * It preserves rather than widens: the email written is exactly the one
   * `Identity/get` and `submitOne` already offered, which is why the
   * active-domain check that guards `create` is deliberately not applied here
   * — enforcing it would break the dev account, whose login domain is not in
   * `domains`, and would refuse a capability the account demonstrably already
   * has.
   */
  const materialise = async (): Promise<void> => {
    if (!pendingSynthetic) return;
    const row = byId.get(SYNTHETIC_IDENTITY_ID)!;
    await store.insertIdentity(access.accountId, {
      id: row.id,
      email: row.email,
      name: row.name,
      may_delete: 0,
    });
    pendingSynthetic = false;
  };

  // -- create --
  const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(createSpecs)) {
    try {
      const row = await validateNewIdentity(spec, access, store);
      await materialise();
      await store.insertIdentity(access.accountId, row);
      byId.set(row.id, {
        id: row.id,
        email: row.email,
        name: row.name,
        replyTo: row.reply_to_json ? (JSON.parse(row.reply_to_json) as EmailAddress[]) : null,
        bcc: row.bcc_json ? (JSON.parse(row.bcc_json) as EmailAddress[]) : null,
        textSignature: row.text_signature ?? "",
        htmlSignature: row.html_signature ?? "",
        mayDelete: true,
      });
      entry.created.push(row.id);
      // RFC 8620 §5.3: echo every property the server set.
      created[cid] = { id: row.id, mayDelete: true };
    } catch (err) {
      notCreated[cid] = toSetError(err);
    }
  }

  // -- update --
  const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, patch] of Object.entries(updateSpecs)) {
    try {
      const row = byId.get(id);
      if (!row) throw new NotFound();
      const columns = validateIdentityPatch(patch);
      // A patch against the synthesized default writes the row first, then
      // updates it. Reported as `updated`, not `created`, because that is what
      // the client asked for and what every client that already saw
      // `identity_default` from Identity/get will expect from Identity/changes.
      await materialise();
      await store.updateIdentity(access.accountId, id, columns);
      byId.set(id, applyColumns(row, columns));
      entry.updated.push(id);
      updated[id] = null;
    } catch (err) {
      notUpdated[id] = toSetError(err);
    }
  }

  // -- destroy --
  for (const id of (args.destroy as string[] | undefined) ?? []) {
    try {
      const row = byId.get(id);
      if (!row) throw new NotFound();
      if (!row.mayDelete) {
        // Identity/get has always advertised mayDelete; enforcing it here is
        // what makes the claim true. The provisioned primary is the address
        // EmailSubmission/set resolves against — destroying it would leave the
        // account unable to send, or (worse) fall back to synthesizing the
        // LOGIN email as a sender.
        throw new SetErrorSignal("forbidden", `identity ${id} is the account's primary and cannot be destroyed`);
      }
      await store.deleteIdentity(access.accountId, id);
      byId.delete(id);
      entry.destroyed.push(id);
      destroyed.push(id);
    } catch (err) {
      notDestroyed[id] = toSetError(err);
    }
  }

  const newState = await commitIdentityEntry(ctx, access.accountId, entry);
  return {
    accountId: access.accountId,
    oldState,
    newState,
    created,
    notCreated,
    updated,
    notUpdated,
    destroyed,
    notDestroyed,
  };
}

/**
 * The step that fails silently if skipped (`_context.md` §3).
 *
 * `Identity/get` reports the ACCOUNT state, so a row written straight to D1
 * without this reads back correctly on a direct get and leaves every
 * state-caching client showing the old signature forever. That presents as a
 * sync bug and is a write-path bug. Skips the DO round-trip when nothing
 * changed, like `commitMailboxEntries` — a no-op /set should not burn a state
 * bump.
 */
async function commitIdentityEntry(ctx: RequestContext, accountId: string, entry: ChangeEntry): Promise<string> {
  if (entry.created.length + entry.updated.length + entry.destroyed.length === 0) {
    return accountState(ctx, accountId);
  }
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, [entry]);
  return newState;
}

// ---- validation ------------------------------------------------------

class NotFound extends Error {}

class SetErrorSignal extends Error {
  constructor(
    public type: string,
    public description?: string,
    public properties?: string[],
  ) {
    super(description ?? type);
  }
}

function toSetError(err: unknown): SetError {
  if (err instanceof NotFound) return setError("notFound");
  if (err instanceof SetErrorSignal) {
    return {
      type: err.type,
      ...(err.description ? { description: err.description } : {}),
      ...(err.properties ? { properties: err.properties } : {}),
    };
  }
  // UNIQUE (account_id, email) is enforced by the index, so an address that
  // collides between the read above and the INSERT arrives as a raw D1
  // exception. It is a bad property, not a server fault — same trap as
  // Mailbox/set's mailboxes_role index.
  if (/UNIQUE constraint/i.test(String(err))) {
    return {
      type: "invalidProperties",
      description: "an identity with that email already exists",
      properties: ["email"],
    };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

function invalid(description: string, properties?: string[]): never {
  throw new SetErrorSignal("invalidProperties", description, properties);
}

/** RFC 8621 EmailAddress[]: `[{name?, email}]`, or null for "unset". */
function addressListJson(value: unknown, property: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) invalid(`${property} must be an array of EmailAddress or null`, [property]);
  const out: EmailAddress[] = [];
  for (const item of value as unknown[]) {
    const addr = item as { email?: unknown; name?: unknown } | null;
    if (!addr || typeof addr.email !== "string" || !isEmail(addr.email)) {
      invalid(`${property} entries need a valid "email"`, [property]);
    }
    out.push({
      email: addr.email as string,
      ...(typeof addr.name === "string" ? { name: addr.name } : {}),
    });
  }
  return JSON.stringify(out);
}

function isEmail(value: string): boolean {
  // Deliberately loose: exactly one @, a non-empty localpart, and a domain
  // with a dot. Rejecting more than that is how a mail system refuses
  // addresses that work.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

function str(value: unknown, property: string): string {
  if (typeof value !== "string") invalid(`${property} must be a string`, [property]);
  return value;
}

function rejectServerSet(spec: Record<string, unknown>): void {
  const offending = IDENTITY_SERVER_SET.filter((p) => p in spec);
  if (offending.length > 0) {
    invalid(`${offending.join(", ")} ${offending.length > 1 ? "are" : "is"} set by the server`, [...offending]);
  }
}

async function validateNewIdentity(
  spec: Record<string, unknown>,
  access: AccountAccess,
  store: Mailstore,
): Promise<{ id: string; email: string; name: string } & IdentityColumns> {
  rejectServerSet(spec);
  const unknown = Object.keys(spec).filter(
    (k) => k !== "email" && !(IDENTITY_WRITABLE as readonly string[]).includes(k),
  );
  if (unknown.length > 0) invalid(`unknown properties: ${unknown.join(", ")}`, unknown);

  const email = str(spec.email ?? "", "email")
    .trim()
    .toLowerCase();
  if (!isEmail(email)) invalid("email is required and must be an address", ["email"]);

  // The DDL has said "must be on an active domain" since day one and nothing
  // enforced it. Without this, Identity/set is a self-service spoofing surface:
  // any token holding `send` could add ceo@yourbank.com as a From address. SES
  // would refuse to relay it, so the blast radius is a confusing failure rather
  // than delivered spoofed mail — but relying on a downstream provider to be
  // the only gate is not a gate.
  const domain = email.slice(email.indexOf("@") + 1);
  if (!(await store.isActiveDomain(access.tenantId, domain))) {
    invalid(`${domain} is not an active domain for this tenant`, ["email"]);
  }

  return {
    id: `identity_${crypto.randomUUID().slice(0, 8)}`,
    email,
    name: spec.name === undefined ? "" : str(spec.name, "name"),
    reply_to_json: addressListJson(spec.replyTo, "replyTo"),
    bcc_json: addressListJson(spec.bcc, "bcc"),
    text_signature: spec.textSignature === undefined ? "" : str(spec.textSignature, "textSignature"),
    html_signature: spec.htmlSignature === undefined ? "" : str(spec.htmlSignature, "htmlSignature"),
    may_delete: 1,
  };
}

function validateIdentityPatch(patch: Record<string, unknown>): IdentityColumns {
  rejectServerSet(patch);
  if ("email" in patch) {
    // RFC 8621 §6.3 makes email immutable, and here it is also half of
    // UNIQUE (account_id, email) — an "update" would be a delete plus a create
    // that skipped the active-domain check.
    invalid("email is immutable; destroy the identity and create another", ["email"]);
  }
  const unknown = Object.keys(patch).filter((k) => !(IDENTITY_WRITABLE as readonly string[]).includes(k));
  if (unknown.length > 0) invalid(`unknown properties: ${unknown.join(", ")}`, unknown);

  const columns: IdentityColumns = {};
  if ("name" in patch) columns.name = str(patch.name, "name");
  if ("replyTo" in patch) columns.reply_to_json = addressListJson(patch.replyTo, "replyTo");
  if ("bcc" in patch) columns.bcc_json = addressListJson(patch.bcc, "bcc");
  if ("textSignature" in patch) columns.text_signature = str(patch.textSignature, "textSignature");
  if ("htmlSignature" in patch) columns.html_signature = str(patch.htmlSignature, "htmlSignature");
  // Nothing to write is not an error — RFC 8620 §5.3 permits an empty patch,
  // and `updateIdentity` no-ops on it. The row still reports as updated so a
  // client's read-modify-write loop sees a consistent state bump.
  return columns;
}

function applyColumns(row: IdentityRow, columns: IdentityColumns): IdentityRow {
  return {
    ...row,
    ...(columns.name !== undefined ? { name: columns.name } : {}),
    ...(columns.reply_to_json !== undefined
      ? {
          replyTo: columns.reply_to_json === null ? null : (JSON.parse(columns.reply_to_json) as EmailAddress[]),
        }
      : {}),
    ...(columns.bcc_json !== undefined
      ? { bcc: columns.bcc_json === null ? null : (JSON.parse(columns.bcc_json) as EmailAddress[]) }
      : {}),
    ...(columns.text_signature !== undefined ? { textSignature: columns.text_signature } : {}),
    ...(columns.html_signature !== undefined ? { htmlSignature: columns.html_signature } : {}),
  };
}
