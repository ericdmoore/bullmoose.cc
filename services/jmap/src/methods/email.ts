import PostalMime, { addressParser, decodeWords, type Address, type HeaderLine } from "postal-mime";
import { MAX_ATTACHMENT_BYTES_PER_EMAIL, MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import { buildMime, type MimeAttachment } from "@bullmoose/mime";
import {
  htmlToIndexText,
  normalizeMessageId,
  previewText,
  type AttachmentMeta,
  type EmailAddress,
  type EmailFilter,
  type EmailRow,
  type EmailSort,
  type Mailstore,
} from "@bullmoose/mailstore";
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
import { partBlobId } from "../blobParts";
import {
  appendSidestepBlock,
  applyOutboundSidestep,
  planOutboundSidestep,
  type AppliedSidestep,
  type PlannedSidestep,
} from "./outboundSidestep";

/** Metadata properties served straight from D1 — no blob fetch, no MIME parse. */
const ROW_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "attachments",
];

/**
 * Properties that can only be served by fetching the raw blob and parsing it
 * (RFC 8621 §4.1.2–§4.1.4). Requesting ANY of these costs one R2 read plus a
 * MIME parse per message — same price `bodyValues` always paid; `replyTo`,
 * `sender`, `references` and `headers` simply were not served at all before,
 * and a client that asked got SILENCE (the bug that made phone replies go to
 * `From` when Reply-To differed). `header:*` forms are parsed too and are
 * validated separately in `parseProperties`.
 */
const PARSED_PROPERTIES = new Set([
  "bodyValues",
  "textBody",
  "htmlBody",
  "bodyStructure",
  "replyTo",
  "sender",
  "references",
  "headers",
]);

/**
 * RFC 8621 §4.4 — the EXACT default set when `properties` is omitted or null.
 * Note this includes parse-priced properties (references/sender/replyTo and
 * the body part lists), so a defaults `Email/get` fetches and parses each
 * message's blob. Internal callers that want cheap metadata pass an explicit
 * list (webmail's LIST_PROPERTIES, the agent's email tools).
 */
const DEFAULT_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
];

const KNOWN_PROPERTIES = new Set([...ROW_PROPERTIES, ...PARSED_PROPERTIES]);

/** RFC 8621 §4.1.2–§4.1.3 header-field forms. */
const HEADER_FORMS = ["Raw", "Text", "Addresses", "GroupedAddresses", "MessageIds", "Date", "URLs"] as const;
type HeaderForm = (typeof HEADER_FORMS)[number];

interface HeaderProp {
  /** The property string exactly as requested — echoed as the response key. */
  prop: string;
  name: string;
  form: HeaderForm;
  all: boolean;
}

export function registerEmailMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Email/get", emailGet);
  registry.register("Email/query", emailQuery);
  registry.register("Email/set", emailSet);
  registry.register("Email/import", emailImport);
  registry.register("Email/changes", async (args, ctx) => proxyChanges(ctx, args, "Email"));
  // Email/query advertises canCalculateChanges: false; answer per spec.
  registry.register("Email/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });
}

// ---- Email/get -------------------------------------------------------

async function emailGet(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "read");
  if (!Array.isArray(args.ids)) {
    throw new MethodError("invalidArguments", "Email/get requires ids");
  }
  const ids = args.ids as string[];
  const { properties, headerProps } = parseProperties(args.properties);

  const flags: BodyFetchFlags = {
    text: args.fetchTextBodyValues === true,
    html: args.fetchHTMLBodyValues === true,
    all: args.fetchAllBodyValues === true,
  };
  const maxBodyBytes = typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 0;

  const needsParse = properties.some((p) => PARSED_PROPERTIES.has(p)) || headerProps.length > 0;

  const store = storeFor(ctx);
  const rows = await store.getEmailRows(access.accountId, ids);

  const list: Record<string, unknown>[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue;
    const email = emailToJmap(row);
    if (needsParse) {
      Object.assign(
        email,
        await fetchParsed(store, access.tenantId, access.accountId, row, maxBodyBytes, flags, headerProps),
      );
    }
    list.push(pick(email, properties));
  }

  return {
    accountId: access.accountId,
    state: await accountState(ctx, access.accountId),
    list,
    notFound: ids.filter((id) => !rows.has(id)),
  };
}

/**
 * Validate the `properties` argument. RFC 8620 §5.1: a property the server
 * does not recognize MUST fail the call with `invalidArguments` — the old
 * behavior (return the object without the key) is how "this server never
 * serves bodyStructure" survived unnoticed until a real client rendered
 * nothing.
 */
function parseProperties(value: unknown): { properties: string[]; headerProps: HeaderProp[] } {
  if (value === undefined || value === null) return { properties: DEFAULT_PROPERTIES, headerProps: [] };
  if (!Array.isArray(value) || value.some((p) => typeof p !== "string")) {
    throw new MethodError("invalidArguments", "properties must be an array of strings");
  }
  const headerProps: HeaderProp[] = [];
  for (const p of value as string[]) {
    if (KNOWN_PROPERTIES.has(p)) continue;
    const parsed = parseHeaderProperty(p);
    if (!parsed) throw new MethodError("invalidArguments", `unknown property "${p}"`);
    headerProps.push(parsed);
  }
  return { properties: value as string[], headerProps };
}

/**
 * `header:{Name}` / `header:{Name}:as{Form}` / trailing `:all` (RFC 8621
 * §4.1.3). An RFC 5322 field name cannot contain ":", so splitting on it is
 * exact. Returns null for anything that does not fit the grammar — the caller
 * turns that into `invalidArguments`.
 */
function parseHeaderProperty(prop: string): HeaderProp | null {
  if (!prop.startsWith("header:")) return null;
  const segments = prop.split(":");
  const name = segments[1];
  if (!name || segments.length > 4) return null;

  let rest = segments.slice(2);
  let all = false;
  if (rest[rest.length - 1] === "all") {
    all = true;
    rest = rest.slice(0, -1);
  }
  let form: HeaderForm = "Raw";
  if (rest.length === 1) {
    const f = rest[0] as string;
    if (!f.startsWith("as")) return null;
    const candidate = f.slice(2) as HeaderForm;
    if (!HEADER_FORMS.includes(candidate)) return null;
    form = candidate;
  } else if (rest.length > 1) {
    return null;
  }
  return { prop, name, form, all };
}

function emailToJmap(row: EmailRow): Record<string, unknown> {
  return {
    id: row.id,
    blobId: row.blobId,
    threadId: row.threadId,
    mailboxIds: Object.fromEntries(row.mailboxIds.map((m) => [m, true])),
    keywords: Object.fromEntries(row.keywords.map((k) => [k, true])),
    size: row.size,
    receivedAt: new Date(row.receivedAt).toISOString(),
    messageId: row.messageId ? [row.messageId] : null,
    inReplyTo: row.inReplyTo ? [row.inReplyTo] : null,
    from: toJmapAddresses(row.from),
    to: toJmapAddresses(row.to),
    cc: toJmapAddresses(row.cc),
    bcc: toJmapAddresses(row.bcc),
    subject: row.subject,
    sentAt: null, // TODO: parse Date header at ingest
    hasAttachment: row.hasAttachment,
    preview: row.preview,
    attachments: row.attachments.map((a) => ({
      partId: null,
      blobId: a.blobId,
      size: a.size,
      name: a.name,
      type: a.type,
      cid: a.cid,
      disposition: a.disposition,
      // s03.B T3 — the attachment sidestep's cross-link, and the ONE property
      // here that RFC 8621 §4.1.4 does not define. It is an extension of
      // EmailBodyPart guarded by the `urn:ietf:params:jmap:filenode` capability
      // this server advertises: a client that does not know Files ignores an
      // unknown property, and a client that does gets the file's id without a
      // second query. Always present (null when the attachment stayed
      // inline-only) so the shape does not vary message to message.
      fileNodeId: a.fileNodeId ?? null,
    })),
  };
}

function toJmapAddresses(list: EmailAddress[]): Array<{ name: string | null; email: string }> {
  return list.map((a) => ({ name: a.name ?? null, email: a.email }));
}

