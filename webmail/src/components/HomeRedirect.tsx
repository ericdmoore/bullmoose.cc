/** @jsxImportSource preact */
import { useEffect } from "preact/hooks";
import { homeTarget, resolveClient } from "../lib/app/client";

/**
 * ⚠️ PLACEHOLDER. `/` is supposed to be the product — *Looking Ahead* and
 * *Waiting Approvals*, the two stacks that make this a collaboration space
 * rather than a file manager (s07 T0). T0 cannot render until T4 produces
 * proposals, so until then `/` only decides where you belong: `/mail` with a
 * session, `/login` without one. Replace this island wholesale; do not grow a
 * home page out of it.
 *
 * A redirect rather than a server rule because the build is static output —
 * "is there a token" is a question only the browser can answer, since the
 * answer is in `localStorage` and never in a cookie or a URL.
 */
export default function HomeRedirect() {
  useEffect(() => {
    // `replace`, not `assign`: `/` is a signpost, and leaving it in history
    // makes Back from `/mail` land here and bounce straight forward again.
    location.replace(homeTarget(resolveClient()));
  }, []);

  // Rendered for the moment before the redirect, and for anyone whose JS never
  // arrives — a page that is blank without scripting is a 404 wearing a 200.
  return (
    <main class="door">
      <h1 class="door-brand">bullmoose</h1>
      <p class="door-note">
        Taking you to <a href="/mail">your mail</a>, or <a href="/login">sign in</a>.
      </p>
    </main>
  );
}
