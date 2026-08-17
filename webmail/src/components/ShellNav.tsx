/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { SECTIONS, type Section, type SectionId } from "../lib/app/sections";

/**
 * The app shell's interactive chrome (s07 nav spike): a collapsible section
 * rail, a right-hand mobile drawer, and the profile menu.
 *
 * ## Why this is hand-written and not Headless UI
 *
 * The reference templates use `@headlessui/react` for the drawer and the menu.
 * Adopting it would cost more than it looks: it is React-only, so it needs
 * `preact/compat` aliasing, and it sets inline `style` attributes for
 * transitions and positioning — which means `'unsafe-inline'` in `style-src`.
 * This app's CSP is GENERATED with per-build hashes precisely to keep that
 * out, and weakening it on the authenticated surface to get two widgets is a
 * bad trade. Tailwind, which emits an external stylesheet, costs nothing.
 *
 * The parts people actually reach for a library to get — focus handling,
 * Escape, click-outside, `aria-*` — are implemented here rather than skipped,
 * because the objection was the CSP, not the accessibility work.
 */

interface Props {
  section?: SectionId;
  email?: string;
}

const COLLAPSE_KEY = "bm.nav.collapsed";
const WIDTH_KEY = "bm.nav.width";
const isLive = (s: Section): boolean => s.status === "live";

/**
 * The rail's allowed widths, as CLASSES rather than a pixel value.
 *
 * A drag-resize would normally write `style="width:…"`, and inline `style`
 * attributes are governed by `style-src` — which this app's generated CSP
 * carries WITHOUT `'unsafe-inline'`, on purpose. Setting one would either be
 * blocked or force the policy open, and forcing it open is exactly the
 * objection that kept Headless UI out of this file. Discrete steps keep the
 * drag feeling continuous enough while staying pure classes.
 *
 * `px` is only used to decide which step a drag has reached; nothing writes it
 * to the DOM.
 */
const WIDTHS = [
  { px: 208, rail: "lg:w-52", pad: "lg:pl-52" },
  { px: 240, rail: "lg:w-60", pad: "lg:pl-60" },
  { px: 288, rail: "lg:w-72", pad: "lg:pl-72" },
  { px: 320, rail: "lg:w-80", pad: "lg:pl-80" },
] as const;
const DEFAULT_WIDTH = 2;
/** Collapsed is its own step, not the narrow end of the range. */
const COLLAPSED = { rail: "lg:w-20", pad: "lg:pl-20" };

const nearestStep = (px: number): number => {
  let best = 0;
  for (let i = 1; i < WIDTHS.length; i++) {
    if (Math.abs(WIDTHS[i]!.px - px) < Math.abs(WIDTHS[best]!.px - px)) best = i;
  }
  return best;
};

/** Heroicons 24/outline, inlined. Nine static paths do not need a dependency. */
const ICONS: Record<SectionId, string> = {
  approvals:
    "M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z",
  agents:
    "M9.75 17 9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z",
  calendar:
    "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
  mail: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75",
  contacts:
    "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
  files:
    "M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z",
  search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  settings:
    "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.03 7.03 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z",
};

function Icon({ id, className }: { id: SectionId; className: string }) {
  return (
    <svg class={className} fill="none" viewBox="0 0 24 24" stroke-width={1.5} stroke="currentColor" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d={ICONS[id]} />
    </svg>
  );
}

/**
 * The nav list. `compact` renders icons only — the label survives as the
 * accessible name and the tooltip, so collapsing the rail hides the text
 * without hiding the meaning from a screen reader.
 */
