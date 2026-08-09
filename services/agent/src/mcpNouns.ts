import {
  callJmap,
  tookCreate,
  tookDestroy,
  tookUpdate,
  ToolError,
  type JmapSetResponse,
} from "./jmapBridge.js";
import type { ToolDef } from "./mcp.js";

/**
 * Calendar + Contacts CRUD over MCP — sVOL unit `013`, the first write
 * surface MCP has ever had.
 *
 * Every tool maps onto a JMAP method that already exists; none of them
 * invents a parallel vocabulary, and none of them touches D1 directly (see
 * `jmapBridge.ts` for why that is not negotiable).
 *
 *   calendar_list            Calendar/get
 *   calendar_query_events    CalendarEvent/query + /get (+ /getOccurrences)
 *   calendar_create_event    CalendarEvent/set   create
 *   calendar_update_event    CalendarEvent/set   update
 *   calendar_delete_event    CalendarEvent/set   destroy
 *   contacts_list_books      AddressBook/get
 *   contacts_search          ContactCard/query + /get
 *   contacts_create_card     ContactCard/set     create
 *   contacts_update_card     ContactCard/set     update
 *   contacts_delete_card     ContactCard/set     destroy
 *
 * ## Scopes
 *
 * Mirrored from the live JMAP convention (`_context.md` §4), NOT invented:
 * calendar reads take `("read","calendar")` and calendar writes take
 * `("calendar","calendar")`; contacts reads take `("read","contacts")` and
 * contacts writes `("contacts","contacts")`. Calendar and contacts do not
 * use the mail lattice — ONE scope named after the domain covers create,
 * update *and* delete. The consequence is real and is not this unit's to
 * fix: an agent granted `calendar` so it can add events can also destroy
 * them, and no finer grant exists.
 *
 * ## Shape of the arguments
 *
 * The underlying methods speak JSCalendar (RFC 8984) and JSContact
 * (RFC 9553) — nested objects keyed by arbitrary ids. Handing a model a
 * "pass a JSCalendar blob" parameter reliably produces malformed blobs, so
 * these tools take flat, named, described fields and assemble the object.
 * Anything past these fields is a JMAP call, not a tool call, and the
 * descriptions say so.
 */

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError(`${key} is required and must be a non-empty string.`);
  }
  return v;
}

/** `ifInState` gives an agent optimistic concurrency across two calls. */
const ifInState = (args: Record<string, unknown>): Record<string, unknown> =>
  str(args.ifInState) ? { ifInState: args.ifInState } : {};

const dropNulls = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

// ---- calendar --------------------------------------------------------------

const LOCAL_DATE_TIME = 'LocalDateTime, no offset and no trailing "Z" (e.g. "2026-11-26T17:00:00")';

/**
 * Flat tool arguments → JSCalendar Event properties. The keys this produces
 * are top-level property names, which makes the same object valid both as a
 * `create` spec and as an RFC 8620 §5.3 PatchObject for `update`.
 */
function eventFields(args: Record<string, unknown>, withUid: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["title", "start", "duration", "timeZone", "description", "showWithoutTime"]) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  if (withUid && args.uid !== undefined) out.uid = args.uid;
  if (args.recurrenceRules !== undefined) out.recurrenceRules = args.recurrenceRules;
  if (args.location !== undefined) {
    out.locations =
      args.location === null
        ? null
        : { loc1: { "@type": "Location", name: String(args.location) } };
  }
  if (args.calendarId !== undefined) {
    out.calendarIds = { [String(args.calendarId)]: true };
  }
  return out;
}

const EVENT_PROPS = {
  title: { type: "string", description: "Event summary, e.g. \"Dentist\"." },
  start: { type: "string", description: `Local start time — ${LOCAL_DATE_TIME}.` },
  duration: { type: "string", description: 'ISO 8601 duration, e.g. "PT1H" or "P1D".' },
  timeZone: { type: "string", description: 'IANA zone, e.g. "America/New_York". Omit for a floating time.' },
  description: { type: "string", description: "Longer notes on the event." },
  location: { type: "string", description: "A single named location." },
  showWithoutTime: { type: "boolean", description: "true for an all-day event." },
  recurrenceRules: {
    type: "array",
    description:
      "JSCalendar recurrence rules, e.g. [{\"frequency\":\"weekly\"}]. This server refuses any " +
      "rule it cannot expand exactly (it will not store approximate dates), so keep them simple: " +
      "frequency plus optional interval, byMonthDay, count or until.",
    items: { type: "object" },
  },
} as const;

