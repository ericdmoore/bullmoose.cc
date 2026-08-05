import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import {
  expandOccurrences,
  eventSpan,
  parseLocalDateTime,
  MAX_OCCURRENCES,
} from "@bullmoose/calendar-core";
import type {
  CalendarEventFilterCondition,
  CalendarEventRow,
  CalendarRow,
  JSCalendarEventBlob,
  Mailstore,
} from "@bullmoose/mailstore";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * JSCalendar-on-JMAP (Phase 4): Calendar/get·set·changes and
 * CalendarEvent/get·set·query·changes over JSCalendar (RFC 8984),
 * mirroring the contacts core exactly — blob source of truth, extracted
 * columns (title, UTC outer span, is_recurring), per-calendar ctag for
 * the Phase 5 CalDAV face, commits through the AccountDO changelog.
 *
 * The recurrence/timezone work lives in @bullmoose/calendar-core:
 * expansion is on-demand and capped, never pre-computed. Time-range
 * query filters prefilter on the indexed span, then refine each
 * candidate against its actual occurrences. CalendarEvent/getOccurrences
 * is a bullmoose helper (the calendars spec is still a draft): agents
 * ask "what's on between A and B" and get concrete occurrences back.
 *
 * Writes need the "calendar" scope ("mail" covers). Sharing calendars
 * (shareWith) intentionally waits for the CalDAV face; whole-account
 * grants cover the calendar domain today.
 */

const CAL_SERVER_SET = ["id", "isDefault", "myRights"] as const;

const OWNER_CAL_RIGHTS = {
  mayReadItems: true,
  mayWriteAll: true,
  mayAdmin: true,
  mayDelete: true,
} as const;

