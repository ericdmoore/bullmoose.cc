import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, type RequestContext } from "./common";

/**
 * Annotation (urn:bullmoose:params:jmap:agent) — the agent-commentary noun
 * (s18 A1). An Annotation is a CLAIM ABOUT a message that you adjudicate, the
 * medium.com-style margin comment: anchored to a span, carrying a class
 * (commitment | decision | task), a confidence, and a status you move.
 *
 * It is the sibling of Note, and the split is the whole point (s18 devPlan):
 * a Note is a document you AUTHOR (edit, share, federate); an Annotation is a
 * claim you JUDGE. So the verbs here are not "edit" —
 *
 *   create   → file a claim (agent extraction, or a human filing one)
 *   resolve  → it came true / was handled (a kept commitment, a done task)
 *   dismiss  → "not a real one" — the LABELED NEGATIVE the extractor learns
 *              from (s12's rescue→Bayes correction shape, one realm over)
 *   read     → get/query, the Waiting-on / Commitments views (A4) run over this
 *
 * Two invariants make it honest:
 *   - EVERY annotation is anchored. An un-anchored claim is the anti-Clippy
 *     failure ("no comment without an object", s20 T4) — refused here, and
 *     NOT NULL in the schema.
 *   - A correction does NOT rewrite the claim. `set` update moves `status`
 *     only; the agent's `body`/`class`/`anchor` stand as the record of what it
 *     asserted, so "the agent was wrong" survives as history and as training
 *     data rather than being edited into agreement.
 */

interface AnnotationRow {
  id: string;
  account_id: string;
  author_kind: string;
  author: string;
  anchor_json: string;
  class: string;
  body: string;
  confidence: number | null;
  status: string;
  rationale: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
}

const CLASS_TYPES = new Set(["commitment", "decision", "task"]);
/** The transitions a client may make. `open` is the birth state (create only);
 *  a claim closes forward, to exactly one of these, and does not reopen. */
const CLOSE_STATUSES = new Set(["resolved", "dismissed"]);