const CALENDAR_TOOLS: ToolDef[] = [
  {
    name: "calendar_list",
    scope: "read",
    domain: "calendar",
    description:
      "List the account's calendars (id, name, colour, which is the default). Call this first " +
      "when you need a calendarId; every other calendar tool defaults to the default calendar.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "bullmoose account id" },
        ids: { type: "array", items: { type: "string" }, description: "restrict to these calendar ids" },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      return callJmap(env, principal, "Calendar/get", {
        accountId: requireString(args, "accountId"),
        ...(Array.isArray(args.ids) ? { ids: args.ids } : {}),
      });
    },
  },
  {
    name: "calendar_query_events",
    scope: "read",
    domain: "calendar",
    description:
      "Find events and read them back in full. Filters: inCalendar, uid, after/before (UTC " +
      'ISO instants, e.g. "2026-11-01T00:00:00Z"), text, title — no others are accepted. ' +
      "When both after and before are given the reply also carries `occurrences`: the concrete " +
      "expanded occurrences in that window, which is what to read for \"what is on my calendar\" " +
      "questions, because a recurring event appears in `events` only once. (Occurrence expansion " +
      "is a bullmoose extension — CalendarEvent/getOccurrences — not portable JMAP.)",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        inCalendar: { type: "string", description: "calendar id from calendar_list" },
        uid: { type: "string" },
        after: { type: "string", description: "UTC instant; window start" },
        before: { type: "string", description: "UTC instant; window end" },
        text: { type: "string", description: "free-text match over title and description" },
        title: { type: "string" },
        limit: { type: "number", description: "max events (default 50, max 200)" },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const filter: Record<string, unknown> = {};
      for (const k of ["inCalendar", "uid", "after", "before", "text", "title"]) {
        if (str(args[k])) filter[k] = args[k];
      }
      const limit = clamp(args.limit, 50, 1, 200);
      const query = await callJmap<{ ids: string[]; queryState: string; total?: number }>(
        env,
        principal,
        "CalendarEvent/query",
        {
          accountId,
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
          limit,
          calculateTotal: true,
        },
      );
      const got = await callJmap<{ list: Record<string, unknown>[] }>(
        env,
        principal,
        "CalendarEvent/get",
        { accountId, ids: query.ids },
      );
      const windowed = str(args.after) && str(args.before);
      const occurrences = windowed
        ? await callJmap<{ list: Record<string, unknown>[]; total: number }>(
            env,
            principal,
            "CalendarEvent/getOccurrences",
            { accountId, after: args.after, before: args.before, ids: query.ids },
          )
        : null;
      return {
        accountId,
        queryState: query.queryState,
        total: query.total,
        events: got.list,
        ...(occurrences ? { occurrences: occurrences.list } : {}),
      };
    },
  },
  {
    name: "calendar_create_event",
    scope: "calendar",
    domain: "calendar",
    description:
      "Create one event. Returns its id and the new state string, which you can pass back as " +
      "ifInState on a follow-up call for optimistic concurrency. Goes in the default calendar " +
      "unless calendarId is given.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        calendarId: { type: "string", description: "from calendar_list; omit for the default calendar" },
        ...EVENT_PROPS,
        uid: { type: "string", description: "iCalendar UID; omit and the server assigns one" },
        ifInState: { type: "string", description: "state string from a previous call" },
      },
      required: ["accountId", "title", "start"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      requireString(args, "title");
      requireString(args, "start");
      const res = await callJmap<JmapSetResponse>(env, principal, "CalendarEvent/set", {
        accountId,
        ...ifInState(args),
        create: { c1: dropNulls(eventFields(args, true)) },
      });
      return tookCreate(res, "c1", "The event");
    },
  },
  {
    name: "calendar_update_event",
    scope: "calendar",
    domain: "calendar",
    description:
      "Change one existing event. Only the fields you pass are touched; pass null to clear an " +
      "optional one. uid is immutable — to move an event to another calendar pass calendarId.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        eventId: { type: "string", description: "id from calendar_query_events" },
        calendarId: { type: "string", description: "move the event to this calendar" },
        ...EVENT_PROPS,
        ifInState: { type: "string" },
      },
      required: ["accountId", "eventId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const eventId = requireString(args, "eventId");
      const patch = eventFields(args, false);
      if (Object.keys(patch).length === 0) {
        throw new ToolError(
          "Nothing to update: pass at least one of title, start, duration, timeZone, " +
            "description, location, showWithoutTime, recurrenceRules or calendarId.",
        );
      }
      const res = await callJmap<JmapSetResponse>(env, principal, "CalendarEvent/set", {
        accountId,
        ...ifInState(args),
        update: { [eventId]: patch },
      });
      return tookUpdate(res, eventId, "The event");
    },
  },
  {
    name: "calendar_delete_event",
    scope: "calendar",
    domain: "calendar",
    description:
      "Delete one event permanently. There is no trash and no undo — confirm with the human " +
      "first. Deleting a recurring event removes every occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        eventId: { type: "string" },
        ifInState: { type: "string" },
      },
      required: ["accountId", "eventId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const eventId = requireString(args, "eventId");
      const res = await callJmap<JmapSetResponse>(env, principal, "CalendarEvent/set", {
        accountId,
        ...ifInState(args),
        destroy: [eventId],
      });
      return tookDestroy(res, eventId, "The event");
    },
  },
];