export function registerCalendarMethods(registry: MethodRegistry<RequestContext>): void {
  // ---- Calendar --------------------------------------------------------

  registry.register("Calendar/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "calendar");
    const store = storeFor(ctx);
    if (!access.granted) await ensureDefaultCalendar(ctx, store, access.accountId);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const rows = await store.getCalendars(access.accountId, ids);
    const found = new Set(rows.map((r) => r.id));

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map(calendarToJmap),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Calendar/changes", async (args, ctx) => proxyChanges(ctx, args, "Calendar"));

  registry.register("Calendar/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "calendar", "calendar");
    if (access.granted) {
      throw new MethodError("forbidden", "only the account owner manages calendars");
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
    const calEntry: ChangeEntry = { collection: "Calendar", created: [], updated: [], destroyed: [] };
    const evEntry: ChangeEntry = { collection: "CalendarEvent", created: [], updated: [], destroyed: [] };

    const cals = await store.getCalendars(access.accountId);
    const byId = new Map(cals.map((c) => [c.id, c]));
    let hasDefault = cals.some((c) => c.isDefault);

    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const row = validateNewCalendar(spec, !hasDefault);
        await store.insertCalendar(access.accountId, row);
        byId.set(row.id, row);
        if (row.isDefault) hasDefault = true;
        calEntry.created.push(row.id);
        created[cid] = { id: row.id, isDefault: row.isDefault, myRights: OWNER_CAL_RIGHTS };
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }

    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        if (!byId.get(id)) throw new NotFound();
        await store.updateCalendar(access.accountId, id, validateCalendarPatch(patch));
        calEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    const onDestroyRemoveEvents = args.onDestroyRemoveEvents === true;
    let destroyedDefault = false;
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const row = byId.get(id);
        if (!row) throw new NotFound();
        const eventIds = await store.eventIdsInCalendar(access.accountId, id);
        if (eventIds.length > 0 && !onDestroyRemoveEvents) {
          throw new SetErrorSignal("calendarHasEvents");
        }
        await store.destroyCalendarEvents(access.accountId, eventIds);
        evEntry.destroyed.push(...eventIds);
        await store.deleteCalendar(access.accountId, id);
        byId.delete(id);
        if (row.isDefault) destroyedDefault = true;
        calEntry.destroyed.push(id);
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }
    if (destroyedDefault && byId.size > 0) {
      const oldest = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)[0]!;
      await store.setDefaultCalendar(access.accountId, oldest.id);
      if (!calEntry.created.includes(oldest.id)) calEntry.updated.push(oldest.id);
    }

    const newState = await commitCalendarEntries(ctx, access.accountId, [calEntry, evEntry]);
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
  });

  // ---- CalendarEvent ---------------------------------------------------

  registry.register("CalendarEvent/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "calendar");
    const store = storeFor(ctx);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const rows = await store.getCalendarEvents(access.accountId, ids);
    const found = new Set(rows.map((r) => r.id));
    const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;

    const list = rows.map((row) => {
      const full = eventToJmap(row);
      if (!properties) return full;
      const picked: Record<string, unknown> = { id: full.id };
      for (const p of properties) if (p in full) picked[p] = full[p];
      return picked;
    });

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("CalendarEvent/changes", async (args, ctx) =>
    proxyChanges(ctx, args, "CalendarEvent"),
  );

  registry.register("CalendarEvent/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "calendar", "calendar");
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
    const evEntry: ChangeEntry = { collection: "CalendarEvent", created: [], updated: [], destroyed: [] };
    const ctags = new Set<string>();

    const cals = new Map((await store.getCalendars(access.accountId)).map((c) => [c.id, c]));

    // -- create (two-phase like contacts: validate, batch uid check, batch insert) --
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    const pending: Array<{ cid: string; row: CalendarEventRow }> = [];
    const pendingUids = new Set<string>();
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const { id, ...rest } = spec;
        if (id !== undefined) {
          throw new SetErrorSignal("invalidProperties", "id is server-set", ["id"]);
        }
        let calendarId: string;
        if (rest.calendarIds === undefined) {
          calendarId = await ensureDefaultCalendar(ctx, store, access.accountId);
        } else {
          calendarId = singleCalendarId(rest.calendarIds, cals);
        }
        delete rest.calendarIds;

        const event = rest as JSCalendarEventBlob;
        const row = buildEventRow(event, calendarId, null, null);
        if (pendingUids.has(row.uid)) {
          throw new SetErrorSignal("invalidProperties", `uid already in use: ${row.uid}`, ["uid"]);
        }
        pendingUids.add(row.uid);
        pending.push({ cid, row });
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }
    if (pending.length > 0) {
      const taken = await store.calendarEventIdsByUids(
        access.accountId,
        pending.map((p) => p.row.uid),
      );
      const toInsert = pending.filter((p) => {
        if (!taken.has(p.row.uid)) return true;
        notCreated[p.cid] = {
          type: "invalidProperties",
          description: `uid already in use: ${p.row.uid}`,
          properties: ["uid"],
        };
        return false;
      });
      let inserted = toInsert;
      try {
        await store.insertCalendarEvents(access.accountId, inserted.map((p) => p.row));
      } catch {
        inserted = [];
        for (const p of toInsert) {
          try {
            await store.insertCalendarEvents(access.accountId, [p.row]);
            inserted.push(p);
          } catch (err) {
            notCreated[p.cid] = toSetError(err);
          }
        }
      }
      for (const p of inserted) {
        ctags.add(p.row.calendarId);
        evEntry.created.push(p.row.id);
        created[p.cid] = {
          id: p.row.id,
          uid: p.row.uid,
          created: p.row.event.created,
          updated: p.row.event.updated,
        };
      }
    }

    // -- update --
    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const [row] = await store.getCalendarEvents(access.accountId, [id]);
        if (!row) throw new NotFound();
        const patched = applyEventPatch(eventToJmap(row), patch);
        if (patched.id !== row.id) {
          throw new SetErrorSignal("invalidProperties", "id is immutable", ["id"]);
        }
        if (patched.uid !== row.uid) {
          throw new SetErrorSignal("invalidProperties", "uid is immutable", ["uid"]);
        }
        const calendarId = singleCalendarId(patched.calendarIds, cals);
        const event = { ...patched } as JSCalendarEventBlob;
        delete (event as Record<string, unknown>).id;
        const next = buildEventRow(event, calendarId, row.id, row);
        await store.updateCalendarEvent(access.accountId, next);
        ctags.add(row.calendarId);
        ctags.add(calendarId);
        evEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    // -- destroy --
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const [row] = await store.getCalendarEvents(access.accountId, [id]);
        if (!row) throw new NotFound();
        await store.destroyCalendarEvents(access.accountId, [id]);
        ctags.add(row.calendarId);
        evEntry.destroyed.push(id);
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }

    await store.bumpCalendarCtags(access.accountId, ctags);
    const newState = await commitCalendarEntries(ctx, access.accountId, [evEntry]);
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
  });

  registry.register("CalendarEvent/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "calendar");
    const store = storeFor(ctx);

    const filter = (args.filter as CalendarEventFilterCondition | null | undefined) ?? null;
    if (filter) {
      for (const key of Object.keys(filter)) {
        if (!["inCalendar", "uid", "after", "before", "text", "title"].includes(key)) {
          throw new MethodError("unsupportedFilter", `unknown filter property "${key}"`);
        }
      }
    }
    const sort = validateEventSort(args.sort);

    const result = await store.queryCalendarEvents(access.accountId, {
      filter,
      sort,
      position: typeof args.position === "number" ? args.position : 0,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      calculateTotal: args.calculateTotal === true,
    });

    // Time-range refinement: the indexed span can over-include (sparse
    // recurrences) — check real occurrences for windowed queries.
    let ids = result.ids;
    if (filter && (filter.after !== undefined || filter.before !== undefined)) {
      const after = filter.after !== undefined ? Date.parse(filter.after) : undefined;
      const before = filter.before !== undefined ? Date.parse(filter.before) : undefined;
      const rows = await store.getCalendarEvents(access.accountId, ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      ids = ids.filter((id) => {
        const row = byId.get(id);
        if (!row) return false;
        if (!row.isRecurring) return true; // span == the single occurrence
        return expandOccurrences(row.event, { after, before, maxOccurrences: 1 }).length > 0;
      });
    }

    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position: result.position,
      ids,
      ...(args.calculateTotal === true ? { total: result.total ?? 0 } : {}),
    };
  });

  registry.register("CalendarEvent/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });

  /**
   * bullmoose helper (draft spec has no finished shape for this):
   * concrete occurrences over a window, expanded server-side. Args:
   * accountId, after, before (UTCDates, required), ids? (restrict to
   * events), maxOccurrences?. Returns occurrences sorted by start.
   */
  registry.register("CalendarEvent/getOccurrences", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "calendar");
    const store = storeFor(ctx);

    const after = typeof args.after === "string" ? Date.parse(args.after) : NaN;
    const before = typeof args.before === "string" ? Date.parse(args.before) : NaN;
    if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after) {
      throw new MethodError("invalidArguments", "after and before (UTCDates, after < before) required");
    }
    const cap = Math.min(
      typeof args.maxOccurrences === "number" ? args.maxOccurrences : 200,
      MAX_OCCURRENCES,
    );

    let rows;
    if (Array.isArray(args.ids)) {
      rows = await store.getCalendarEvents(access.accountId, args.ids as string[]);
    } else {
      const candidates = await store.queryCalendarEvents(access.accountId, {
        filter: {
          after: new Date(after).toISOString(),
          before: new Date(before).toISOString(),
          ...(typeof args.inCalendar === "string" ? { inCalendar: args.inCalendar } : {}),
        },
        limit: 256,
      });
      rows = await store.getCalendarEvents(access.accountId, candidates.ids);
    }

    const list: Record<string, unknown>[] = [];
    for (const row of rows) {
      for (const occ of expandOccurrences(row.event, { after, before, maxOccurrences: cap })) {
        list.push({
          eventId: row.id,
          calendarId: row.calendarId,
          uid: row.uid,
          recurrenceId: occ.recurrenceId,
          start: occ.start,
          utcStart: new Date(occ.startMs).toISOString(),
          utcEnd: new Date(occ.endMs).toISOString(),
          title: occ.title ?? row.title,
          showWithoutTime: row.event.showWithoutTime === true,
        });
      }
    }
    list.sort((a, b) => String(a.utcStart).localeCompare(String(b.utcStart)));
    return {
      accountId: access.accountId,
      list: list.slice(0, cap),
      total: list.length,
    };
  });
}

