import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
import { compileSieve, parseSieve, SIEVE_EXTENSIONS, type SieveRule } from "@bullmoose/boundary";
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
 * /set is RUNG 1 (below): hand-written rules, gated on the dedicated
 * `rules` scope (DECIDED 2026-08-23), parsed back into the dialect by the
 * compiler's inverse, and applied as a whole-script replace DIFFED BY
 * PROVENANCE -- a hand save cannot silently drop a rule an approval
 * created without the response saying so.
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

  registry.register("SieveScript/set", async (args, ctx) => {
    // The agent wall FIRST, before account resolution: an agent editing the
    // rulebook without a proposal is exactly what the marker exists to
    // prevent -- its road is rung 2 ([mark junk] -> proposal -> approval),
    // and a marked token cannot even learn which accounts are reachable here.
    if (ctx.agent || isAgentPrincipal(ctx.principal)) {
      throw new MethodError(
        "forbidden",
        "agents do not hand-edit the rulebook -- an agent's rule change is a proposal a human approves (the rules ladder, rung 2)",
      );
    }
    // The dedicated scope (DECIDED 2026-08-23). Structurally NOT covered by
    // the `mail` bundle: a standing filter's false positive is mail you
    // never see, and the power to rewrite the rulebook is granted by name.
    const access = await requireAccount(ctx, args, "rules");
    const store = storeFor(ctx);

    const row = await ctx.env.DB.prepare(`SELECT rules_json, updated_at FROM sieve_rules WHERE account_id = ?`)
      .bind(access.accountId)
      .first<{ rules_json: string; updated_at: number }>();
    const oldState = row ? String(row.updated_at) : "0";
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch", "the rulebook moved since you read it -- re-read and re-apply");
    }
    let prev: SieveRule[] = [];
    if (row) {
      try {
        prev = validateSieveRules(JSON.parse(row.rules_json));
      } catch {
        throw new MethodError("serverFail", "the existing rulebook is unreadable -- refusing to overwrite it blind");
      }
    }

    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const notDestroyed: Record<string, unknown> = {};
    let updatedOut: Record<string, unknown> | null | undefined;
    let destroyedOut: string[] = [];

    /** The ONE write path: parse the incoming script, mint hand ids, diff by
     *  provenance, and replace. Returns the server-set change report. */
    const applyScript = async (text: string): Promise<Record<string, unknown> | null> => {
      const parsed = parseSieve(text);
      if (!parsed.ok) {
        // RFC 9661's own error type, carrying every refusal sentence -- the
        // client shows the human exactly which clause the engine cannot run.
        throw new MethodError("invalidScript", parsed.refusals.join("; "));
      }
      const next: SieveRule[] = parsed.rules.map((r, i) => ({
        // A recovered `# rule <id>` comment keeps its identity (negotiated
        // rules stay traceable to their approval); a hand-new rule gets a
        // hand id -- authored-by-hand IS its provenance.
        id: r.id ?? `hand_${crypto.randomUUID().slice(0, 8)}_${i}`,
        all: r.all,
        action: r.action,
      }));
      let valid: SieveRule[];
      try {
        valid = validateSieveRules(next);
      } catch (err) {
        throw new MethodError("invalidScript", err instanceof Error ? err.message : String(err));
      }

      // The provenance diff. A hand save is a WHOLE-SCRIPT replace (one
      // script, maxNumberScripts 1), so a negotiated rule -- id minted by an
      // approval, `inv_` -- that the incoming script drops or alters is a
      // change the response names OUT LOUD. Not refused: rung 1 is the
      // power tool, and the human is the authority -- but never silent.
      const nextById = new Map(valid.map((r) => [r.id, r]));
      const removedNegotiated = prev.filter((r) => r.id.startsWith("inv_") && !nextById.has(r.id)).map((r) => r.id);
      const changedNegotiated = prev
        .filter((r) => {
          const now = nextById.get(r.id);
          return r.id.startsWith("inv_") && now !== undefined && JSON.stringify(now) !== JSON.stringify(r);
        })
        .map((r) => r.id);

      const now = Date.now();
      await ctx.env.DB.prepare(
        `INSERT INTO sieve_rules (account_id, rules_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at`,
      )
        .bind(access.accountId, JSON.stringify(valid), now)
        .run();

      return removedNegotiated.length > 0 || changedNegotiated.length > 0
        ? {
            ...(removedNegotiated.length > 0 ? { removedNegotiated } : {}),
            ...(changedNegotiated.length > 0 ? { changedNegotiated } : {}),
          }
        : null;
    };

    const scriptText = async (spec: Record<string, unknown>): Promise<string> => {
      const blobId = typeof spec.blobId === "string" ? spec.blobId : "";
      if (!blobId) throw new MethodError("invalidProperties", "a script write carries blobId (RFC 9661)");
      const blob = await store.getBlob(access.tenantId, access.accountId, blobId);
      if (!blob) throw new MethodError("blobNotFound", `no blob ${blobId} on this account`);
      return await blob.text();
    };

    // ---- update: the ordinary Boogie save -------------------------------
    const updateSpec = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpec)) {
      if (id !== "boundary") {
        notUpdated[id] = { type: "notFound", description: "the one script is named boundary" };
        continue;
      }
      updatedOut = await applyScript(await scriptText(patch));
    }

    // ---- create: only meaningful when no rulebook exists yet ------------
    const createSpec = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpec)) {
      if (row || updatedOut !== undefined) {
        notCreated[cid] = {
          type: "overQuota",
          description: "maxNumberScripts is 1 and the boundary script exists -- update it instead",
        };
        continue;
      }
      await applyScript(await scriptText(spec));
      created[cid] = { id: "boundary", isActive: true };
    }

    // ---- destroy: the empty rulebook, through the same diff -------------
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      if (id !== "boundary") {
        notDestroyed[id] = { type: "notFound" };
        continue;
      }
      const report = await applyScript(`require ${JSON.stringify(SIEVE_EXTENSIONS[0])};\n`);
      destroyedOut = ["boundary"];
      if (report) updatedOut = report; // dropped negotiated rules still named
    }

    // onSuccessActivateScript: with one always-active script this is a no-op,
    // accepted so a conforming client's ordinary save does not error.

    const after = await ctx.env.DB.prepare(`SELECT updated_at FROM sieve_rules WHERE account_id = ?`)
      .bind(access.accountId)
      .first<{ updated_at: number }>();

    return {
      accountId: access.accountId,
      oldState,
      newState: after ? String(after.updated_at) : oldState,
      created,
      notCreated,
      updated: updatedOut !== undefined ? { boundary: updatedOut } : {},
      notUpdated,
      destroyed: destroyedOut,
      notDestroyed,
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