// ---- contacts --------------------------------------------------------------

/**
 * Flat tool arguments → JSContact Card properties. Same trick as
 * `eventFields`: every key is a top-level property, so one builder serves
 * `create` and `update` alike. The map ids (`e1`, `p1`, …) are arbitrary
 * per RFC 9553; contacts-core's vCard face reads the values, not the keys.
 */
function cardFields(args: Record<string, unknown>, withUid: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (withUid && args.uid !== undefined) out.uid = args.uid;
  if (args.kind !== undefined) out.kind = args.kind;
  if (args.name !== undefined) {
    out.name = args.name === null ? null : { "@type": "Name", full: String(args.name) };
  }
  if (args.nickname !== undefined) {
    out.nicknames =
      args.nickname === null
        ? null
        : { n1: { "@type": "Nickname", name: String(args.nickname) } };
  }
  if (args.organization !== undefined) {
    out.organizations =
      args.organization === null
        ? null
        : { o1: { "@type": "Organization", name: String(args.organization) } };
  }
  if (args.jobTitle !== undefined) {
    out.titles =
      args.jobTitle === null ? null : { t1: { "@type": "Title", name: String(args.jobTitle) } };
  }
  if (args.note !== undefined) {
    out.notes = args.note === null ? null : { no1: { "@type": "Note", note: String(args.note) } };
  }
  if (args.emails !== undefined) {
    out.emails = mapEntries(args.emails, "e", (v) => ({ "@type": "EmailAddress", address: v }));
  }
  if (args.phones !== undefined) {
    out.phones = mapEntries(args.phones, "p", (v) => ({ "@type": "Phone", number: v }));
  }
  if (args.addressBookId !== undefined) {
    out.addressBookIds = { [String(args.addressBookId)]: true };
  }
  return out;
}

function mapEntries(
  raw: unknown,
  prefix: string,
  make: (v: string) => Record<string, unknown>,
): Record<string, unknown> | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new ToolError(`Expected an array of strings, got ${typeof raw}.`);
  }
  const out: Record<string, unknown> = {};
  raw.forEach((v, i) => {
    if (typeof v !== "string" || v.length === 0) return;
    out[`${prefix}${i + 1}`] = make(v);
  });
  return out;
}

const CARD_PROPS = {
  name: { type: "string", description: 'Full display name, e.g. "Ada Lovelace".' },
  nickname: { type: "string" },
  organization: { type: "string", description: "Company or organisation name." },
  jobTitle: { type: "string" },
  emails: { type: "array", items: { type: "string" }, description: "Email addresses, most-used first." },
  phones: { type: "array", items: { type: "string" }, description: "Phone numbers, most-used first." },
  note: { type: "string" },
} as const;

