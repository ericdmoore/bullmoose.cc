import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { accountState, requireAccount, type RequestContext } from "./common";

/**
 * VacationResponse (RFC 8621 §8) — himalaya-supported — implemented as a
 * FACADE over one row of the armed-responder primitive:
 * kind='vacation', wait=0, cancelIf='never', date-range bounded.
 * The singleton id is "singleton" per spec.
 */
export function registerVacationMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("VacationResponse/get", async (args, ctx) => {
    const access = requireAccount(ctx, args, "read");
    const row = await vacationRow(ctx, access.accountId);
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: [
        {
          id: "singleton",
          isEnabled: row?.enabled === 1,
          fromDate: row?.from_date ? new Date(row.from_date).toISOString() : null,
          toDate: row?.to_date ? new Date(row.to_date).toISOString() : null,
          subject: row?.subject ?? null,
          textBody: row?.text_body ?? null,
          htmlBody: null,
        },
      ],
      notFound: [],
    };
  });

  registry.register("VacationResponse/set", async (args, ctx) => {
    const access = requireAccount(ctx, args, "draft");
    const oldState = await accountState(ctx, access.accountId);
    const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    const patch = update.singleton;
    if (!patch) {
      throw new MethodError("invalidArguments", "VacationResponse/set updates the singleton");
    }

    const existing = await vacationRow(ctx, access.accountId);
    const next = {
      enabled: bool(patch.isEnabled, existing?.enabled === 1) ? 1 : 0,
      subject: str(patch.subject, existing?.subject ?? null),
      text_body: str(patch.textBody, existing?.text_body ?? null),
      from_date: dateMs(patch.fromDate, existing?.from_date ?? null),
      to_date: dateMs(patch.toDate, existing?.to_date ?? null),
    };

    await ctx.env.DB.prepare(
      `INSERT INTO responders (id, account_id, kind, enabled, wait_seconds, cancel_if,
         subject, text_body, from_date, to_date, suppress_seconds)
       VALUES ('vacation', ?, 'vacation', ?, 0, 'never', ?, ?, ?, ?, 604800)
       ON CONFLICT (account_id, id) DO UPDATE SET
         enabled = excluded.enabled, subject = excluded.subject,
         text_body = excluded.text_body, from_date = excluded.from_date,
         to_date = excluded.to_date`,
    )
      .bind(access.accountId, next.enabled, next.subject, next.text_body, next.from_date, next.to_date)
      .run();

    return {
      accountId: access.accountId,
      oldState,
      newState: await accountState(ctx, access.accountId),
      created: {},
      notCreated: {},
      updated: { singleton: null },
      notUpdated: {},
      destroyed: [],
      notDestroyed: {},
    };
  });
}

async function vacationRow(ctx: RequestContext, accountId: string) {
  return ctx.env.DB.prepare(
    `SELECT enabled, subject, text_body, from_date, to_date
     FROM responders WHERE account_id = ? AND id = 'vacation'`,
  )
    .bind(accountId)
    .first<{
      enabled: number;
      subject: string | null;
      text_body: string | null;
      from_date: number | null;
      to_date: number | null;
    }>();
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback: string | null): string | null {
  return typeof v === "string" ? v : v === null ? null : fallback;
}
function dateMs(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}
