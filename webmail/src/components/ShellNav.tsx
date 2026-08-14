/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { SECTIONS, type Section, type SectionId } from "../lib/app/sections";

/**
 * The two interactive pieces of the app shell (s07 nav spike): the mobile
 * drawer and the profile menu.
 *
 * ## Why this is hand-written and not Headless UI
 *
 * The Tailwind reference template uses `@headlessui/react` for exactly these
 * two widgets. Adopting it would cost more than it looks:
 *
 *  - it is React-only, so it needs `preact/compat` aliasing, and Headless UI
 *    v2 leans on React internals hard enough that this is a known rough edge;
 *  - it sets inline `style` attributes for transitions and positioning, which
 *    means `'unsafe-inline'` in `style-src`. This app's CSP is GENERATED with
 *    per-build hashes precisely to keep that out, and weakening it on the
 *    authenticated surface to get a drawer is a bad trade.
 *
 * Both widgets are a few dozen lines each. Tailwind — which emits an external
 * stylesheet and needs no CSP change — is the part of that template worth
 * taking; its component library is not.
 *
 * ## What it still owes the user
 *
 * A drawer and a menu are exactly where hand-rolling usually loses to a
 * library: focus handling, Escape, click-outside, and `aria-*`. Those are
 * implemented below rather than skipped, because the reason for not taking
 * Headless UI was the CSP, not the accessibility work.
 */

interface Props {
  /** Which nav entry is the current page. */
  section?: SectionId;
  /** Shown in the profile menu; absent until a session exists. */
  email?: string;
}

const isLive = (s: Section): boolean => s.status === "live";

/** Heroicons 24/outline, inlined. Nine static paths do not need a dependency. */
const ICONS: Record<SectionId, string> = {
  approvals: "M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z",
  agents: "M9.75 17 9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z",
  calendar: "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
  mail: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75",
  contacts: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
  files: "M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z",
  search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  settings: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.03 7.03 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z",
};

function Icon({ id, className }: { id: SectionId; className: string }) {
  return (
    <svg
      class={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={1.5}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d={ICONS[id]} />
    </svg>
  );
}

/** The nav list, shared by the desktop rail and the mobile drawer. */
function NavList({ section, onNavigate }: { section?: SectionId; onNavigate?: () => void }) {
  return (
    <ul role="list" class="-mx-2 space-y-1">
      {SECTIONS.map((s) => {
        const current = s.id === section;
        // A planned section is never a link and never a 404 — it renders
        // disabled WITH its reason, because a greyed-out word with no
        // explanation teaches that the product is broken rather than
        // unfinished (sections.ts).
        if (!isLive(s)) {
          const planned = s as Extract<Section, { status: "planned" }>;
          return (
            <li key={s.id}>
              <span
                class="group flex cursor-not-allowed gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-gray-500"
                title={planned.detail}
                aria-disabled="true"
              >
                <Icon id={s.id} className="size-6 shrink-0 opacity-40" />
                <span class="flex flex-col">
                  {s.label}
                  <span class="text-xs font-normal text-gray-500">{planned.reason}</span>
                </span>
              </span>
            </li>
          );
        }
        return (
          <li key={s.id}>
            <a
              href={s.href}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              class={
                "group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold " +
                (current
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white")
              }
            >
              <Icon id={s.id} className="size-6 shrink-0" />
              {s.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <a href="/" class="flex h-16 shrink-0 items-center gap-x-2 text-white">
      <span aria-hidden="true" class="text-2xl">🫎</span>
      <span class="font-semibold tracking-tight">bullmoose</span>
    </a>
  );
}

export default function ShellNav({ section, email }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  // Escape closes whichever is open. One listener, because two widgets that
  // each own a global key handler is how you end up with one of them silently
  // swallowing the other's Escape.
  useEffect(() => {
    if (!drawerOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, menuOpen]);

  // Click-outside for the profile menu only. The drawer has a backdrop that
  // handles its own dismissal.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  // Move focus into the drawer when it opens, so a keyboard user is not left
  // behind on the toggle underneath it.
  useEffect(() => {
    if (drawerOpen) drawerCloseRef.current?.focus();
  }, [drawerOpen]);

  return (
    <>
      {/* Mobile drawer */}
      {drawerOpen && (
        <div class="relative z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Sections">
          <div
            class="fixed inset-0 bg-gray-900/80"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div class="fixed inset-0 flex">
            <div class="relative mr-16 flex w-full max-w-xs flex-1">
              <div class="absolute top-0 left-full flex w-16 justify-center pt-5">
                <button
                  ref={drawerCloseRef}
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  class="-m-2.5 p-2.5 text-white"
                >
                  <span class="sr-only">Close sections</span>
                  <svg class="size-6" fill="none" viewBox="0 0 24 24" stroke-width={1.5} stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900 px-6 pb-4 ring-1 ring-white/10">
                <Brand />
                <nav class="flex flex-1 flex-col">
                  <NavList section={section} onNavigate={() => setDrawerOpen(false)} />
                </nav>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900 px-6 pb-4">
          <Brand />
          <nav class="flex flex-1 flex-col">
            <NavList section={section} />
          </nav>
        </div>
      </div>

      {/* Header */}
      <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-xs sm:gap-x-6 sm:px-6 lg:px-8 dark:border-white/10 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          class="-m-2.5 p-2.5 text-gray-700 lg:hidden dark:text-gray-200"
          aria-expanded={drawerOpen}
        >
          <span class="sr-only">Open sections</span>
          <svg class="size-6" fill="none" viewBox="0 0 24 24" stroke-width={1.5} stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <div aria-hidden="true" class="h-6 w-px bg-gray-200 lg:hidden dark:bg-white/10" />

        <div class="flex flex-1 justify-end gap-x-4 self-stretch lg:gap-x-6">
          <div class="relative flex items-center" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              class="flex items-center gap-x-2 rounded-md p-1.5 text-sm/6 font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span class="grid size-8 place-items-center rounded-full bg-gray-200 text-xs font-bold text-gray-700 dark:bg-white/10 dark:text-white">
                {(email ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span class="hidden lg:inline">{email ?? "Not signed in"}</span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                class="absolute top-full right-0 z-10 mt-1 w-48 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 dark:bg-gray-800 dark:ring-white/10"
              >
                <a
                  role="menuitem"
                  href="/settings"
                  class="block px-3 py-1 text-sm/6 text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                >
                  Settings
                </a>
                <button
                  role="menuitem"
                  type="button"
                  class="block w-full px-3 py-1 text-left text-sm/6 text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                  onClick={() => {
                    // Same contract as the existing SessionBar: clear the
                    // stored session and return to the door.
                    try {
                      localStorage.removeItem("bm.session");
                    } catch {
                      /* private mode — the redirect still signs you out */
                    }
                    location.assign("/login/");
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