const CONTACT_TOOLS: ToolDef[] = [
  {
    name: "contacts_list_books",
    scope: "read",
    domain: "contacts",
    description:
      "List the account's address books (id, name, which is the default). Call this first when " +
      "you need an addressBookId; the card tools default to the default book.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      return callJmap(env, principal, "AddressBook/get", {
        accountId: requireString(args, "accountId"),
        ...(Array.isArray(args.ids) ? { ids: args.ids } : {}),
      });
    },
  },
  {
    name: "contacts_search",
    scope: "read",
    domain: "contacts",
    description:
      "Find contact cards and read them back in full. Give `text` for a general search, or narrow " +
      "with name / email / phone / organization / nickname / uid / inAddressBook / kind. Returns " +
      "JSContact cards; each card's id is what the update and delete tools take.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        text: { type: "string", description: "free-text match across the card" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        organization: { type: "string" },
        nickname: { type: "string" },
        uid: { type: "string" },
        inAddressBook: { type: "string", description: "address book id from contacts_list_books" },
        kind: { type: "string", description: '"individual", "group", "org", ...' },
        limit: { type: "number", description: "max cards (default 50, max 200)" },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const filter: Record<string, unknown> = {};
      for (const k of [
        "text",
        "name",
        "email",
        "phone",
        "organization",
        "nickname",
        "uid",
        "inAddressBook",
        "kind",
      ]) {
        if (str(args[k])) filter[k] = args[k];
      }
      const query = await callJmap<{ ids: string[]; queryState: string; total?: number }>(
        env,
        principal,
        "ContactCard/query",
        {
          accountId,
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
          limit: clamp(args.limit, 50, 1, 200),
          calculateTotal: true,
        },
      );
      const got = await callJmap<{ list: Record<string, unknown>[] }>(
        env,
        principal,
        "ContactCard/get",
        { accountId, ids: query.ids },
      );
      return { accountId, queryState: query.queryState, total: query.total, cards: got.list };
    },
  },
  {
    name: "contacts_create_card",
    scope: "contacts",
    domain: "contacts",
    description:
      "Create one contact card. At least one of name, organization or emails is required, or the " +
      "card has nothing to be listed under. Returns its id and the new state string.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        addressBookId: { type: "string", description: "from contacts_list_books; omit for the default book" },
        ...CARD_PROPS,
        kind: { type: "string", description: '"individual" (default), "group", "org", "location", "device"' },
        uid: { type: "string", description: "vCard UID; omit and the server assigns one" },
        ifInState: { type: "string" },
      },
      required: ["accountId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      if (!str(args.name) && !str(args.organization) && !Array.isArray(args.emails)) {
        throw new ToolError(
          "A card needs at least one of name, organization or emails — otherwise it has no " +
            "display name and will not appear in any contacts client.",
        );
      }
      const res = await callJmap<JmapSetResponse>(env, principal, "ContactCard/set", {
        accountId,
        ...ifInState(args),
        create: { c1: dropNulls(cardFields(args, true)) },
      });
      return tookCreate(res, "c1", "The contact card");
    },
  },
  {
    name: "contacts_update_card",
    scope: "contacts",
    domain: "contacts",
    description:
      "Change one existing contact card. Only the fields you pass are touched; pass null to clear " +
      "an optional one. emails and phones REPLACE the existing list rather than appending — read " +
      "the card with contacts_search first and pass the full list. uid is immutable.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        cardId: { type: "string", description: "id from contacts_search" },
        addressBookId: { type: "string", description: "move the card to this address book" },
        ...CARD_PROPS,
        ifInState: { type: "string" },
      },
      required: ["accountId", "cardId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const cardId = requireString(args, "cardId");
      const patch = cardFields(args, false);
      if (Object.keys(patch).length === 0) {
        throw new ToolError(
          "Nothing to update: pass at least one of name, nickname, organization, jobTitle, " +
            "emails, phones, note or addressBookId.",
        );
      }
      const res = await callJmap<JmapSetResponse>(env, principal, "ContactCard/set", {
        accountId,
        ...ifInState(args),
        update: { [cardId]: patch },
      });
      return tookUpdate(res, cardId, "The contact card");
    },
  },
  {
    name: "contacts_delete_card",
    scope: "contacts",
    domain: "contacts",
    description:
      "Delete one contact card permanently. There is no trash and no undo — confirm with the " +
      "human first.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        cardId: { type: "string" },
        ifInState: { type: "string" },
      },
      required: ["accountId", "cardId"],
    },
    async run({ env, principal }, args) {
      const accountId = requireString(args, "accountId");
      const cardId = requireString(args, "cardId");
      const res = await callJmap<JmapSetResponse>(env, principal, "ContactCard/set", {
        accountId,
        ...ifInState(args),
        destroy: [cardId],
      });
      return tookDestroy(res, cardId, "The contact card");
    },
  },
];

function clamp(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
}

/** Registered into `TOOLS` by `mcp.ts`. */
export const NOUN_TOOLS: ToolDef[] = [...CALENDAR_TOOLS, ...CONTACT_TOOLS];
