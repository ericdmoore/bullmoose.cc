/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { resolveClient, signOut } from "../lib/app/client";

/**
 * Who is signed in, and the way out. The one interactive piece of the shared
 * chrome (`layouts/App.astro`).
 *
 * It is an island rather than static markup for two reasons that both come down
 * to the same thing: the answer only exists in the browser. The identity comes
 * from the JMAP session, and sign-out has to clear `localStorage` — neither is
 * knowable at build time. It is deliberately the ONLY island the layout adds:
 * the section content is still exactly one `client:only` island per page, and
 * there is still no client-side router (s07 devPlan, refinement 2).
 *
 * `signOut()` has existed at `client.ts` since s03.C and was called from
 * nowhere — there was no way to sign out of this app at all. This is it.
 */
export default function SessionBar() {
  const [label, setLabel] = useState<string>("…");
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const resolved = resolveClient();
    if (resolved.mode === "unauthenticated") {
      setLabel("not signed in");
      return;
    }
    setDemo(resolved.mode === "demo");
    void resolved.client
      .session()
      .then((s) => !cancelled && setLabel(s.username))
      // The session call is the first thing that touches the server, so it is
      // also the first thing that can be wrong. Say "unreachable", not a
      // guessed address: a stale name next to a working sign-out button is how
      // someone signs out of an account they were never in.
      .catch(() => !cancelled && setLabel("session unreachable"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div class="app-who">
      <span class="app-identity" title={demo ? "sample data — not a real account" : undefined}>
        {demo ? "demo" : label}
      </span>
      <button
        type="button"
        class="app-signout"
        onClick={() => {
          signOut();
          location.assign("/login");
        }}
      >
        Sign out
      </button>
    </div>
  );
}
