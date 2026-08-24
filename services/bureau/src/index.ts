import { verbPermittedForKind } from "./binding.js";
import { handleBindingUse } from "./byok.js";
import { runFetchVerb } from "./fetchVerb.js";
import { runOAuthTokenVerb } from "./oauthTokenVerb.js";
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
 *   POST /internal/bureau/binding-use
 *                                 (x-internal-token)  s26 T4 BYOK — the model
 *                                 router's door: `fetch` only, authorized by
 *                                 (binding enabled ∧ config names the credRef ∧
 *                                 account's own principal) + the SAME grant.
 *                                 `byok.ts` holds the whole argument.
 *   POST /bureau/use              (Bearer)            authorize, audit, RUN a verb
 *
 * Reached only over the BUREAU service binding from `services/agent`; there is
 * no public route. `/bureau/use` still authenticates its caller with a real
 * bearer token rather than trusting the binding, because the binding proves
 * which worker and the token proves which agent (arch.md OQ1b). Since s17 (c)
 * that bearer may be a `bmi_` PER-INVOCATION token, and when it is, the
 * invocation's `credentials` envelope is intersected with the standing grant —
 * see `grants.ts`, which holds the whole argument.
 *
 * Env is still `{DB, VAULT_MASTER_KEY, INTERNAL_TOKEN}` and must stay that way:
 * the s17 gate reads `agent_invocations`/`agent_bindings` off the SAME D1
 * handle (`effectiveNodeAuthority` takes an `AuthorityDb`, which is structurally
 * one binding), so understanding invocations cost this worker no new capability.
 * If a future gate here needs data D1 cannot reach, that is a reason to move the
 * gate, not to widen `models.ts`.
 *
 * **T3a + T2 + T3: the key moved, the grant model exists, and the Class A verb
 * runs.** `/bureau/use` now authenticates, authorizes, audits, gates the verb by
 * the credential's kind (§4.1), binds the destination (§6) and proxies the call
 * with the credential injected as a header (invariant 8). The Class B verbs
 * (§3) are still T5 and still answer 501 — but now from behind the kind gate.
 *
 * Egress redaction (§7, invariant 7) is T4 and is deliberately absent: it is
 * ranked BELOW destination binding on purpose (§7), so it is the thing that may
 * arrive second. `fetchVerb.ts`'s `EgressFilter` is the seam it lands on.
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
      // s26 T4 — BYOK. A USE path behind the internal token, which exists
      // because `callModel` holds no bearer to present; `byok.ts` documents
      // what replaces step 0 and why the substitution is of equal strength.
      // It ends in the same `runFetchVerb`, so the destination binding, the
      // kind gate, header-only injection and "only the result comes back" are
      // the same code, not a parallel implementation.
      if (url.pathname === "/internal/bureau/binding-use") {
        return handleBindingUse(request, env);
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
  await sealAndStore(env, body.principalId, body.name, body.kind, body.metaJson ?? "{}", body.secret);
  return json({ ok: true, sealed: true });
}

/**
 * The one call an agent makes: "run this verb with this credential."
 *
 * The five steps of bureau.md's T3 runtime, in the order that makes them
 * enforceable rather than merely present:
 *
 *   0. authenticate the caller          `authorizeUse` (T3a)
 *   1. authorize (principal, credRef, verb) + audit   `authorizeUse` (T2)
 *  1b. ∧ the invocation's envelope, when a `bmi_` token
 *      authenticated the call                        `authorizeUse` (s17 (c))
 *   2. gate the verb by the credential's KIND (§4.1)  ← here
 *   3. bind the destination (§6)                      ┐
 *   4. inject header-only (invariant 8)               ├ the verb runtime
 *   5. return only the result                         ┘
 *
 * Step 2 sits here rather than inside the verb because it is a property of the
 * *vocabulary*, not of any one verb: it is what stops `hmac_sha256` being
 * pointed at an `aws-sigv4` credential and used to derive `kSigning` (§4.1), and
 * that has to hold for verbs that do not exist yet. A Class B verb added in T5
 * inherits the gate by arriving after it.
 *
 * The remaining 501 is now honest in a narrower way than it was: the Class B
 * verbs are unbuilt, but they are unbuilt *behind* the kind gate, so an
 * unimplemented verb on the wrong kind is a 403 and not a 501.
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

  const { verb } = decision.grant;

  // 2 — §4.1. A grant can say "this agent may run this verb with this
  // credential"; only the kind can say the verb makes sense against it. Both
  // must agree, and an operator's mis-grant is caught here.
  if (!verbPermittedForKind(decision.kind, verb)) {
    return json({ error: `verb "${verb}" is not permitted for a "${decision.kind}" credential` }, 403);
  }

  // 3–5 — Class A. One verb, forever (§3): the destination binding lives on the
  // credential, so `fetch` covers every static-bearer service without ever
  // gaining a per-service sibling.
  if (verb === "fetch") {
    return runFetchVerb(
      env,
      {
        principalId: decision.principalId,
        credRef: decision.grant.credRef,
        kind: decision.kind,
        meta: decision.meta,
      },
      body.request,
    );
  }

  // Class B (§3) — `oauth_token` is now live (s04 T5's first, #4's
  // unblocker): an `oauth-refresh` credential could be sealed since T3 and
  // nothing could spend it, so every OAuth-shaped connector was dead on
  // arrival. It is THIN by design — it exchanges, then hands the request to
  // the same Class A runtime, so the allowlist, the manual-redirect rule
  // and the single exit keep exactly one implementation.
  if (verb === "oauth_token") {
    return runOAuthTokenVerb(
      env,
      {
        principalId: decision.principalId,
        credRef: decision.grant.credRef,
        kind: decision.kind,
        meta: decision.meta,
      },
      body.request,
    );
  }

  // `sign_sigv4` and `hmac_sha256` remain T5. Loud rather than silently
  // permissive, which is the right way round for a security boundary under
  // construction.
  return json(
    {
      error: `verb "${verb}" is authorized but not implemented yet`,
      authorized: true,
      grantId: decision.grant.grantId,
      credRef: decision.grant.credRef,
      kind: decision.kind,
      hint: "sign_sigv4/hmac_sha256 are still s04 T5; `fetch` and `oauth_token` are live",
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