// ---- helpers ---------------------------------------------------------------

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
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

function calendarToJmap(r: CalendarRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    sortOrder: r.sortOrder,
    isDefault: r.isDefault,
    isSubscribed: r.isSubscribed,
    myRights: OWNER_CAL_RIGHTS,
  };
}

function eventToJmap(row: CalendarEventRow): Record<string, unknown> {
  return { ...row.event, id: row.id, calendarIds: { [row.calendarId]: true } };
}

/** Validate + normalize a JSCalendar event, extract indexed columns. */
function buildEventRow(
  event: JSCalendarEventBlob,
  calendarId: string,
  existingId: string | null,
  existing: CalendarEventRow | null,
): CalendarEventRow {
  event["@type"] = "Event";
  if (event.uid === undefined) event.uid = `urn:uuid:${crypto.randomUUID()}`;
  if (typeof event.uid !== "string" || event.uid.length === 0) {
    throw new SetErrorSignal("invalidProperties", "uid must be a non-empty string", ["uid"]);
  }
  if (typeof event.start !== "string" || !parseLocalDateTime(event.start)) {
    throw new SetErrorSignal(
      "invalidProperties",
      'start must be a LocalDateTime ("2026-07-08T09:00:00")',
      ["start"],
    );
  }
  if (event.timeZone !== undefined && event.timeZone !== null && typeof event.timeZone !== "string") {
    throw new SetErrorSignal("invalidProperties", "timeZone must be an IANA zone string", ["timeZone"]);
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  if (typeof event.created !== "string" || Number.isNaN(Date.parse(event.created as string))) {
    event.created = existing?.event.created ?? nowIso;
  }
  event.updated = nowIso;
  event.calendarIds = { [calendarId]: true };

  let span;
  try {
    span = eventSpan(event);
  } catch (err) {
    throw new SetErrorSignal("invalidProperties", `recurrence expansion failed: ${String(err)}`, [
      "recurrenceRules",
    ]);
  }

  return {
    id: existingId ?? `ev_${crypto.randomUUID()}`,
    calendarId,
    uid: event.uid,
    event,
    title: typeof event.title === "string" ? event.title : null,
    startAt: span.startMs,
    endAt: span.endMs,
    isRecurring: span.isRecurring,
    davName: existing?.davName ?? null,
    createdAt: existing?.createdAt ?? Date.parse(event.created as string) ?? now,
    updatedAt: now,
  };
}

function validateNewCalendar(spec: Record<string, unknown>, becomeDefault: boolean): CalendarRow {
  for (const p of CAL_SERVER_SET) {
    if (spec[p] !== undefined) {
      throw new SetErrorSignal("invalidProperties", `${p} is server-set`, [p]);
    }
  }
  const name = spec.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    throw new SetErrorSignal("invalidProperties", "name must be a 1..255-char string", ["name"]);
  }
  const now = Date.now();
  return {
    id: `cal_${crypto.randomUUID()}`,
    name,
    description: typeof spec.description === "string" ? spec.description : null,
    color: typeof spec.color === "string" ? spec.color : null,
    sortOrder:
      typeof spec.sortOrder === "number" && Number.isInteger(spec.sortOrder) && spec.sortOrder >= 0
        ? spec.sortOrder
        : 0,
    isDefault: becomeDefault,
    isSubscribed: spec.isSubscribed !== false,
    ctag: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function validateCalendarPatch(patch: Record<string, unknown>): {
  name?: string;
  description?: string | null;
  color?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
} {
  const out: ReturnType<typeof validateCalendarPatch> = {};
  for (const [path, value] of Object.entries(patch)) {
    switch (path) {
      case "name":
        if (typeof value !== "string" || value.length === 0 || value.length > 255) {
          throw new SetErrorSignal("invalidProperties", "name must be a 1..255-char string", ["name"]);
        }
        out.name = value;
        break;
      case "description":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "description must be a string or null", [path]);
        }
        out.description = value as string | null;
        break;
      case "color":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "color must be a string or null", [path]);
        }
        out.color = value as string | null;
        break;
      case "sortOrder":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new SetErrorSignal("invalidProperties", "sortOrder must be an unsigned int", [path]);
        }
        out.sortOrder = value;
        break;
      case "isSubscribed":
        if (typeof value !== "boolean") {
          throw new SetErrorSignal("invalidProperties", "isSubscribed must be a boolean", [path]);
        }
        out.isSubscribed = value;
        break;
      default:
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
    }
  }
  return out;
}