interface BodyFetchFlags {
  text: boolean;
  html: boolean;
  all: boolean;
}

/** An RFC 8621 §4.1.4 EmailBodyPart, as this server can honestly emit one. */
interface BodyPartJson {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts?: BodyPartJson[];
  fileNodeId?: string | null;
}

/**
 * Parse the raw blob on demand for every parse-priced property: the body part
 * lists, `bodyStructure`, `bodyValues`, and the header-derived properties
 * (`replyTo`, `sender`, `references`, `headers`, `header:*`).
 *
 * On `bodyStructure`: PostalMime flattens the message — it hands back ONE
 * decoded text body, ONE html body and a list of attachments, not the original
 * MIME tree — so the original nesting is not recoverable here. The tree built
 * below is therefore deliberately simple and NEVER lies about what exists:
 * every leaf is real, with its real type, real size and (for attachments) the
 * real, downloadable blobId — the same blobIds the `attachments` property has
 * always served. Text leaves carry a PART-ADDRESSED blobId,
 * `<rawBlobId>~<partId>` (blobParts.ts), which the download door resolves by
 * re-parsing the raw message and serving just that part. This is not
 * decoration: clients like Mailtemi ignore `bodyValues` entirely and fetch
 * every part by blobId through the download template, so a text leaf without
 * a fetchable blobId renders as a body that never loads. `bodyValues` still
 * works too (the fetch*BodyValues flags are honored), and both paths decode
 * the same raw blob — the bytes agree by construction.
 */
async function fetchParsed(
  store: Mailstore,
  tenantId: string,
  accountId: string,
  row: EmailRow,
  maxBytes: number,
  flags: BodyFetchFlags,
  headerProps: HeaderProp[],
): Promise<Record<string, unknown>> {
  const blob = await store.getBlob(tenantId, accountId, row.blobId);
  if (!blob) {
    // The raw message is gone. Say "nothing", never invent parts.
    const out: Record<string, unknown> = {
      bodyValues: {},
      textBody: [],
      htmlBody: [],
      bodyStructure: emptyBodyPart(),
      replyTo: null,
      sender: null,
      references: null,
      headers: [],
    };
    for (const h of headerProps) out[h.prop] = h.all ? [] : null;
    return out;
  }
  const parsed = await PostalMime.parse(await blob.arrayBuffer());

  const textLeaf = parsed.text !== undefined ? textBodyPart("t", "text/plain", parsed.text, row.blobId) : null;
  const htmlLeaf = parsed.html !== undefined ? textBodyPart("h", "text/html", parsed.html, row.blobId) : null;
  const attLeaves = row.attachments.map(attachmentBodyPart);

  // The synthetic-but-honest tree: text+html as alternatives, attachments as
  // siblings under a mixed root — the shape virtually all such mail has.
  const alternatives = [textLeaf, htmlLeaf].filter((p): p is BodyPartJson => p !== null);
  const bodyRoot =
    alternatives.length === 2 ? multipartBodyPart("multipart/alternative", alternatives) : (alternatives[0] ?? null);
  const bodyStructure =
    attLeaves.length > 0
      ? multipartBodyPart("multipart/mixed", [...(bodyRoot ? [bodyRoot] : []), ...attLeaves])
      : (bodyRoot ?? emptyBodyPart());

  // RFC 8621 §4.1.4 derivation: when only one of text/html exists, BOTH lists
  // point at it — a text-only client still gets something to show for an
  // html-only message, and vice versa. The part keeps its true type either
  // way; clients pick rendering off `type`, not off which list it came in.
  const textBody = textLeaf ? [textLeaf] : htmlLeaf ? [htmlLeaf] : [];
  const htmlBody = htmlLeaf ? [htmlLeaf] : textLeaf ? [textLeaf] : [];

  // bodyValues honors the fetch*BodyValues flags (RFC 8621 §4.4): text for
  // parts in textBody, html for parts in htmlBody, all for every text/* leaf.
  // No flag set → empty object, exactly as specified.
  const partContent: Record<string, string> = {};
  if (textLeaf && parsed.text !== undefined) partContent.t = parsed.text;
  if (htmlLeaf && parsed.html !== undefined) partContent.h = parsed.html;
  const bodyValues: Record<string, unknown> = {};
  const include = (parts: BodyPartJson[]) => {
    for (const p of parts) {
      const v = p.partId === null ? undefined : partContent[p.partId];
      if (v !== undefined && p.partId !== null) bodyValues[p.partId] = truncate(v, maxBytes);
    }
  };
  if (flags.all) include([...(textLeaf ? [textLeaf] : []), ...(htmlLeaf ? [htmlLeaf] : [])]);
  if (flags.text) include(textBody);
  if (flags.html) include(htmlBody);

  const out: Record<string, unknown> = {
    bodyValues,
    textBody,
    htmlBody,
    bodyStructure,
    replyTo: toParsedAddresses(parsed.replyTo),
    sender: toParsedAddresses(parsed.sender ? [parsed.sender] : undefined),
    references: parseMessageIdList(parsed.references),
    headers: rawHeaders(parsed.headerLines),
  };
  for (const h of headerProps) out[h.prop] = headerValue(parsed.headerLines, h);
  return out;
}

function textBodyPart(partId: string, type: string, content: string, rawBlobId: string): BodyPartJson {
  return {
    partId,
    blobId: partBlobId(rawBlobId, partId),
    size: new TextEncoder().encode(content).byteLength,
    name: null,
    type,
    charset: "utf-8",
    disposition: null,
    cid: null,
    language: null,
    location: null,
  };
}

/** Same source of truth as the `attachments` property: the ingest-time row. */
function attachmentBodyPart(a: AttachmentMeta): BodyPartJson {
  return {
    partId: null,
    blobId: a.blobId,
    size: a.size,
    name: a.name,
    type: a.type,
    charset: null,
    disposition: a.disposition,
    cid: a.cid,
    language: null,
    location: null,
    // The Files cross-link, same rationale as in emailToJmap above.
    fileNodeId: a.fileNodeId ?? null,
  };
}

function multipartBodyPart(type: string, subParts: BodyPartJson[]): BodyPartJson {
  return {
    partId: null,
    blobId: null,
    size: 0,
    name: null,
    type,
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    subParts,
  };
}

/** A message with no body at all: one empty text/plain leaf, nothing invented. */
function emptyBodyPart(): BodyPartJson {
  return {
    partId: null,
    blobId: null,
    size: 0,
    name: null,
    type: "text/plain",
    charset: "utf-8",
    disposition: null,
    cid: null,
    language: null,
    location: null,
  };
}

// ---- header-derived properties (RFC 8621 §4.1.2–§4.1.3) ---------------

type EmailAddressJson = { name: string | null; email: string };

/** PostalMime addresses → RFC 8621 EmailAddress[], groups flattened. */
function toParsedAddresses(list: Address[] | undefined): EmailAddressJson[] | null {
  if (!list || list.length === 0) return null;
  const out: EmailAddressJson[] = [];
  const walk = (entries: Address[]) => {
    for (const a of entries) {
      if (a.group) walk(a.group);
      else if (a.address) out.push({ name: a.name === "" ? null : (a.name ?? null), email: a.address });
    }
  };
  walk(list);
  return out.length > 0 ? out : null;
}

/**
 * A raw References/Message-ID-shaped value → String[] per the MessageIds form:
 * the angle-bracketed ids, or (malformed but seen in the wild) bare
 * whitespace-separated tokens.
 */
function parseMessageIdList(raw: string | undefined | null): string[] | null {
  if (!raw) return null;
  const bracketed = [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1] as string);
  const ids =
    bracketed.length > 0
      ? bracketed
      : raw
          .trim()
          .split(/\s+/)
          .filter((t) => t !== "");
  return ids.length > 0 ? ids : null;
}

/** `line` is the complete raw header line; split at the first colon. */
function splitHeaderLine(line: string): { name: string; value: string } {
  const idx = line.indexOf(":");
  if (idx === -1) return { name: line, value: "" };
  return { name: line.slice(0, idx), value: line.slice(idx + 1) };
}

