import type { MethodRegistry } from "@bullmoose/jmap-core";
import { compileSieve, SIEVE_EXTENSIONS, type SieveRule } from "@bullmoose/boundary";
import { validateSieveRules } from "@bullmoose/mailstore";
import { requireAccount, storeFor, type RequestContext } from "./common";

/**
 * SieveScript/get (RFC 9661) -- the READ side of the rules ladder (s31).
 *
 * Born the night BoogieMail's Rules screen said "this account's mail server
 * does not support mail-filtering rules" -- honest, and wrong to leave true.
 * We HAVE rules: the boundary's stage-3 ruleset, one JSON document per
 * account. This method compiles it to real Sieve text and serves it as the
 * blob RFC 9661 expects, so any standards client's Rules screen becomes a
 * truthful rendering of the shared rulebook.
 *
 * READ-ONLY ON PURPOSE, for now. /set is rung 1 of the ladder and waits on
 * two decisions the plan assigns to Eric (the write scope, and coexistence
 * of the bouncer's operational rules). Until then /set is simply not
 * registered -- an unknown method, not a moralizing refusal: the plan
 * explicitly rejects "rules are staff-managed, ask the bouncer" as the
 * anti-star principle curdling into a star of its own.
 *
 * ## The blob, and why /get re-compiles
 *
 * The compiler is DETERMINISTIC and the blob store is content-addressed
 * (b_ + sha256), so re-compiling on every /get lands on the SAME blob id --
 * a re-read costs one small putBlob that dedupes to a no-op. The lazy
 * alternative (compile on write, store the blob id) would go stale the day
 * anything else touches rules_json, and the bouncer already does.
 *
 * ## State
 *
 * The ruleset's updated_at IS the state string: it moves exactly when the
 * rules move. The account changelog does not carry sieve rows, so the
 * accountState() everything else uses would be a state that never changes
 * when rules do -- the one lie a state string must never tell.
 */
export function registerSieveMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("SieveScript/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");

    const row = await ctx.env.DB.prepare(`SELECT rules_json, updated_at FROM sieve_rules WHERE account_id = ?`)
      .bind(access.accountId)
      .first<{ rules_json: string; updated_at: number }>();

    // No row is a real answer: no rules yet. An empty list with a stable
    // state, not an invented empty script -- a client that sees zero
    // scripts renders "no rules", which is the truth.
    if (!row) {
      return { accountId: access.accountId, state: "0", list: [], notFound: [] };
    }

    // validateSieveRules rather than a bare JSON.parse: a corrupt row must
    // degrade to what the ENGINE would run (listSieveRules degrades to none),
    // never to a script that claims rules the boundary does not enforce.
    let rules: SieveRule[];
    try {
      rules = validateSieveRules(JSON.parse(row.rules_json));
    } catch {
      rules = [];
    }
    const script = compileSieve(rules);

    const store = storeFor(ctx);
    const bytes = new TextEncoder().encode(script);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blobId = await store.putBlob(access.tenantId, access.accountId, buf);

    // ONE script, fixed id. RFC 9661 allows many with one active; our store
    // is one document, and inventing a per-compile id would make every
    // /get look like a new script to a syncing client.
    const scripts = [
      {
        id: "boundary",
        name: "bullmoose boundary rules",
        blobId,
        isActive: true,
      },
    ];

    const ids = (args as { ids?: string[] | null }).ids ?? null;
    const wanted = ids === null ? scripts : scripts.filter((s) => ids.includes(s.id));
    const notFound = ids === null ? [] : ids.filter((id) => id !== "boundary");

    return {
      accountId: access.accountId,
      state: String(row.updated_at),
      list: wanted,
      notFound,
    };
  });
}

/** The session capability object -- advertised ONLY because /get above is
 *  real (the plan's rule, and #230/#238's lesson). Every value is what the
 *  engine actually does, not what the RFC allows us to claim. */
export function sieveCapability(): Record<string, unknown> {
  return {
    // One compiled document; there is no second script to activate.
    maxNumberScripts: 1,
    maxSizeScriptName: 64,
    // The D1 row bound the dialect already respects; generous for Sieve text.
    maxSizeScript: 500_000,
    // No redirect action in the dialect at all.
    maxNumberRedirects: 0,
    // Exactly what compileSieve emits -- fileinto, nothing else.
    sieveExtensions: [...SIEVE_EXTENSIONS],
    // No enotify, no external lists: null per RFC 9661, meaning unsupported.
    notificationMethods: null,
    externalLists: null,
  };
}