function singleCalendarId(raw: unknown, cals: Map<string, CalendarRow>): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetErrorSignal("invalidProperties", "calendarIds must be an Id[Boolean] object", [
      "calendarIds",
    ]);
  }
  const ids = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (ids.length !== 1) {
    throw new SetErrorSignal(
      "invalidProperties",
      "this server supports exactly one calendar per event",
      ["calendarIds"],
    );
  }
  const id = ids[0]!;
  if (!cals.has(id)) {
    throw new SetErrorSignal("invalidProperties", `no such calendar: ${id}`, ["calendarIds"]);
  }
  return id;
}

async function ensureDefaultCalendar(
  ctx: RequestContext,
  store: Mailstore,
  accountId: string,
): Promise<string> {
  const { id, change } = await store.ensureDefaultCalendar(accountId);
  if (change) {
    const entry =
      change === "created"
        ? { collection: "Calendar", created: [id] }
        : { collection: "Calendar", updated: [id] };
    await commitChanges(ctx.env.ACCOUNT_DO, accountId, [entry]);
  }
  return id;
}

async function commitCalendarEntries(
  ctx: RequestContext,
  accountId: string,
  entries: ChangeEntry[],
): Promise<string> {
  const nonEmpty = entries.filter((e) => e.created.length + e.updated.length + e.destroyed.length > 0);
  if (nonEmpty.length === 0) return accountState(ctx, accountId);
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, nonEmpty);
  return newState;
}