/** The `headers` property: every field, original casing, Raw form values. */
function rawHeaders(lines: HeaderLine[]): Array<{ name: string; value: string }> {
  return lines.map((l) => {
    const { name, value } = splitHeaderLine(l.line);
    return { name, value };
  });
}

function unfold(raw: string): string {
  return raw.replace(/\r?\n/g, "");
}

/** One `header:*` property for one message. Absent header → null (or [] with :all). */
function headerValue(lines: HeaderLine[], spec: HeaderProp): unknown {
  const key = spec.name.toLowerCase();
  const matches = lines.filter((l) => l.key === key);
  if (spec.all) return matches.map((l) => headerForm(splitHeaderLine(l.line).value, spec.form));
  const last = matches[matches.length - 1];
  return last === undefined ? null : headerForm(splitHeaderLine(last.line).value, spec.form);
}

function headerForm(raw: string, form: HeaderForm): unknown {
  switch (form) {
    case "Raw":
      return raw;
    case "Text":
      return decodeWords(unfold(raw)).trim();
    case "Addresses":
      return decodeAddressNames(toParsedAddresses(addressParser(unfold(raw), { flatten: true })) ?? []);
    case "GroupedAddresses":
      return toGroupedAddresses(addressParser(unfold(raw)));
    case "MessageIds":
      return parseMessageIdList(raw);
    case "Date": {
      const t = Date.parse(unfold(raw).trim());
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    case "URLs": {
      const urls = [...raw.matchAll(/<([^<>]+)>/g)].map((m) => m[1] as string);
      return urls.length > 0 ? urls : null;
    }
  }
}

/** addressParser leaves RFC 2047 words in display names encoded; decode them. */
function decodeAddressNames(addrs: EmailAddressJson[]): EmailAddressJson[] {
  return addrs.map((a) => (a.name === null ? a : { ...a, name: decodeWords(a.name) }));
}

/** The GroupedAddresses form: groups kept, loose mailboxes under a null name. */
function toGroupedAddresses(list: Address[]): Array<{ name: string | null; addresses: EmailAddressJson[] }> {
  const groups: Array<{ name: string | null; addresses: EmailAddressJson[] }> = [];
  let loose: EmailAddressJson[] = [];
  const flushLoose = () => {
    if (loose.length > 0) {
      groups.push({ name: null, addresses: loose });
      loose = [];
    }
  };
  for (const a of list) {
    if (a.group) {
      flushLoose();
      groups.push({
        name: a.name ? decodeWords(a.name) : null,
        addresses: decodeAddressNames(toParsedAddresses(a.group) ?? []),
      });
    } else if (a.address) {
      loose.push({ name: a.name === "" ? null : decodeWords(a.name), email: a.address });
    }
  }
  flushLoose();
  return groups;
}

function truncate(value: string, maxBytes: number): Record<string, unknown> {
  if (maxBytes > 0) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > maxBytes) {
      return {
        value: new TextDecoder().decode(bytes.slice(0, maxBytes)),
        isEncodingProblem: false,
        isTruncated: true,
      };
    }
  }
  return { value, isEncodingProblem: false, isTruncated: false };
}

/**
 * Copy the requested properties. Every requested property was validated in
 * `parseProperties` and materialized by `emailToJmap`/`fetchParsed`, so the
 * `p in obj` guard is belt-and-braces (parse-priced props when parsing was
 * skipped can only mean a bug upstream) — it can no longer silently eat a
 * property the client asked for.
 */
function pick(obj: Record<string, unknown>, properties: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: obj.id };
  for (const p of properties) if (p in obj) out[p] = obj[p];
  return out;
}

// ---- Email/query -----------------------------------------------------

async function emailQuery(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "read");
  const store = storeFor(ctx);

  const result = await store.queryEmails(access.accountId, {
    filter: (args.filter as EmailFilter | null | undefined) ?? null,
    sort: args.sort as EmailSort[] | undefined,
    position: typeof args.position === "number" ? args.position : 0,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    calculateTotal: args.calculateTotal === true,
  });

  return {
    accountId: access.accountId,
    queryState: await accountState(ctx, access.accountId),
    canCalculateChanges: false,
    position: result.position,
    ids: result.ids,
    ...(result.total !== undefined ? { total: result.total } : {}),
  };
}

// ---- Email/set -------------------------------------------------------

interface EmailSetResult {
  created: Record<string, unknown>;
  notCreated: Record<string, SetError>;
  updated: Record<string, null>;
  notUpdated: Record<string, SetError>;
  destroyed: string[];
  notDestroyed: Record<string, SetError>;
  emailChanges: ChangeEntry;
  mailboxesTouched: Set<string>;
  /**
   * FileNodes minted by the outbound attachment sidestep during THIS call.
   * Committed as a `FileNode` change entry even when the create that minted
   * them ultimately refused — the nodes are real rows in the drive, and a
   * FileNode no `/changes` entry announces is invisible to syncing clients.
   */
  fileNodesCreated: string[];
}

/**
 * Which scopes an `Email/set` call needs, derived from its own arguments.
 *
 * Pure — no ctx, no D1 — so the mapping is testable without a harness.
 *
 * One gate for the whole method used to mean `draft` authorized creating a
 * draft AND flagging, moving, and permanently destroying mail. The mail verbs
 * (read, annotate, draft, move, send, delete) are an INDEPENDENT flat set, not
 * an order — `draft` does not imply `move` or `delete` — so a token
 * deliberately scoped to compose drafts must NOT be able to delete the inbox.
 *
 * `move` is charged only when a patch actually touches `mailboxIds`; a
 * keywords-only patch is `annotate`. Patch keys arrive in JSON-pointer form
 * (`mailboxIds/<id>`, `keywords/$seen`) or as whole-property replacements.
 */
export function requiredScopesForEmailSet(args: Record<string, unknown>): string[] {
  const need = new Set<string>();
  const create = args.create as Record<string, unknown> | undefined;
  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  const destroy = args.destroy as string[] | undefined;

  if (create && Object.keys(create).length > 0) need.add("draft");
  if (update) {
    for (const patch of Object.values(update)) {
      // Charge for EVERY kind of change the patch makes, not just the highest.
      // This was `need.add(touchesMailboxes ? "move" : "annotate")` — a ternary,
      // so a patch touching both mailboxIds AND keywords charged only `move`.
      // `hasScope` is a flat set, not an order (common/027): `move` does not
      // imply `annotate`, so a move-scoped token could otherwise flip keywords
      // for free by bundling them into a move.
      const keys = Object.keys(patch ?? {});
      const isMailboxKey = (k: string) => k === "mailboxIds" || k.startsWith("mailboxIds/");
      if (keys.some(isMailboxKey)) need.add("move");
      // Fail closed: an empty patch charges `annotate` rather than nothing.
      if (keys.length === 0 || keys.some((k) => !isMailboxKey(k))) need.add("annotate");
    }
  }
  if (destroy && destroy.length > 0) need.add("delete");
  return [...need];
}

async function emailSet(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccountScopes(ctx, args, requiredScopesForEmailSet(args));
  const store = storeFor(ctx);

  const oldState = await accountState(ctx, access.accountId);
  if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const r: EmailSetResult = {
    created: {},
    notCreated: {},
    updated: {},
    notUpdated: {},
    destroyed: [],
    notDestroyed: {},
    emailChanges: { collection: "Email", created: [], updated: [], destroyed: [] },
    mailboxesTouched: new Set(),
    fileNodesCreated: [],
  };

  // -- create (drafts) --
  const create = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(create)) {
    try {
      r.created[cid] = await createDraft(ctx, store, access, spec, r);
    } catch (err) {
      r.notCreated[cid] = toCreateSetError(err);
    }
  }

  // -- update (flags, moves) --
  const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, patch] of Object.entries(update)) {
    try {
      await applyEmailPatch(store, access.accountId, id, patch, r.mailboxesTouched);
      r.updated[id] = null;
      r.emailChanges.updated.push(id);
    } catch (err) {
      r.notUpdated[id] =
        err instanceof MethodError && err.type === "invalidArguments"
          ? setError("invalidProperties", err.description)
          : err instanceof NotFoundError
            ? setError("notFound")
            : setError("serverFail", String(err));
    }
  }

  // -- destroy --
  const destroy = (args.destroy as string[] | undefined) ?? [];
  for (const id of destroy) {
    const row = await store.getEmailRow(access.accountId, id);
    if (!row) {
      r.notDestroyed[id] = setError("notFound");
      continue;
    }
    await store.destroyEmail(access.accountId, id);
    for (const mb of row.mailboxIds) r.mailboxesTouched.add(mb);
    r.destroyed.push(id);
    r.emailChanges.destroyed.push(id);
  }

  const newState = await commitEmailChanges(ctx, access.accountId, r);

  return {
    accountId: access.accountId,
    oldState,
    newState,
    created: r.created,
    notCreated: r.notCreated,
    updated: r.updated,
    notUpdated: r.notUpdated,
    destroyed: r.destroyed,
    notDestroyed: r.notDestroyed,
  };
}

