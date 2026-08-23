import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
import { accountState, requireAccount, type RequestContext } from "./common";

/**
 * DeviceReport (s37 T1a) — what a device says about itself.
 *
 * A named token IS a registered device (`tokens.name`, `last_used_at`); this
 * type is the device's SELF-DESCRIPTION: the model host it found, the models
 * that host serves, the capabilities it declares. The reporters land in T1b
 * (`local setup`/`connect` and the daemon on start — all Go, one home); this
 * half is reporter-agnostic on purpose, because it is the half with the
 * schema decision in it and "the half that is wrong to guess at twice".
 *
 * The three rules, from the section's decisions:
 *
 *   BOUND TO THE AUTHENTICATED TOKEN. `/set` updates the singleton `self` —
 *   there is no way to name a token in the arguments, so one device cannot
 *   write another's report. The binding comes from `principal.tokenId`,
 *   which only the bearer path stamps; a credential without a token (OAuth,
 *   dev bootstrap) is refused, because a report from "nobody in particular"
 *   is exactly the row this table must not hold.
 *
 *   DISPLAY-ONLY (decision 4). Nothing routes on a self-report. The moment
 *   the server routes on a self-reported capability, a wrong report becomes
 *   a wrong decision rather than a wrong label. (s33 note: with a second
 *   human, a report becomes one user's claim that another may read — the
 *   trust seam is THERE, not here.)
 *
 *   OWNER-ONLY READS. `/get` joins the caller's own tokens with their
 *   reports — the whole T2 read model in one call: every device, its last
 *   use, and what it last said it serves ("as of", never "installed").
 *   A grant-reached caller is refused (your devices are not part of what a
 *   mail grant shares), and an agent-marked token cannot enumerate the
 *   owner's machines.
 *
 * No session capability is advertised for this type yet: the T1b reporter
 * feature-detects by calling and treating `unknownMethod` as "server
 * predates s37" — the DefaultCase rule from the claim loop, reused.
 */

/** Bounds: a report is a label, not a payload. */
const MAX_REPORT_BYTES = 32 * 1024;
const MAX_MODELS = 256;
const MAX_STRING = 512;

export function registerDeviceReportMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("DeviceReport/set", async (args, ctx) => {
    // `read` is deliberately the floor: any device that may read mail may
    // describe itself. What it may NOT do is speak for anyone else — that is
    // the tokenId binding below, not a scope.
    const access = await requireAccount(ctx, args, "read");
    const tokenId = ctx.principal.tokenId;
    if (!tokenId) {
      throw new MethodError("forbidden", "device reports bind to a minted device token; this credential carries none");
    }

    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    const keys = Object.keys(update);
    if (keys.length !== 1 || !update.self) {
      // The singleton is the WHOLE authorization story for writes: a client
      // that could name a key could name another device.
      throw new MethodError("invalidArguments", "DeviceReport/set updates the singleton `self`");
    }
    const report = sanitizeReport(update.self);

    const now = Date.now();
    await ctx.env.DB.prepare(
      `INSERT INTO device_reports (token_id, report_json, reported_at)
       VALUES (?, ?, ?)
       ON CONFLICT (token_id) DO UPDATE SET
         report_json = excluded.report_json, reported_at = excluded.reported_at`,
    )
      .bind(tokenId, JSON.stringify(report), now)
      .run();

    return {
      accountId: access.accountId,
      oldState: null,
      newState: null,
      created: {},
      notCreated: {},
      updated: { self: null },
      notUpdated: {},
      destroyed: [],
      notDestroyed: {},
    };
  });

  registry.register("DeviceReport/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    if (access.granted) {
      throw new MethodError(
        "forbidden",
        `you reach ${access.accountId} through a grant, not ownership — the device inventory belongs ` +
          "to the account's owner",
      );
    }
    if (isAgentPrincipal(ctx.principal)) {
      throw new MethodError("forbidden", "agent tokens cannot enumerate the owner's devices");
    }

    // The caller's own tokens, each with whatever it last reported. LEFT
    // JOIN, because a token that never reported is still a device — T2 lists
    // it with a bare "last seen" and no model claims, which is the honest
    // rendering. Control-plane tables only: tokens, principals and
    // device_reports live together, so this never joins across planes.
    const { results } = await ctx.env.DB.prepare(
      `SELECT t.id, t.name, t.created_at, t.expires_at, t.last_used_at,
              r.report_json, r.reported_at
       FROM tokens t
       JOIN principals p ON p.id = t.principal_id
       LEFT JOIN device_reports r ON r.token_id = t.id
       WHERE p.login_email = ? AND t.kind = 'bearer'
       ORDER BY COALESCE(t.last_used_at, t.created_at) DESC`,
    )
      .bind(ctx.principal.username)
      .all<{
        id: string;
        name: string;
        created_at: number;
        expires_at: number | null;
        last_used_at: number | null;
        report_json: string | null;
        reported_at: number | null;
      }>();

    const list = (results ?? []).map((row) => {
      let report: Record<string, unknown> = {};
      if (row.report_json) {
        try {
          report = JSON.parse(row.report_json) as Record<string, unknown>;
        } catch {
          report = {};
        }
      }
      return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        // The snapshot half — null when the device never reported. Rendered
        // "as of reportedAt", never "installed" (s37 decision 2).
        host: (report.host as string | undefined) ?? null,
        models: (report.models as string[] | undefined) ?? null,
        capabilities: (report.capabilities as Record<string, unknown> | undefined) ?? null,
        source: (report.source as string | undefined) ?? null,
        reportedAt: row.reported_at,
      };
    });

    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list,
      notFound: [],
    };
  });
}

/**
 * Validation as bounds, not vocabulary: the report is free-form ENOUGH that a
 * newer CLI can say more than this server knows (a capabilities key we have
 * never heard of survives verbatim) — but a label must stay label-sized, and
 * the four fields T2 renders must be the types T2 renders.
 */
function sanitizeReport(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw.host !== undefined && raw.host !== null) {
    if (typeof raw.host !== "string" || raw.host.length > MAX_STRING) {
      throw new MethodError("invalidArguments", `host must be a string of at most ${MAX_STRING} characters`);
    }
    out.host = raw.host;
  }
  if (raw.models !== undefined && raw.models !== null) {
    if (!Array.isArray(raw.models) || raw.models.length > MAX_MODELS) {
      throw new MethodError("invalidArguments", `models must be an array of at most ${MAX_MODELS} ids`);
    }
    for (const m of raw.models) {
      if (typeof m !== "string" || m.length > MAX_STRING) {
        throw new MethodError("invalidArguments", `each model id must be a string of at most ${MAX_STRING} characters`);
      }
    }
    out.models = raw.models;
  }
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    if (typeof raw.capabilities !== "object" || Array.isArray(raw.capabilities)) {
      throw new MethodError("invalidArguments", "capabilities must be an object");
    }
    out.capabilities = raw.capabilities;
  }
  if (raw.source !== undefined && raw.source !== null) {
    if (typeof raw.source !== "string" || raw.source.length > 64) {
      throw new MethodError("invalidArguments", "source must be a short string");
    }
    out.source = raw.source;
  }
  const bytes = JSON.stringify(out).length;
  if (bytes > MAX_REPORT_BYTES) {
    throw new MethodError("invalidArguments", `report too large (${bytes} bytes; the cap is ${MAX_REPORT_BYTES})`);
  }
  return out;
}