/** RFC 8620 §5.3 PatchObject against the wire event shape. */
function applyEventPatch(
  obj: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(obj);
  for (const [path, value] of Object.entries(patch)) {
    const tokens = path.split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (tokens.length === 0 || tokens.some((t) => t.length === 0)) {
      throw new SetErrorSignal("invalidProperties", `bad patch path "${path}"`, [path]);
    }
    let parent: Record<string, unknown> = out;
    for (const t of tokens.slice(0, -1)) {
      const next = parent[t];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new SetErrorSignal("invalidProperties", `patch path "${path}" does not exist`, [path]);
      }
      parent = next as Record<string, unknown>;
    }
    const leaf = tokens[tokens.length - 1]!;
    if (value === null) delete parent[leaf];
    else parent[leaf] = value;
  }
  return out;
}

function validateEventSort(
  raw: unknown,
): Array<{ property: "start" | "updated" | "created"; isAscending: boolean }> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new MethodError("unsupportedSort", "sort must be an array");
  return raw.map((s) => {
    const property = (s as { property?: unknown }).property;
    if (property !== "start" && property !== "updated" && property !== "created") {
      throw new MethodError("unsupportedSort", `unsupported sort property "${String(property)}"`);
    }
    return { property, isAscending: (s as { isAscending?: unknown }).isAscending !== false };
  });
}