async function commitEmailChanges(ctx: RequestContext, accountId: string, r: EmailSetResult): Promise<string> {
  const entries: Array<Partial<ChangeEntry> & { collection: string }> = [];
  const e = r.emailChanges;
  if (e.created.length + e.updated.length + e.destroyed.length > 0) entries.push(e);
  if (r.mailboxesTouched.size > 0) {
    entries.push({ collection: "Mailbox", updated: [...r.mailboxesTouched] });
  }
  if (r.fileNodesCreated.length > 0) {
    entries.push({ collection: "FileNode", created: r.fileNodesCreated });
  }
  if (entries.length === 0) return accountState(ctx, accountId);
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, entries);
  return newState;
}

class NotFoundError extends Error {}

/**
 * Apply an RFC 8620 PatchObject to an email. Supported paths:
 *   keywords            (full replace)     keywords/$seen: true|null
 *   mailboxIds          (full replace)     mailboxIds/<id>: true|null
 * Exported for reuse by EmailSubmission/set onSuccessUpdateEmail.
 */
export async function applyEmailPatch(
  store: Mailstore,
  accountId: string,
  emailId: string,
  patch: Record<string, unknown>,
  mailboxesTouched: Set<string>,
): Promise<void> {
  const row = await store.getEmailRow(accountId, emailId);
  if (!row) throw new NotFoundError();

  const keywords = new Set(row.keywords);
  const mailboxIds = new Set(row.mailboxIds);
  let touchedKeywords = false;
  let touchedMailboxes = false;

  for (const [path, value] of Object.entries(patch)) {
    const [head, sub, ...rest] = path.split("/");
    if (rest.length > 0) throw new MethodError("invalidArguments", `unsupported path "${path}"`);

    if (head === "keywords") {
      touchedKeywords = true;
      applySetPatch(keywords, sub, value, path);
    } else if (head === "mailboxIds") {
      touchedMailboxes = true;
      applySetPatch(mailboxIds, sub, value, path);
    } else {
      throw new MethodError("invalidArguments", `property "${path}" is immutable or unknown`);
    }
  }

  if (touchedMailboxes && mailboxIds.size === 0) {
    throw new MethodError("invalidArguments", "an email must belong to at least one mailbox");
  }

  await store.replaceEmailSets(accountId, emailId, {
    ...(touchedMailboxes ? { mailboxIds: [...mailboxIds] } : {}),
    ...(touchedKeywords ? { keywords: [...keywords] } : {}),
  });

  if (touchedMailboxes) {
    for (const mb of row.mailboxIds) mailboxesTouched.add(mb);
    for (const mb of mailboxIds) mailboxesTouched.add(mb);
  } else if (touchedKeywords) {
    // $seen flips change unread counts on containing mailboxes.
    for (const mb of row.mailboxIds) mailboxesTouched.add(mb);
  }
}

function applySetPatch(target: Set<string>, sub: string | undefined, value: unknown, path: string) {
  if (sub === undefined) {
    // Full replace: value is Record<string, true>.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MethodError("invalidArguments", `"${path}" must be an object`);
    }
    target.clear();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === true) target.add(k);
    }
  } else if (value === true) {
    target.add(sub);
  } else if (value === null || value === false) {
    target.delete(sub);
  } else {
    throw new MethodError("invalidArguments", `"${path}" must be true or null`);
  }
}

