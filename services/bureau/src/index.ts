import { authorizeUse, type UseRequest } from "./grants.js";
import { reseal, sealAndStore, verifyOpenable } from "./vault.js";
import type { Env } from "./models.js";

/**
 * The Bureau — the only worker that holds VAULT_MASTER_KEY.
 *
 * bureau.md §1: *the Bureau applies the credential itself, and returns only the
 * result.* A NAME goes in (`credRef` + verb); a RESULT comes back. The secret
 * never leaves this worker, which is why isolating it costs no plaintext hop —
 * the earlier argument for embedding it in `services/agent` assumed one, and
 * that assumption was the mistake (arch.md OQ1).
 *
 *   POST /internal/bureau/seal    (x-internal-token)  seal-on-mint / rotate
 *   POST /internal/bureau/verify  (x-internal-token)  decrypt-and-discard health check
 *   POST /bureau/use              (Bearer)            authorize + audit a verb
 *
 * Reached only over the BUREAU service binding from `services/agent`; there is
 * no public route. `/bureau/use` still authenticates its caller with a real
 * bearer token rather than trusting the binding, because the binding proves
 * which worker and the token proves which agent (arch.md OQ1b).
 *
 * **This slice is T3a + T2: the key moved, and the grant model exists.** The
 * verb RUNTIME is T3 — `/bureau/use` authorizes, audits, and then answers 501,
 * which is the honest state: authorization is real and enforced today, the proxy
 * is not built yet. When T3 lands it replaces exactly one branch below.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!env.VAULT_MASTER_KEY) return json({ error: "vault not configured" }, 501);

      if (url.pathname === "/internal/bureau/seal") {
        return handleSeal(request, env);
      }
      if (url.pathname === "/internal/bureau/verify") {
        const body = (await request.json()) as { principalEmail?: string; name?: string };
        if (!body.principalEmail || !body.name) {
          return json({ error: "principalEmail and name required" }, 400);
        }
        return json(await verifyOpenable(env, body.principalEmail, body.name));
      }
    }

    if (request.method === "POST" && url.pathname === "/bureau/use") {
      return handleUse(request, env);
    }

    return new Response("bullmoose-bureau", { status: url.pathname === "/" ? 200 : 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Seal-on-mint and rotate. This path exists in the Bureau rather than the agent
 * for one reason: it is the other half of the key's job. Leaving it behind would
 * have meant `VAULT_MASTER_KEY` stayed bound to `services/agent`, and the whole
 * isolation argument with it.
 *
 * The agent has already validated the mint-time contract (name shape, kind,
 * allowlist, header recipe, scope, enforcement) and serialized `meta_json`. That
 * split is intentional: policy is the agent's, ciphertext is the Bureau's.
 */
async function handleSeal(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    mode?: string;
    principalId?: string;
    name?: string;
    kind?: string;
    metaJson?: string;
    secret?: string;
  };
  if (!body.principalId || !body.name) return json({ error: "principalId and name required" }, 400);
  if (typeof body.secret !== "string" || body.secret.length === 0) {
    return json({ error: "secret required" }, 400);
  }

  if (body.mode === "rotate") {
    const rotated = await reseal(env, body.principalId, body.name, body.secret);
    return rotated ? json({ ok: true, rotated: true }) : json({ error: "not found" }, 404);
  }

  if (!body.kind) return json({ error: "kind required" }, 400);
  await sealAndStore(
    env,
    body.principalId,
    body.name,
    body.kind,
    body.metaJson ?? "{}",
    body.secret,
  );
  return json({ ok: true, sealed: true });
}

/**
 * The one call an agent makes: "run this verb with this credential."
 *
 * Everything before the 501 is live, enforced behaviour — caller
 * authentication, exact-tuple authorization, and the audit row. Only the verb
 * execution is missing, and it is missing loudly rather than silently
 * permissive, which is the right way round for a security boundary under
 * construction.
 */
async function handleUse(request: Request, env: Env): Promise<Response> {
  let body: UseRequest;
  try {
    body = (await request.json()) as UseRequest;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const decision = await authorizeUse(env, request, body);
  if (!decision.ok) return json({ error: decision.error }, decision.status);

  // T3 lands here: gate the verb by kind (§4.1), bind the destination (§6),
  // unseal in-process, inject as a header (invariant 8), return only the result.
  return json(
    {
      error: `verb "${decision.grant.verb}" is authorized but not implemented yet`,
      authorized: true,
      grantId: decision.grant.grantId,
      credRef: decision.grant.credRef,
      kind: decision.kind,
      hint: "the Bureau runtime is s04 T3; T3a moved the key and T2 built the grant model",
    },
    501,
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
