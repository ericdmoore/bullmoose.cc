/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { defaultBase, forgetLoginCallbackInUrl, readApiBase, storeSession } from "../lib/app/client";
import { checkApiBase, checkToken } from "../lib/app/login";
import { beginLogin, completeLogin, readLoginCallback, signInAvailable } from "../lib/app/oauth";

/**
 * The front door (s07 T7). PRIMARY: hosted sign-in — an ordinary OAuth
 * authorization-code + PKCE dance against `auth.bullmoose.cc`, the same AS
 * claude.ai connects through, finishing in a `bm_` session token
 * (`lib/app/oauth.ts` is the flow; this island only navigates and stores).
 * FALLBACK, collapsed: the s07 T1 paste-a-token door, kept because a dev
 * server or homelab origin is outside the AS's redirect registry and a
 * token the operator already holds is the honest way in from there.
 *
 * ⚠️ NO CREDENTIAL EVER ENTERS A URL. The obvious login shapes — a form
 * submitting to `/mail?token=…`, or leaving `?code=` sitting in the address
 * bar while the exchange runs — would put a live credential (or a bearer
 * for one exchange) into browser history, into the `Referer` of outbound
 * links, and into access logs (s07 devPlan, refinement 1). The guards, each
 * held by `tokenInUrl.test.ts`:
 *
 *   1. the callback is stripped via client.ts's ONE history call
 *      (`forgetLoginCallbackInUrl`) before the exchange begins;
 *   2. the only external navigation is `start.authorizeUrl`, which carries
 *      public OAuth parameters and the PKCE *challenge* — never the
 *      verifier, never a token;
 *   3. `preventDefault` — the paste form's submit never navigates;
 *   4. its field has NO `name`, so the browser would not serialize it even
 *      if the submit did fire;
 *   5. `form-action 'none'` in the generated CSP (astro.config.mjs) — the
 *      browser refuses form navigation regardless of what this code does.
 */
export default function LoginForm() {
  const [phase, setPhase] = useState<"door" | "leaving" | "exchanging">("door");
  const [error, setError] = useState<string | undefined>(undefined);
  // The fallback opens itself where hosted sign-in cannot work (dev, tailnet,
  // a self-host on another hostname) — otherwise the page's one working path
  // would be behind a collapsed toggle.
  const [fallback, setFallback] = useState(() => !signInAvailable());
  const [token, setToken] = useState("");
  const [base, setBase] = useState(readApiBase() ?? "");
  const [reveal, setReveal] = useState(false);

  // Returning from the AS: `?code=&state=` (or `?error=`) is in the URL.
  // Strip it FIRST — before anything async — then finish the exchange.
  useEffect(() => {
    const cb = readLoginCallback(location.search);
    if (!cb) return;
    forgetLoginCallbackInUrl();
    setPhase("exchanging");
    void completeLogin(cb).then((done) => {
      if (done.ok) {
        // The one owner of `bullmoose.token` writes it (client.ts §6.1);
        // no API base — on app.bullmoose.cc the JMAP worker shares the
        // origin (sameOrigin.test.ts), so `defaultBase()` is already right.
        storeSession(done.token);
        location.assign("/");
        return;
      }
      setPhase("door");
      setError(done.error);
    });
  }, []);

  async function signIn() {
    setError(undefined);
    setPhase("leaving");
    const begun = await beginLogin();
    if (!begun.ok) {
      setPhase("door");
      setError(begun.error);
      setFallback(true);
      return;
    }
    const start = begun.start;
    location.assign(start.authorizeUrl);
  }

  function submitToken(ev: Event) {
    ev.preventDefault();
    const checked = checkToken(token);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    // Only touch the stored base when the operator actually set one; an empty
    // field means "this origin" (client.ts `defaultBase`), not "".
    let apiBase: string | undefined;
    if (base.trim()) {
      const checkedBase = checkApiBase(base);
      if (!checkedBase.ok) {
        setError(checkedBase.error);
        return;
      }
      apiBase = checkedBase.base;
    }
    storeSession(checked.token, apiBase);
    location.assign("/mail");
  }

  if (phase === "exchanging") {
    return (
      <main class="door">
        <h1 class="door-brand">bullmoose</h1>
        <p class="door-help" role="status">
          Signing you in…
        </p>
      </main>
    );
  }

  return (
    <main class="door">
      <h1 class="door-brand">bullmoose</h1>

      <button type="button" class="door-submit" onClick={() => void signIn()} disabled={phase === "leaving"}>
        {phase === "leaving" ? "Opening sign-in…" : "Sign in"}
      </button>
      <p class="door-help">
        Opens bullmoose sign-in at <code>auth.bullmoose.cc</code> — your address and password, entered there, never
        here. You come back signed in.
      </p>

      {error ? (
        <p class="door-error" role="alert">
          {error}
        </p>
      ) : null}

      <button class="door-advanced" type="button" aria-expanded={fallback} onClick={() => setFallback(!fallback)}>
        {fallback ? "▾" : "▸"} Advanced: use a device token
      </button>

      {fallback ? (
        <form class="door-form" onSubmit={submitToken} novalidate>
          <label class="door-label" for="door-token">
            Device token
          </label>
          <div class="door-field">
            <input
              id="door-token"
              class="door-input"
              type={reveal ? "text" : "password"}
              value={token}
              placeholder="bm_…"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              aria-describedby="door-help"
              aria-invalid={error ? "true" : undefined}
              onInput={(e) => {
                setToken((e.target as HTMLInputElement).value);
                setError(undefined);
              }}
            />
            <button type="button" class="door-reveal" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
              {reveal ? "Hide" : "Show"}
            </button>
          </div>

          <p id="door-help" class="door-help">
            Mint one with <code>bullmoose token create</code>. It is shown once — the <code>tk_…</code> id in listings
            is not it.
          </p>

          <label class="door-label" for="door-base">
            API base
          </label>
          <input
            id="door-base"
            class="door-input"
            type="url"
            value={base}
            placeholder={defaultBase()}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => {
              setBase((e.target as HTMLInputElement).value);
              setError(undefined);
            }}
          />
          <p class="door-help">Where the JMAP worker lives. Blank means this origin.</p>

          <button type="submit" class="door-submit" disabled={!token.trim()}>
            Use this token
          </button>
        </form>
      ) : null}

      {/* Say what the fallback is for, so it stays a fallback. */}
      <p class="door-note">
        The token path is for development and self-hosted origins the hosted sign-in cannot redirect back to. It takes a
        token you already have and keeps it in this browser — sign-in above is the door for everyone else, and the
        session it creates expires; a pasted token does not.
      </p>
    </main>
  );
}