function toJmap(r: AnnotationRow): Record<string, unknown> {
  return {
    id: r.id,
    authorKind: r.author_kind,
    author: r.author,
    anchor: safeJson(r.anchor_json),
    class: r.class,
    body: r.body,
    confidence: r.confidence,
    status: r.status,
    rationale: r.rationale,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function registerAnnotationMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Annotation/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    let rows: AnnotationRow[];
    if (ids === undefined) {
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM annotations WHERE account_id = ? ORDER BY created_at DESC LIMIT 256`)
          .bind(access.accountId)
          .all<AnnotationRow>()
      ).results;
    } else if (ids.length === 0) {
      rows = [];
    } else {
      const marks = ids.map(() => "?").join(",");
      rows = (
        await ctx.env.DB.prepare(`SELECT * FROM annotations WHERE account_id = ? AND id IN (${marks})`)
          .bind(access.accountId, ...ids)
          .all<AnnotationRow>()
      ).results;
    }
    const found = new Set(rows.map((r) => r.id));
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: rows.map(toJmap),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("Annotation/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    const filter = (args.filter as { class?: string; status?: string; objectId?: string } | null | undefined) ?? null;
    // Default view is OPEN claims — "what does the agent think is live", not a
    // graveyard of decided ones. A terminal status is asked for explicitly,
    // exactly as Watch/query defaults to armed.
    const where = ["account_id = ?"];
    const binds: unknown[] = [access.accountId];
    where.push("status = ?");
    binds.push(typeof filter?.status === "string" ? filter.status : "open");
    if (typeof filter?.class === "string") {
      where.push("class = ?");
      binds.push(filter.class);
    }
    if (typeof filter?.objectId === "string") {
      // The anchor's object, matched over the JSON — the same LIKE shape the
      // agent worker uses on from_json/condition_json. An objectId is opaque,
      // so a false match is not a real risk.
      where.push("anchor_json LIKE ?");
      binds.push(`%"objectId":"${filter.objectId}"%`);
    }
    const rows = (
      await ctx.env.DB.prepare(
        `SELECT id FROM annotations WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 256`,
      )
        .bind(...binds)
        .all<{ id: string }>()
    ).results;
    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      ids: rows.map((r) => r.id),
    };
  });

  registry.register("Annotation/set", async (args, ctx) => {
    // A write over the account's own mail commentary — `annotate`, the lightest
    // mail-write verb, the same gate Watch/set uses. An annotation IS a flag on
    // a message, morally.
    const access = await requireAccount(ctx, args, "annotate");
    // Provenance: an agent binding drove this (the s03 bridge) → author is the
    // binding and a confidence is meaningful; a human filing a claim is the
    // author and files at no stated confidence (it is true because they said so).
    const isAgent = !!ctx.agent?.binding;
    const authorKind = isAgent ? "agent" : "human";
    const author = isAgent ? (ctx.agent!.binding as string) : ctx.principal.username;

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, { type: string; description?: string }> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, { type: string; description?: string }> = {};
    const entry: ChangeEntry = {
      collection: "Annotation",
      created: [],
      updated: [],
      destroyed: [],
    };
    const now = Date.now();

    // ---- create ----
    const createSpec = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpec)) {
      const anchor = spec.anchor as { realm?: unknown; objectId?: unknown } | undefined;
      // The invariant, at the door: no anchor, no annotation.
      if (!anchor || typeof anchor.realm !== "string" || typeof anchor.objectId !== "string") {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "anchor {realm, objectId} is required — an annotation is always about something",
        };
        continue;
      }
      const cls = String(spec.class ?? "");
      if (!CLASS_TYPES.has(cls)) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: `class must be one of ${[...CLASS_TYPES].join(" | ")}`,
        };
        continue;
      }
      const body = typeof spec.body === "string" ? spec.body.trim() : "";
      if (!body) {
        notCreated[cid] = {
          type: "invalidProperties",
          description: "body (the claim) is required",
        };
        continue;
      }
      const confidence = isAgent && Number.isFinite(Number(spec.confidence)) ? Number(spec.confidence) : null;
      const id = `an_${crypto.randomUUID()}`;
      await ctx.env.DB.prepare(
        `INSERT INTO annotations
           (id, account_id, author_kind, author, anchor_json, class, body,
            confidence, status, rationale, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
        .bind(
          id,
          access.accountId,
          authorKind,
          author,
          JSON.stringify(anchor),
          cls,
          body,
          confidence,
          typeof spec.rationale === "string" ? spec.rationale : null,
          typeof spec.sourceRef === "string" ? spec.sourceRef : null,
          now,
          now,
        )
        .run();
      created[cid] = { id, status: "open" };
      entry.created.push(id);
    }

    // ---- update: close forward only (resolve | dismiss) ----
    const updateSpec = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpec)) {
      const keys = Object.keys(patch);
      // A correction is a STATUS move, never a rewrite: the agent's claim is the
      // record. Any other field in the patch is refused rather than silently
      // dropped, so a client never believes it edited a body it did not.
      if (keys.some((k) => k !== "status")) {
        notUpdated[id] = {
          type: "invalidProperties",
          description:
            "an annotation's claim is immutable — set `status` (resolved | dismissed); you do not rewrite it",
        };
        continue;
      }
      const status = String(patch.status ?? "");
      if (!CLOSE_STATUSES.has(status)) {
        notUpdated[id] = {
          type: "invalidProperties",
          description: `status must be ${[...CLOSE_STATUSES].join(" | ")}`,
        };
        continue;
      }
      // Guarded on 'open': a claim closes once. Re-deciding a resolved/dismissed
      // one would rewrite a judgment already recorded (and, for `dismissed`, a
      // training signal already emitted).
      const res = await ctx.env.DB.prepare(
        `UPDATE annotations SET status = ?, updated_at = ? WHERE account_id = ? AND id = ? AND status = 'open'`,
      )
        .bind(status, now, access.accountId, id)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        notUpdated[id] = {
          type: "invalidProperties",
          description: "no open annotation with that id (already resolved, dismissed or unknown)",
        };
        continue;
      }
      updated[id] = null;
      entry.updated.push(id);
    }

    const oldState = await accountState(ctx, access.accountId);
    if (entry.created.length + entry.updated.length > 0) {
      await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, [entry]);
    }
    return {
      accountId: access.accountId,
      oldState,
      newState: await accountState(ctx, access.accountId),
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed: [],
      notDestroyed: {},
    };
  });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