function NavList({
  section,
  compact,
  onNavigate,
  order,
  onReorder,
}: {
  section?: SectionId;
  compact?: boolean;
  onNavigate?: () => void;
  /** The user's own order, if they have set one. */
  order?: SectionId[];
  onReorder?: (from: SectionId, to: SectionId) => void;
}) {
  // A stored order is a PREFERENCE over the shipped one, not a replacement:
  // ids it does not know about are appended rather than dropped, so a section
  // added later appears for someone who reordered last year instead of
  // silently vanishing for them alone.
  const ordered = order?.length
    ? [
        ...order.map((id) => SECTIONS.find((s) => s.id === id)).filter((s): s is Section => !!s),
        ...SECTIONS.filter((s) => !order.includes(s.id)),
      ]
    : SECTIONS;

  return (
    <ul role="list" class="-mx-2 space-y-1">
      {ordered.map((s) => {
        const current = s.id === section;
        // ONE box in both states. Padding, rounding and the row gap are
        // identical whether or not the label is showing, so collapsing the
        // rail changes its width and nothing else — the icons keep their
        // vertical rhythm instead of drifting apart. Only the horizontal
        // alignment differs, because a left-aligned icon in a narrow rail
        // reads as broken rather than as deliberate.
        const shape = "flex items-center rounded-md p-2 " + (compact ? "justify-center" : "gap-x-3");

        // A planned section is never a link and never a 404 — it renders
        // disabled WITH its reason, because a greyed-out word with no
        // explanation teaches that the product is broken rather than
        // unfinished (sections.ts). Collapsed, the reason moves into the
        // tooltip rather than disappearing.
        if (!isLive(s)) {
          const planned = s as Extract<Section, { status: "planned" }>;
          return (
            <li key={s.id}>
              <span
                class={shape + " cursor-not-allowed text-sm/6 font-semibold text-gray-500"}
                title={compact ? `${s.label} — ${planned.reason}` : planned.detail}
                aria-disabled="true"
              >
                <Icon id={s.id} className="size-6 shrink-0 opacity-40" />
                {!compact && (
                  <span class="flex flex-col">
                    {s.label}
                    <span class="text-xs font-normal text-gray-500">{planned.reason}</span>
                  </span>
                )}
              </span>
            </li>
          );
        }

        return (
          <li
            key={s.id}
            draggable={!!onReorder}
            onDragStart={(e) => e.dataTransfer?.setData("text/plain", s.id)}
            // Without preventDefault the drop never fires — the browser's
            // default for a dragover is "refuse this".
            onDragOver={(e) => onReorder && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer?.getData("text/plain") as SectionId | undefined;
              if (from && from !== s.id) onReorder?.(from, s.id);
            }}
          >
            <a
              href={s.href}
              onClick={onNavigate}
              title={compact ? s.label : undefined}
              aria-label={compact ? s.label : undefined}
              aria-current={current ? "page" : undefined}
              class={
                shape +
                " text-sm/6 font-semibold " +
                (current ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white")
              }
            >
              <Icon id={s.id} className="size-6 shrink-0" />
              {!compact && s.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The brand mark. `/mark.svg` is `art/stripped_favicon.svg` — the 128×128
 * mark drawn FOR small sizes — not the 1024×1024 `antlerO.svg`, whose fine
 * paths collapse into a flat pink/blue block at 32px (seen in the first
 * Kitesurf screenshot of the shell). A file rather than inlined markup so
 * `img-src 'self'` covers it and the paths stay out of every page's HTML.
 */
function Brand({ compact }: { compact?: boolean }) {
  return (
    <a href="/" class={"flex h-16 shrink-0 items-center gap-x-2 " + (compact ? "justify-center" : "")}>
      <img src="/mark.svg" alt="bullmoose" class="size-8" />
      {!compact && <span class="font-semibold tracking-tight text-white">bullmoose</span>}
    </a>
  );
}

export default function ShellNav({ section, email: emailProp }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // WHO IS SIGNED IN — sourced here, not passed in.
  //
  // `email` was a prop with no caller: AppTw.astro renders
  // `<ShellNav section={section} />` and nothing ever supplied it, so the
  // header read "Not signed in" on every page for every signed-in user while
  // their own mail was on screen (Eric's screenshot, 2026-08-17). The prop
  // survives for tests and for anyone who already knows the address.
  //
  // The layout CANNOT supply it: AppTw.astro is server-rendered and the
  // session is a browser-only bearer token, which is exactly why the shell is
  // `client:only`. So the chrome resolves it the same way every island does.
  //
  // Fails soft, and deliberately does NOT redirect: an unresolved session
  // leaves the chrome intact and lets the ISLAND route to /login. A nav bar
  // that navigates on its own would race the page it is framing.
  const [sessionEmail, setSessionEmail] = useState<string | undefined>(undefined);
  const email = emailProp ?? sessionEmail;
  // Starts wide, then adopts the stored preference on mount. Reading
  // localStorage during render would break hydration and throw in private
  // mode, so it happens in an effect.
  const [collapsed, setCollapsed] = useState(false);
  const [widthStep, setWidthStep] = useState(DEFAULT_WIDTH);
  const [order, setOrder] = useState<SectionId[]>([]);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Preferences are adopted on mount rather than read during render: reading
  // localStorage while rendering breaks hydration and throws in private mode.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
      const w = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isInteger(w) && w >= 0 && w < WIDTHS.length) setWidthStep(w);
      const stored = localStorage.getItem("bm.nav.order");
      if (stored) setOrder(JSON.parse(stored) as SectionId[]);
    } catch {
      /* private mode, or a stored value from an older shape — ship defaults */
    }
  }, []);

  useEffect(() => {
    if (emailProp) return;
    let cancelled = false;
    void (async () => {
      try {
        const resolved = resolveClient();
        if (resolved.mode === "unauthenticated") return;
        const live = await resolved.client.session();
        if (!cancelled) setSessionEmail(live.username);
      } catch {
        /* offline, expired token, unreachable server — the chrome still
           renders and the island owns the error. Saying nothing is better
           than the header claiming "Not signed in" about a live session. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [emailProp]);

  const persist = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* a preference is a nicety, not a requirement */
    }
  };

  const reorder = (from: SectionId, to: SectionId) => {
    setOrder((prev) => {
      const base = prev.length ? prev : SECTIONS.map((s) => s.id);
      const next = base.filter((id) => id !== from);
      next.splice(next.indexOf(to), 0, from);
      persist("bm.nav.order", JSON.stringify(next));
      return next;
    });
  };

  // Drag-to-resize, snapped to the allowed steps. Pointer events rather than
  // mouse events so a trackpad or touch drag behaves the same.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const step = nearestStep(e.clientX);
      setWidthStep((cur) => {
        if (cur !== step) persist(WIDTH_KEY, String(step));
        return step;
      });
    };
    const onUp = () => setDragging(false);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* preference is a nicety, not a requirement */
      }
      return next;
    });
  };

  // One Escape listener for both overlays. Two widgets each owning a global
  // key handler is how one of them ends up silently swallowing the other's.
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

  // Click-outside. The drawer needs this too now that it has NO backdrop —
  // without a scrim there is nothing to click on to dismiss it, and a panel
  // you can only close from one small button is worse than the scrim was.
  useEffect(() => {
    if (!menuOpen && !drawerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (drawerOpen && drawerRef.current && !drawerRef.current.contains(t)) setDrawerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, drawerOpen]);

  const size = collapsed ? COLLAPSED : WIDTHS[widthStep]!;

  // Keep the content wrapper's left padding in step with the rail. It lives
  // in the Astro layout, which is rendered before any preference is known, so
  // the sync happens here — by swapping classes, never an inline style.
  useEffect(() => {
    const el = document.getElementById("app-content");
    if (!el) return;
    el.classList.remove(COLLAPSED.pad, ...WIDTHS.map((w) => w.pad));
    el.classList.add(size.pad);
  }, [size.pad]);

  return (
    <>
      {/*
        Mobile drawer — slides in from the RIGHT, with no dimming scrim over
        the content behind it. That is a deliberate departure from the
        reference template, which drops a `bg-gray-900/80` backdrop over
        everything: the point of this panel is to move between sections while
        still seeing what you were reading, and a modal scrim actively fights
        that. It is also narrower (w-64, not max-w-xs on a full-width flex).

        Because there is no scrim it is NOT a modal, so it does not claim
        `aria-modal` — the click-outside handler above is what dismisses it.
      */}
      <div
        ref={drawerRef}
        class={
          "fixed inset-y-0 right-0 z-50 w-64 transform bg-gray-900 shadow-xl ring-1 ring-white/10 transition-transform duration-200 ease-out lg:hidden " +
          (drawerOpen ? "translate-x-0" : "pointer-events-none translate-x-full")
        }
        aria-hidden={!drawerOpen}
        aria-label="Sections"
      >
        <div class="flex h-full flex-col gap-y-5 overflow-y-auto px-4 pb-4">
          <div class="flex h-16 shrink-0 items-center justify-between">
            <Brand />
            <button type="button" onClick={() => setDrawerOpen(false)} class="p-2 text-gray-400 hover:text-white">
              <span class="sr-only">Close sections</span>
              <svg
                class="size-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width={1.5}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <nav class="flex flex-1 flex-col">
            <NavList section={section} order={order} onNavigate={() => setDrawerOpen(false)} />
          </nav>
        </div>
      </div>

      {/* Desktop rail — collapses to icons, and resizes between fixed steps */}
      <div class={"hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:flex-col " + size.rail}>
        <div
          class={
            "relative flex grow flex-col gap-y-5 overflow-y-auto bg-gray-900 pb-4 " + (collapsed ? "px-3" : "px-6")
          }
        >
          {/* Brand and the collapse toggle share a row, so the toggle is
              always in view — at the foot of a flex-1 nav it sat below the
              fold on a short viewport, which read as missing. Icon only. */}
          <div class={"flex h-16 shrink-0 items-center " + (collapsed ? "justify-center" : "justify-between")}>
            <Brand compact={collapsed} />
            {/* A visible control, not an artifact: the first cut was a bare
                gray-400 chevron on the dark rail — at that contrast it read
                as a rendering glitch (Eric's screenshot). A ring and a filled
                hover give it button affordance, and the double-chevron reads
                as "collapse" rather than "back". */}
            {!collapsed && (
              <button
                type="button"
                onClick={toggleCollapsed}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                aria-expanded={true}
                class="rounded-md p-1.5 text-gray-300 ring-1 ring-white/15 hover:bg-gray-800 hover:text-white hover:ring-white/30"
              >
                <svg
                  class="size-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width={2}
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m18.75 4.5-7.5 7.5 7.5 7.5m-6-15L5.25 12l7.5 7.5"
                  />
                </svg>
              </button>
            )}
          </div>

          <nav class="flex flex-1 flex-col">
            <NavList section={section} compact={collapsed} order={order} onReorder={reorder} />
          </nav>

          {collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              aria-expanded={false}
              class="-mx-2 flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            >
              <svg
                class="size-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width={1.5}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          )}
        </div>

        {/* Resize handle. Keyboard-operable too, because a control that only
            responds to a drag is unreachable for anyone who cannot make one. */}
        {!collapsed && (
          <button
            type="button"
            aria-label="Resize sidebar"
            aria-valuenow={widthStep}
            aria-valuemin={0}
            aria-valuemax={WIDTHS.length - 1}
            role="slider"
            onPointerDown={() => setDragging(true)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              setWidthStep((cur) => {
                const next = Math.min(WIDTHS.length - 1, Math.max(0, cur + d));
                persist(WIDTH_KEY, String(next));
                return next;
              });
            }}
            class="absolute inset-y-0 right-0 w-1.5 cursor-col-resize bg-transparent hover:bg-white/20 focus:bg-white/30 focus:outline-none"
          />
        )}
      </div>

      {/* Header */}
      <div
        class={
          "sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-xs sm:gap-x-6 sm:px-6 lg:px-8 dark:border-white/10 dark:bg-gray-900 " +
          size.pad
        }
      >
        <div class="flex flex-1 justify-end gap-x-4 self-stretch lg:gap-x-6">
          {/*
            Everything the person can do about themselves lives on the avatar —
            settings and sign-out included — rather than being scattered across
            the header. One place to look for "me".
          */}
          <div class="relative flex items-center" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              class="flex items-center gap-x-2 rounded-md p-1.5 text-sm/6 font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span class="sr-only">Open user menu</span>
              <span class="grid size-8 place-items-center rounded-full bg-gray-200 text-xs font-bold text-gray-700 dark:bg-white/10 dark:text-white">
                {(email ?? "?").slice(0, 1).toUpperCase()}
              </span>
              {/* nowrap + truncate: "Not signed in" wrapped to three lines
                  and blew the header open (second Kitesurf screenshot); a
                  long address gets an ellipsis instead of a second line. */}
              <span class="hidden max-w-56 lg:flex lg:items-center lg:gap-x-1 lg:whitespace-nowrap">
                <span class="truncate">{email ?? "Not signed in"}</span>
                <svg class="size-5 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fill-rule="evenodd"
                    d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                    clip-rule="evenodd"
                  />
                </svg>
              </span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                class="absolute top-full right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 dark:bg-gray-800 dark:ring-white/10"
              >
                <a
                  role="menuitem"
                  href="/settings"
                  class="block px-3 py-1 text-sm/6 text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                >
                  Settings
                </a>
                <a
                  role="menuitem"
                  href="/agents"
                  class="block px-3 py-1 text-sm/6 text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                >
                  Your agents
                </a>
                <button
                  role="menuitem"
                  type="button"
                  class="block w-full px-3 py-1 text-left text-sm/6 text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                  onClick={() => {
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

          {/* Drawer toggle, right-hand side so it sits beside the panel it
              opens rather than across the screen from it. */}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            class="-m-2.5 p-2.5 text-gray-700 lg:hidden dark:text-gray-200"
            aria-expanded={drawerOpen}
          >
            <span class="sr-only">Open sections</span>
            <svg
              class="size-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width={1.5}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