/** Email/set create — build MIME for a simple draft, store blob + row. */
async function createDraft(
  ctx: RequestContext,
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  spec: Record<string, unknown>,
  r: EmailSetResult,
): Promise<Record<string, unknown>> {
  const mailboxIds = Object.entries((spec.mailboxIds as Record<string, unknown> | undefined) ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (mailboxIds.length === 0) {
    throw new MethodError("invalidArguments", "mailboxIds is required for create");
  }

  const keywords = Object.entries((spec.keywords as Record<string, unknown> | undefined) ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const from = fromJmapAddresses(spec.from);
  const to = fromJmapAddresses(spec.to);
  const cc = fromJmapAddresses(spec.cc);
  const bcc = fromJmapAddresses(spec.bcc);
  const subject = typeof spec.subject === "string" ? spec.subject : "";
  const inReplyTo = normalizeMessageId(
    Array.isArray(spec.inReplyTo) && typeof spec.inReplyTo[0] === "string" ? (spec.inReplyTo[0] as string) : null,
  );

  // Body — RFC 8621 §4.6 gives a create two MUTUALLY EXCLUSIVE forms:
  //
  //   1. textBody/htmlBody + bodyValues — what our webmail, CLI and agent send;
  //   2. bodyStructure + bodyValues — a client-authored part tree, the form
  //      IMAP-heritage clients (Mailtemi) send.
  //
  // Ignoring form 2 is how a real message left this server with a
  // cryptographically empty body: both DKIM bh= values on the received copy
  // hashed the empty canonicalized body, because `text` and `html` came back
  // undefined and buildMime emitted a headers-only message. The rule now is
  // that body content NEVER silently vanishes: every partId must resolve
  // through bodyValues, every shape we cannot mail faithfully refuses by
  // name, and the only empty body that goes out is one the client explicitly
  // wrote (RFC 5322 makes the body optional, so an empty create stays legal).
  const bodyValues = parseBodyValues(spec.bodyValues);
  let text: string | undefined;
  let html: string | undefined;
  // Blob-referencing parts (RFC 8621 §4.1.4 EmailBodyPart[]) — the
  // `attachments` property, or the blobId leaves of a `bodyStructure`,
  // whether those land as attachment parts or as the body itself. Resolved —
  // and, crucially, AUTHORIZED — before a single byte reaches the builder.
  let attachments: ResolvedAttachment[];
  // Set iff the outbound attachment sidestep fired (s03.B T3): the create was
  // over the cap, every non-inline attachment became a FileNode + expiring
  // link, and the body gains the link block below.
  let sidestep: AppliedSidestep | null = null;
  if (spec.bodyStructure !== undefined && spec.bodyStructure !== null) {
    // §4.6: one form or the other. Merging would mean guessing which of two
    // bodies the client meant — refuse, naming both sides of the conflict.
    // An EMPTY textBody/htmlBody/attachments array carries no content, so it
    // does not count as the other form; refusing on it would only break
    // clients that emit vestigial empty lists next to their bodyStructure.
    const conflicts = ["textBody", "htmlBody", "attachments"].filter((p) => {
      const v = spec[p];
      return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
    });
    if (conflicts.length > 0) {
      throw new SetErrorSignal(
        "invalidProperties",
        `bodyStructure and ${conflicts.join("/")} are mutually exclusive (RFC 8621 §4.6) — supply the body in one form`,
        ["bodyStructure", ...conflicts],
      );
    }
    const flat = flattenBodyStructure(spec.bodyStructure, bodyValues);
    try {
      ({ text, html, attachments } = await resolveFlattenedBody(store, access, flat));
    } catch (err) {
      // Body-content blobs (a text leaf carried by blobId) are the message's
      // own words — reserved, never movable; only the attachment bucket can
      // side-step. If the reserved bytes alone bust the cap, the re-run
      // below rethrows the honest tooLarge.
      const reserved = [...flat.textSources, ...flat.htmlSources].flatMap((s) => ("blob" in s ? [s.blob] : []));
      const plan = await sidestepPlanFor(err, ctx, store, access, flat.attachments, reserved);
      if (!plan) throw err;
      ({ text, html, attachments } = await resolveFlattenedBody(store, access, { ...flat, attachments: plan.kept }));
      sidestep = await applyOutboundSidestep(ctx, store, access, plan.moved, r.fileNodesCreated);
    }
  } else {
    text = resolveBodyPart(spec.textBody, bodyValues, "textBody");
    html = resolveBodyPart(spec.htmlBody, bodyValues, "htmlBody");
    const attachmentSpecs = parseAttachmentSpecs(spec.attachments);
    // Content supplied but referenced by NOTHING would mail an empty body —
    // for a client that believes it wrote one, that is exactly the failure
    // this block exists to kill.
    if (text === undefined && html === undefined && Object.keys(bodyValues).length > 0) {
      throw new SetErrorSignal(
        "invalidProperties",
        "bodyValues are present but no textBody/htmlBody/bodyStructure references them — this create would mail an empty body",
        ["bodyValues"],
      );
    }
    try {
      attachments = await resolveAttachments(store, access, attachmentSpecs);
    } catch (err) {
      const plan = await sidestepPlanFor(err, ctx, store, access, attachmentSpecs, []);
      if (!plan) throw err;
      attachments = await resolveAttachments(store, access, plan.kept);
      sidestep = await applyOutboundSidestep(ctx, store, access, plan.moved, r.fileNodesCreated);
    }
  }

  if (sidestep) {
    // The recipient's copy of the truth: one line per file — name, human
    // size, capability URL — plus the expiry date, stated plainly. Appended
    // to every body variant the message has; created as a text body when an
    // all-attachment send had none.
    ({ text, html } = appendSidestepBlock(text, html, sidestep));
  }

  // stored == wire, from the create side: a client may stamp its own
  // Message-ID (RFC 8621 §4.1.3 `messageId`) and Date (`sentAt`) — Mailtemi
  // and friends do. When it does, those values go INTO the MIME and into the
  // row, identically; we generate only what the client left blank. Silently
  // overwriting a client's Message-ID would re-open the divergence this
  // exists to close: the client would hold one id, our store another.
  const clientMessageId = normalizeMessageId(
    Array.isArray(spec.messageId) && typeof spec.messageId[0] === "string" ? (spec.messageId[0] as string) : null,
  );
  const messageId = clientMessageId ?? `${crypto.randomUUID()}@${from[0]?.email.split("@")[1] ?? "localhost"}`;
  const sentAt = typeof spec.sentAt === "string" ? new Date(spec.sentAt) : null;
  const raw = buildMime({
    from,
    to,
    cc,
    bcc,
    subject,
    messageId,
    inReplyTo,
    date: sentAt !== null && !Number.isNaN(sentAt.getTime()) ? sentAt : new Date(),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    // Absent, not empty, when there are none: `buildMime` collapses empty
    // levels either way, but this keeps the no-attachment call byte-identical
    // to the one it made before attachments existed.
    ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.mime) } : {}),
  });

  const rawBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(access.tenantId, access.accountId, rawBuf);
  const threadId = await store.resolveThreadId(access.accountId, inReplyTo);
  const id = `e_${crypto.randomUUID()}`;
  const receivedAt = Date.now();

  // Same rule as the INBOUND path (`importOne` below, and ingest): a CID
  // image the HTML displays is not "an attachment" as a user means it, so it
  // must not raise the paperclip. Disposition decides, not part count.
  const hasAttachment = attachments.some((a) => a.meta.disposition !== "inline");

  await store.insertEmail(access.accountId, {
    id,
    blobId,
    threadId,
    messageId,
    inReplyTo,
    subject,
    from,
    to,
    cc,
    bcc,
    preview: previewText(text, html),
    // Full body into the FTS index (common/004) — a draft is searchable by
    // its own text, not just its first 256 characters.
    bodyText: text && text.trim() !== "" ? text : htmlToIndexText(html),
    size: raw.byteLength,
    receivedAt,
    hasAttachment,
    // stored == wire: only parts that are ON the MIME appear here. A
    // side-stepped file is deliberately absent — it is not an attachment of
    // this message any more; it is a FileNode in the drive plus a link in
    // the body, and listing it here would promise a part download that has
    // no part behind it.
    attachments: attachments.map((a) => a.meta),
    mailboxIds,
    keywords,
  });

  r.emailChanges.created.push(id);
  for (const mb of mailboxIds) r.mailboxesTouched.add(mb);

  return {
    id,
    blobId,
    threadId,
    size: raw.byteLength,
    // When the sidestep fired, the stored email's attachments are NOT what
    // the client asked for — RFC 8620 §5.3 says exactly this case is signaled
    // by returning the property whose final value differs from the client's.
    // A re-fetch would show the same thing; this makes the transformation
    // visible in the create response itself, with no nonstandard fields.
    ...(sidestep ? { attachments: attachments.map((a) => a.meta), hasAttachment } : {}),
  };
}

/**
 * Is this refusal one the outbound sidestep can turn into a success?
 *
 * `null` — for ANY of: the error is not `tooLarge`; sharing is not configured
 * (no signing key, or a caller with no request origin such as the agent MCP
 * bridge); or the plan itself finds nothing movable. The caller rethrows the
 * ORIGINAL error, so wherever the sidestep cannot fire, `Email/set create`
 * behaves byte-for-byte as it did before the sidestep existed.
 */
async function sidestepPlanFor(
  err: unknown,
  ctx: RequestContext,
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  movable: AttachmentSpec[],
  reserved: AttachmentSpec[],
): Promise<PlannedSidestep<AttachmentSpec> | null> {
  if (!(err instanceof SetErrorSignal) || err.type !== "tooLarge") return null;
  if (!ctx.env.SHARE_SIGNING_KEY || !ctx.origin) return null;
  return planOutboundSidestep(store, access, movable, reserved, MAX_ATTACHMENT_BYTES_PER_EMAIL);
}

// ---- attachments on create -------------------------------------------

interface ResolvedAttachment {
  /** What the builder needs: bytes plus part headers. */
  mime: MimeAttachment;
  /** What `Email/get` reads back, so a create round-trips. */
  meta: AttachmentMeta;
}

/** One blob-referencing part as the client sent it, after shape validation. */
interface AttachmentSpec {
  blobId: string;
  type: string;
  /** Content-Type charset parameter for the wire; never stored in meta. */
  charset: string | null;
  name: string | null;
  cid: string | null;
  disposition: string;
  /** JSON pointer blamed in SetErrors: `attachments/0`, `bodyStructure/subParts/2`. */
  path: string;
}

/**
 * Turn the blob-referencing EmailBodyParts of an `Email/set create` — the
 * `attachments` property, or the blobId leaves of a `bodyStructure` — into
 * bytes.
 *
 * ⚠️ THIS IS AN AUTHORIZATION BOUNDARY, not a lookup helper.
 *
 * A `blobId` is a client-supplied string, so it is attacker-CHOSEN. If a blob
 * belonging to another account could be attached, `Email/set` would be a
 * cross-account read primitive: compose a draft citing the victim's blobId,
 * then read the victim's file out of the message you now own. There is no
 * quota, rate limit or audit trail that makes that acceptable — it has to be
 * impossible.
 *
 * It is made impossible structurally rather than by a comparison. R2 keys are
 * `mail/{tenantId}/{accountId}/blobs/{blobId}` (`blobKey` in
 * packages/mailstore), so `headBlob`/`getBlob` can only ever address objects
 * inside ONE account's namespace — and the tenant and account passed here come
 * from `access`, the AccountAccess that `requireAccountScopes` already
 * authorized, never from the request body. A foreign blobId therefore does not
 * resolve to a different object; it resolves to nothing.
 *
 * Note that `putBlob` is content-addressed, so two accounts holding identical
 * bytes share a blobId under two different keys. That is not a leak: the
 * caller reads their own copy, which they already had.
 *
 * A blob that does not resolve is a REFUSAL (`blobNotFound`), never a skip.
 * Silently dropping the part would create the worst outcome available here —
 * a user who believes they sent a document they did not send.
 *
 * Size is settled in a first pass over metadata only (`headBlob` transfers no
 * body). Checking after the fetch would mean loading the bytes we are about to
 * reject, i.e. OOMing the isolate on exactly the input the limit exists to
 * refuse.
 */
