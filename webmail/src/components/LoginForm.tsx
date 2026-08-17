/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { defaultBase, readApiBase, storeSession } from "../lib/app/client";
import { checkApiBase, checkToken } from "../lib/app/login";

/**
 * The interim door (s07 T1). Paste a token → `localStorage` → `/mail`.
 *
 * ⚠️ THE TOKEN NEVER ENTERS A URL. The obvious shape — a form that submits to
 * `/mail?token=…` — would put a live credential in browser history, in the
 * `Referer` of every outbound link the user later clicks, and in every access
 * log between here and the origin (s07 devPlan, refinement 1). Three things
 * stop that, deliberately overlapping, because the failure is silent and
 * permanent:
 *
 *   1. `preventDefault` — the submit never navigates.
 *   2. the field has NO `name`, so the browser would not serialize it even if
 *      the submit did fire.
 *   3. `form-action 'none'` in the generated CSP (astro.config.mjs) — the
 *      browser refuses the navigation regardless of what this code does.
 *
 * `tokenInUrl.test.ts` holds the first two, and would fail if a later edit
 * reached for a plain `<form action=…>`.
 */
export default function LoginForm() {
  const [token, setToken] = useState("");
  const [base, setBase] = useState(readApiBase() ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(ev: Event) {
    ev.preventDefault();
    const checked = checkToken(token);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    // Only touch the stored base when the operator actually set one; an empty
    // advanced field means "this origin" (client.ts `defaultBase`), not "".
    let apiBase: string | undefined;
    if (advanced && base.trim()) {
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

  return (
    <main class="door">
      <h1 class="door-brand">bullmoose</h1>

      <form class="door-form" onSubmit={submit} novalidate>
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
          <button
            type="button"
            class="door-reveal"
            aria-pressed={reveal}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>

        <p id="door-help" class="door-help">
          Mint one with <code>bullmoose token create</code>. It is shown once — the{" "}
          <code>tk_…</code> id in listings is not it.
        </p>

        {error ? (
          <p class="door-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="button" class="door-advanced" onClick={() => setAdvanced(!advanced)}>
          {advanced ? "▾" : "▸"} Advanced
        </button>
        {advanced ? (
          <>
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
          </>
        ) : null}

        <button type="submit" class="door-submit" disabled={!token.trim()}>
          Sign in
        </button>
      </form>

      {/* Say what this is. An interim door that looks like a product login is
          how a temporary thing becomes permanent. */}
      <p class="door-note">
        This is an interim door. It takes a token you already have and keeps it in this browser; it
        is not a login system, there is no password and no account recovery. Real sign-in is the
        OAuth flow at <code>auth.bullmoose.cc</code> — s07 T7, on the authorization server s02 T3
        builds — and this page is deleted when that lands.
      </p>
    </main>
  );
}