async function resolveAttachments(
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  specs: AttachmentSpec[],
): Promise<ResolvedAttachment[]> {
  if (specs.length === 0) return [];

  // Pass 1 — ownership + size. No bodies.
  const sizes: number[] = [];
  let total = 0;
  for (const spec of specs) {
    const head = await store.headBlob(access.tenantId, access.accountId, spec.blobId);
    if (!head) {
      throw new SetErrorSignal("blobNotFound", `no such blob in this account: ${spec.blobId}`, [`${spec.path}/blobId`]);
    }
    total += head.size;
    if (total > MAX_ATTACHMENT_BYTES_PER_EMAIL) {
      throw new SetErrorSignal(
        "tooLarge",
        `attachments exceed ${MAX_ATTACHMENT_BYTES_PER_EMAIL} bytes for one message`,
        // Blame the whole property, whichever create form carried the parts.
        [spec.path.split("/")[0] as string],
      );
    }
    sizes.push(head.size);
  }

  // Pass 2 — bytes, from the same account-scoped keyspace.
  const out: ResolvedAttachment[] = [];
  for (const [i, spec] of specs.entries()) {
    const obj = await store.getBlob(access.tenantId, access.accountId, spec.blobId);
    if (!obj) {
      // Only reachable if the blob was deleted between the two passes.
      throw new SetErrorSignal("blobNotFound", `blob vanished mid-write: ${spec.blobId}`, [`${spec.path}/blobId`]);
    }
    const content = new Uint8Array(await obj.arrayBuffer());
    out.push({
      mime: {
        // The charset rides the wire header only; `meta.type` below stays the
        // bare media type, which is what JMAP's `type` property is defined as.
        type: spec.charset ? `${spec.type}; charset=${spec.charset}` : spec.type,
        content,
        name: spec.name,
        cid: spec.cid,
        disposition: spec.disposition,
      },
      meta: {
        blobId: spec.blobId,
        type: spec.type,
        name: spec.name,
        size: sizes[i] as number,
        cid: spec.cid,
        disposition: spec.disposition,
        // The Files cross-link is set only by INBOUND ingest (s03.B T3). An
        // outbound part that rides the message never has one: the outbound
        // sidestep removes a file from the attachment list entirely (FileNode
        // + link in the body), so any part reaching this point stayed a plain
        // attachment.
        fileNodeId: null,
      },
    });
  }
  return out;
}

function parseAttachmentSpecs(value: unknown): AttachmentSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SetErrorSignal("invalidProperties", "attachments must be an EmailBodyPart[]", ["attachments"]);
  }
  return value.map((raw, i) => parseAttachmentSpec(raw, `attachments/${i}`));
}

/**
 * Validate one blob-referencing EmailBodyPart, wherever in the create it sat —
 * an `attachments` entry or a blobId leaf of a `bodyStructure`. `path` is the
 * JSON pointer blamed if the part (or, later, its blob) refuses.
 */
function parseAttachmentSpec(raw: unknown, path: string): AttachmentSpec {
  const at = (p: string) => [`${path}/${p}`];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", "each attachment must be an object", [path]);
  }
  const part = raw as Record<string, unknown>;
  if (typeof part.blobId !== "string" || part.blobId === "") {
    throw new SetErrorSignal("invalidProperties", "an attachment requires a blobId", at("blobId"));
  }
  if (part.type !== undefined && part.type !== null && typeof part.type !== "string") {
    throw new SetErrorSignal("invalidProperties", "type must be a string", at("type"));
  }
  if (part.name !== undefined && part.name !== null && typeof part.name !== "string") {
    throw new SetErrorSignal("invalidProperties", "name must be a string", at("name"));
  }
  if (part.cid !== undefined && part.cid !== null && typeof part.cid !== "string") {
    throw new SetErrorSignal("invalidProperties", "cid must be a string", at("cid"));
  }
  if (part.disposition !== undefined && part.disposition !== null && typeof part.disposition !== "string") {
    throw new SetErrorSignal("invalidProperties", "disposition must be a string", at("disposition"));
  }
  // A charset lands inside a Content-Type header line, so it is confined to
  // charset-label characters — never a place CRLF or `;` can ride through.
  if (
    part.charset !== undefined &&
    part.charset !== null &&
    part.charset !== "" &&
    (typeof part.charset !== "string" || !/^[A-Za-z0-9._:-]+$/.test(part.charset))
  ) {
    throw new SetErrorSignal("invalidProperties", "charset must be a charset label", at("charset"));
  }
  const cid = typeof part.cid === "string" && part.cid !== "" ? part.cid : null;
  return {
    blobId: part.blobId,
    // RFC 8621 leaves `type` optional; octet-stream is the RFC 2046 §4.5.1
    // default for "bytes of unknown kind".
    type: typeof part.type === "string" && part.type !== "" ? part.type : "application/octet-stream",
    // An attaching blob's bytes pass through VERBATIM, so the client's
    // charset is real information about them and rides onto the wire
    // Content-Type. (An INLINE body leaf instead consumes it to decode —
    // see decodeInlineTextBlob — and partId content never carries one:
    // §4.6 forbids it, the server re-encodes. See flattenBodyStructure.)
    charset: typeof part.charset === "string" && part.charset !== "" ? part.charset : null,
    name: typeof part.name === "string" && part.name !== "" ? part.name : null,
    cid,
    // A cid-carrying part is inline unless the client says otherwise; this
    // is also the value `hasAttachment` is decided on, so it is stored, not
    // just serialized.
    disposition:
      typeof part.disposition === "string" && part.disposition !== ""
        ? part.disposition
        : cid
          ? "inline"
          : "attachment",
    path,
  };
}

/**
 * A SetError raised from inside `createDraft`, carrying its REAL RFC 8621
 * type. Without this every failure collapsed into `invalidProperties`, so a
 * client could not tell "that blob is not yours" (`blobNotFound`) from "that
 * is too big to send" (`tooLarge`) from a malformed argument — and only the
 * middle one is fixed by attaching a smaller file. Same shape as the one in
 * calendars.ts/filenode.ts.
 */
class SetErrorSignal extends Error {
  constructor(
    public type: string,
    public description?: string,
    public properties?: string[],
  ) {
    super(description ?? type);
  }
}

function toCreateSetError(err: unknown): SetError {
  if (err instanceof SetErrorSignal) {
    return {
      type: err.type,
      ...(err.description ? { description: err.description } : {}),
      ...(err.properties ? { properties: err.properties } : {}),
    };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

// ---- Email/import (RFC 8621 §4.8) --------------------------------------
// himalaya's send path: Blob upload → Email/import into drafts → submit.

interface ImportSpec {
  blobId?: string;
  mailboxIds?: Record<string, unknown>;
  keywords?: Record<string, unknown>;
  receivedAt?: string;
}

async function emailImport(args: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "draft");
  const store = storeFor(ctx);

  const oldState = await accountState(ctx, access.accountId);
  if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const emailsCreated: string[] = [];
  const mailboxesTouched = new Set<string>();

  const specs = (args.emails as Record<string, ImportSpec> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(specs)) {
    try {
      const result = await importOne(store, access, spec, mailboxesTouched);
      created[cid] = result;
      emailsCreated.push(result.id);
    } catch (err) {
      notCreated[cid] =
        err instanceof MethodError
          ? setError(err.type === "invalidArguments" ? "invalidProperties" : err.type, err.description)
          : setError("serverFail", String(err));
    }
  }

  let newState = oldState;
  if (emailsCreated.length > 0) {
    ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [
      { collection: "Email", created: emailsCreated },
      { collection: "Mailbox", updated: [...mailboxesTouched] },
    ]));
  }

  return { accountId: access.accountId, oldState, newState, created, notCreated };
}

async function importOne(
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  spec: ImportSpec,
  mailboxesTouched: Set<string>,
): Promise<{ id: string; blobId: string; threadId: string; size: number }> {
  if (!spec.blobId) throw new MethodError("invalidArguments", "blobId is required");
  const mailboxIds = Object.entries(spec.mailboxIds ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (mailboxIds.length === 0) {
    throw new MethodError("invalidArguments", "mailboxIds must contain at least one mailbox");
  }
  const keywords = Object.entries(spec.keywords ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const blob = await store.getBlob(access.tenantId, access.accountId, spec.blobId);
  if (!blob) throw new MethodError("blobNotFound", `blob ${spec.blobId} not found`);
  const raw = await blob.arrayBuffer();

  const parsed = await PostalMime.parse(raw);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  // Own-Message-ID as the fallback join (see resolveThreadId): importing a
  // copy of a message the account already holds threads it with its sibling.
  const threadId = await store.resolveThreadId(access.accountId, inReplyTo, normalizeMessageId(parsed.messageId));

  // Attachments become individual content-hash blobs, same as ingest.
  const attachments = [];
  for (const att of parsed.attachments ?? []) {
    const content = typeof att.content === "string" ? new TextEncoder().encode(att.content).buffer : att.content;
    const attBlobId = await store.putBlob(access.tenantId, access.accountId, content as ArrayBuffer);
    attachments.push({
      blobId: attBlobId,
      type: att.mimeType ?? "application/octet-stream",
      name: att.filename ?? null,
      size: (content as ArrayBuffer).byteLength,
      cid: att.contentId ?? null,
      disposition: att.disposition ?? null,
    });
  }

  const id = `e_${crypto.randomUUID()}`;
  const receivedAt = spec.receivedAt ? Date.parse(spec.receivedAt) : parsed.date ? Date.parse(parsed.date) : Date.now();

  await store.insertEmail(access.accountId, {
    id,
    blobId: spec.blobId,
    threadId,
    messageId: normalizeMessageId(parsed.messageId),
    inReplyTo,
    subject: parsed.subject ?? "",
    from: importAddresses(parsed.from ? [parsed.from] : []),
    to: importAddresses(parsed.to ?? []),
    cc: importAddresses(parsed.cc ?? []),
    bcc: importAddresses(parsed.bcc ?? []),
    preview: previewText(parsed.text, parsed.html),
    // Imported mail is indexed on the same terms as delivered mail
    // (common/004) — an HTML-only message has no `.text` at all.
    bodyText: parsed.text && parsed.text.trim() !== "" ? parsed.text : htmlToIndexText(parsed.html),
    size: raw.byteLength,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
    hasAttachment: attachments.some((a) => a.disposition !== "inline"),
    attachments,
    mailboxIds,
    keywords,
  });

  for (const mb of mailboxIds) mailboxesTouched.add(mb);
  return { id, blobId: spec.blobId, threadId, size: raw.byteLength };
}

function importAddresses(list: Array<{ name?: string; address?: string }>): EmailAddress[] {
  return list
    .filter((a) => a.address)
    .map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.address as string }));
}

// ---- body content on create (RFC 8621 §4.6) ---------------------------

type BodyValues = Record<string, { value?: unknown }>;

function parseBodyValues(value: unknown): BodyValues {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SetErrorSignal("invalidProperties", "bodyValues must map partId to EmailBodyValue", ["bodyValues"]);
  }
  return value as BodyValues;
}

/**
 * The string behind a partId. RFC 8621 §4.6: "if a partId is given, this
 * partId MUST be present in the bodyValues property". A dangling reference
 * used to resolve to `undefined`, which mailed a HEADERS-ONLY message — the
 * silent empty body this file now refuses to produce — so it is an error
 * naming both ends of the broken reference, never a default.
 */
function requireBodyValue(bodyValues: BodyValues, partId: string, path: string): string {
  const value = bodyValues[partId]?.value;
  if (typeof value !== "string") {
    throw new SetErrorSignal(
      "invalidProperties",
      `partId "${partId}" has no string value in bodyValues (RFC 8621 §4.6 requires one)`,
      [`${path}/partId`, `bodyValues/${partId}`],
    );
  }
  return value;
}

/**
 * Resolve `textBody`/`htmlBody` — the simple §4.6 create form — to content.
 *
 * On create each list is exactly one part of the matching text type whose
 * partId resolves through bodyValues. Every other shape used to flatten
 * SILENTLY to "no body here"; each now refuses with the property named.
 */
function resolveBodyPart(partList: unknown, bodyValues: BodyValues, prop: "textBody" | "htmlBody"): string | undefined {
  if (partList === undefined || partList === null) return undefined;
  if (!Array.isArray(partList)) {
    throw new SetErrorSignal("invalidProperties", `${prop} must be an EmailBodyPart[]`, [prop]);
  }
  if (partList.length === 0) return undefined;
  if (partList.length > 1) {
    throw new SetErrorSignal("invalidProperties", `${prop} must contain exactly one part on create (RFC 8621 §4.6)`, [
      prop,
    ]);
  }
  const raw = partList[0];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", `${prop}/0 must be an EmailBodyPart`, [`${prop}/0`]);
  }
  const part = raw as { partId?: unknown; type?: unknown };
  const expected = prop === "textBody" ? "text/plain" : "text/html";
  if (typeof part.type === "string" && part.type.trim().toLowerCase() !== expected) {
    throw new SetErrorSignal("invalidProperties", `${prop} must be ${expected}, not "${part.type}"`, [
      `${prop}/0/type`,
    ]);
  }
  if (typeof part.partId !== "string" || part.partId === "") {
    throw new SetErrorSignal("invalidProperties", `${prop}/0 requires a partId naming an entry in bodyValues`, [
      `${prop}/0/partId`,
    ]);
  }
  return requireBodyValue(bodyValues, part.partId, `${prop}/0`);
}

/**
 * Depth at which a bodyStructure stops being mail and starts being a payload.
 * Real client trees are ≤4 (mixed > related > alternative > leaf); this is a
 * refusal bound, not a target.
 */
const MAX_BODY_STRUCTURE_DEPTH = 8;

/**
 * One entry of a flattened text or html bucket, in document order: content
 * already in hand (a partId leaf, resolved through bodyValues), or uploaded
 * bytes still to be fetched and decoded (an inline blobId leaf).
 */
type BodySource = { value: string } | { blob: AttachmentSpec };

interface FlattenedBody {
  textSources: BodySource[];
  htmlSources: BodySource[];
  attachments: AttachmentSpec[];
}

/**
 * Map a client-authored `bodyStructure` tree — RFC 8621 §4.6's second create
 * form, the one IMAP-heritage clients such as Mailtemi send — onto what
 * `buildMime` can express: at most one text/plain body, at most one text/html
 * body, plus attachment parts (cid-referenced → multipart/related, the rest
 * → multipart/mixed).
 *
 * Flattening rules. Content is preserved or the create is REFUSED — never
 * silently dropped, because "mailed something other than what the client
 * composed" is the failure class this function exists to kill:
 *
 * - multipart/* parts recurse into `subParts` (non-empty, no partId/blobId of
 *   their own). The subtype is not interpreted beyond "has children":
 *   alternative, related and mixed all flatten into the same three buckets,
 *   and buildMime re-nests those canonically.
 * - a partId leaf is authored content: text/plain or text/html only — all a
 *   bodyValues string can faithfully become. Several text leaves concatenate
 *   in document order. Content is emitted as UTF-8 regardless of any charset
 *   on the part: §4.6 forbids `charset` next to partId precisely so the
 *   server picks the encoding, and UTF-8 represents every JSON string
 *   exactly.
 * - a blobId leaf is stored bytes, and its DISPOSITION — not the fact that
 *   the bytes were uploaded — decides where they land. RFC 8621 §4.6 lets a
 *   body leaf carry its content by blobId, and Mailtemi composes exactly so:
 *   it uploads its body parts, then references them as blobId leaves typed
 *   text/plain and text/html with no disposition. Such a leaf — text/plain
 *   or text/html, no cid, disposition absent or "inline" — is BODY content:
 *   fetched, decoded per its declared charset, and bucketed just as a partId
 *   leaf's content is. Anything else — an explicit disposition: "attachment"
 *   whatever the type, a non-text type, a cid-referenced part (related
 *   territory, resolved from the HTML) — becomes an attachment part with its
 *   declared type/charset/name/cid/disposition. Either way the blob is
 *   authorized and size-bounded by `resolveAttachments` exactly like the
 *   `attachments` property. (Routing EVERY blobId leaf to the attachment
 *   bucket is how a Mailtemi message went out as multipart/mixed with an
 *   empty inline text part and its real body behind two
 *   Content-Disposition: attachment parts — "Mail Attachment.txt" and
 *   ".html" in Apple Mail, and no body at all.)
 * - everything else refuses BY NAME: a non-text type with partId content, a
 *   partId posing as an attachment, partId AND blobId on one leaf, a
 *   childless multipart, a tree deeper than MAX_BODY_STRUCTURE_DEPTH.
 */
function flattenBodyStructure(root: unknown, bodyValues: BodyValues): FlattenedBody {
  const textSources: BodySource[] = [];
  const htmlSources: BodySource[] = [];
  const attachments: AttachmentSpec[] = [];

  const walk = (raw: unknown, path: string, depth: number): void => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SetErrorSignal("invalidProperties", `${path} must be an EmailBodyPart`, [path]);
    }
    const part = raw as Record<string, unknown>;
    if (part.type !== undefined && part.type !== null && typeof part.type !== "string") {
      throw new SetErrorSignal("invalidProperties", `${path}/type must be a string`, [`${path}/type`]);
    }
    const declared = typeof part.type === "string" && part.type.trim() !== "" ? part.type.trim().toLowerCase() : null;
    const hasPartId = part.partId !== undefined && part.partId !== null;
    const hasBlobId = part.blobId !== undefined && part.blobId !== null;

    if (declared?.startsWith("multipart/")) {
      if (hasPartId || hasBlobId) {
        throw new SetErrorSignal(
          "invalidProperties",
          `${path}: a ${declared} part carries subParts, not partId/blobId`,
          [path],
        );
      }
      if (depth >= MAX_BODY_STRUCTURE_DEPTH) {
        throw new SetErrorSignal(
          "invalidProperties",
          `bodyStructure nests deeper than ${MAX_BODY_STRUCTURE_DEPTH} levels — not a shape this server will mail`,
          [path],
        );
      }
      const subs = part.subParts;
      if (!Array.isArray(subs) || subs.length === 0) {
        throw new SetErrorSignal(
          "invalidProperties",
          `${path}: a ${declared} part requires a non-empty subParts array`,
          [`${path}/subParts`],
        );
      }
      for (const [i, sub] of subs.entries()) walk(sub, `${path}/subParts/${i}`, depth + 1);
      return;
    }

    // A leaf.
    if (part.subParts !== undefined && part.subParts !== null) {
      throw new SetErrorSignal("invalidProperties", `${path}: subParts is only valid on a multipart/* part`, [
        `${path}/subParts`,
      ]);
    }
    if (hasPartId && hasBlobId) {
      throw new SetErrorSignal(
        "invalidProperties",
        `${path}: a part may carry partId or blobId, not both (RFC 8621 §4.6)`,
        [`${path}/partId`, `${path}/blobId`],
      );
    }
    if (hasBlobId) {
      const spec = parseAttachmentSpec(part, path);
      // Inline-vs-attachment is a function of disposition and tree position,
      // never of where the bytes came from. The RAW part is consulted for
      // the disposition because parseAttachmentSpec defaults an absent one
      // to "attachment" — right for the `attachments` property, but here
      // absence is precisely the body-leaf signal.
      const disp = typeof part.disposition === "string" ? part.disposition.trim().toLowerCase() : "";
      const isBodyLeaf =
        (declared === "text/plain" || declared === "text/html") &&
        (disp === "" || disp === "inline") &&
        spec.cid === null;
      if (isBodyLeaf) {
        (declared === "text/plain" ? textSources : htmlSources).push({ blob: spec });
      } else {
        attachments.push(spec);
      }
      return;
    }
    if (!hasPartId) {
      throw new SetErrorSignal(
        "invalidProperties",
        `${path}: a leaf part requires partId (content in bodyValues) or blobId (uploaded content)`,
        [path],
      );
    }
    if (typeof part.partId !== "string" || part.partId === "") {
      throw new SetErrorSignal("invalidProperties", `${path}/partId must be a non-empty string`, [`${path}/partId`]);
    }
    if (typeof part.disposition === "string" && part.disposition.trim().toLowerCase() === "attachment") {
      // "Authored text, presented as an attached file" is not expressible
      // here (buildMime attaches bytes by reference only) — and quietly
      // inlining it into the body would change what the message says it is.
      throw new SetErrorSignal(
        "invalidProperties",
        `${path}: partId content cannot be sent as an attachment — upload it and reference a blobId`,
        [`${path}/disposition`],
      );
    }
    const type = declared ?? "text/plain";
    if (type !== "text/plain" && type !== "text/html") {
      throw new SetErrorSignal(
        "invalidProperties",
        `${path}: cannot compose a "${type}" part from bodyValues — text/plain and text/html only; other content attaches by blobId`,
        [`${path}/type`],
      );
    }
    const value = requireBodyValue(bodyValues, part.partId, path);
    if (type === "text/plain") textSources.push({ value });
    else htmlSources.push({ value });
  };

  walk(root, "bodyStructure", 0);
  return { textSources, htmlSources, attachments };
}

/**
 * Resolve a flattened bodyStructure into what `buildMime` consumes.
 *
 * Inline body blobs and attachment blobs cross ONE `resolveAttachments` call,
 * so every blob-sourced byte in the create passes the same ownership boundary
 * (a foreign blob is indistinguishable from a nonexistent one) and counts
 * against the same MAX_ATTACHMENT_BYTES_PER_EMAIL ceiling — a body carried
 * by blobId gets no bigger budget than an attachment does.
 */
async function resolveFlattenedBody(
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  flat: FlattenedBody,
): Promise<{ text?: string; html?: string; attachments: ResolvedAttachment[] }> {
  const inline = [...flat.textSources, ...flat.htmlSources].flatMap((s) => ("blob" in s ? [s.blob] : []));
  const resolved = await resolveAttachments(store, access, [...inline, ...flat.attachments]);
  const bytes = new Map<AttachmentSpec, Uint8Array>();
  inline.forEach((spec, i) => bytes.set(spec, (resolved[i] as ResolvedAttachment).mime.content));

  const render = (sources: BodySource[]) =>
    sources.map((s) => ("blob" in s ? decodeInlineTextBlob(bytes.get(s.blob) as Uint8Array, s.blob) : s.value));
  // Same joins partId content has always used — a blob-carried paragraph
  // concatenates with its partId siblings in document order.
  const texts = render(flat.textSources);
  const htmls = render(flat.htmlSources);
  return {
    ...(texts.length > 0 ? { text: texts.join("\n\n") } : {}),
    ...(htmls.length > 0 ? { html: htmls.join("\n") } : {}),
    attachments: resolved.slice(inline.length),
  };
}

/**
 * Decode an inline body leaf's uploaded bytes into the string `buildMime`
 * will re-encode as UTF-8. The leaf's `charset` names the encoding of the
 * uploaded bytes (absent → UTF-8). A label this runtime cannot decode
 * REFUSES by name: mojibake mailed as the user's own words is body
 * corruption, the failure class this path exists to kill — a client that
 * means "ship these bytes untouched" says disposition: "attachment".
 */
function decodeInlineTextBlob(content: Uint8Array, spec: AttachmentSpec): string {
  const label = spec.charset ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new SetErrorSignal(
      "invalidProperties",
      `${spec.path}: cannot decode charset "${label}" for an inline body part — upload it as UTF-8, or attach it with disposition "attachment"`,
      [`${spec.path}/charset`],
    );
  }
  return decoder.decode(content);
}

function fromJmapAddresses(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ name?: string | null; email?: string }>)
    .filter((a) => typeof a.email === "string")
    .map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.email as string }));
}
