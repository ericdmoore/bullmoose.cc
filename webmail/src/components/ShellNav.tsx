/** @jsxImportSource preact */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { SECTIONS, type Section, type SectionId } from "../lib/app/sections";
import { realmSelectClasses, searchFieldClasses, searchYieldClasses } from "../lib/ui/classes";
import { toggleExpansion } from "../lib/shell/collections";
import {
  COLLECTIONS_EVENT,
  isStale,
  publishedAtLabel,
  readPublished,
  type PublishedCollections,
} from "../lib/shell/publish";
import {
  REALM_CHROME_EVENT,
  currentRealmChrome,
  isRenderableControl,
  pickRealmChrome,
  type RealmChromeControl,
} from "../lib/shell/realmChrome";
import {
  Bars3Icon,
  CalendarIcon,
  CheckBadgeIcon,
  ChevronDoubleLeftIcon,
  ChevronDownMiniIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  FlagIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  UsersIcon,
  XMarkIcon,
  type IconProps,
} from "./icons";

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
  /**
   * The active realm's one chrome control (s34) — normally arrives over
   * `bm:realm-chrome` from the surface island; passed directly in tests and
   * for anything that already knows it. See `lib/shell/realmChrome.ts` for
   * why this is an event contract rather than a portal.
   */
  realmControl?: RealmChromeControl;
}

const COLLAPSE_KEY = "bm.nav.collapsed";

/**
 * s24 T5 — the contextual top-bar filter. ONE rule, uniform: the bar filters
 * the ACTIVE realm's collection. Scope, placeholder and syntax key off the
 * active section; a realm without a wired consumer renders no bar (progressive
 * absorption, not a dead input). Submission NEVER navigates (the s07 T1
 * invariant + CSP form-action 'none'): it dispatches a `bm:search` CustomEvent
 * the active surface island consumes. Inbound deep links (`?q=`) still work —
 * each surface reads them at mount.
 *
 * s25 T5 collapses this bar below `lg` to a magnifier that expands in place.
 * The COLLAPSE IS PURELY PRESENTATIONAL: same `<form>`, same input, same
 * `bm-global-search` id, same event. A tap toggles a class, it does not
 * navigate and it does not add an entry to history — the two invariants
 * tokenInUrl.test.ts enforces over this exact file.
 */
const SEARCHABLE: Partial<Record<SectionId, { placeholder: string; hint?: string }>> = {
  mail: {
    placeholder: "Search mail — from:  to:  subject:  is:unread  has:attachment",
    hint: "Searches subject, sender, recipients and full message bodies. Matches whole words.",
  },
  contacts: {
    placeholder: "Search contacts",
    hint: "Names, nicknames, organizations, email addresses, phone numbers and notes.",
  },
  agents: {
    placeholder: "Filter agents",
    hint: "Filters the realm's agent list — binding name, address, pipeline.",
  },
  notes: {
    placeholder: "Filter notes",
    hint: "Scans every note's title and body — there is no index behind it.",
  },
  search: {
    placeholder: "Find in your history",
    hint: "Starts a new Finder session over your own mail \u2014 refine with chips from there.",
  },
  // #225 — the four realms that had a collection to filter and no bar over
  // it. Settings is deliberately absent still: it is a set of SECTIONS, not
  // a collection, and a filter that filters nothing is worse than none (the
  // rule this issue is enforcing, applied honestly rather than uniformly).
  approvals: {
    placeholder: "Filter approvals",
    hint: "Filters the queue in view — agent, subject and the proposed act.",
  },
  activity: {
    placeholder: "Filter activity",
    hint: "Filters the feed in view — what happened, and who did it.",
  },
  files: {
    placeholder: "Filter files",
    hint: "Filters this folder's names. Contents are not searched.",
  },
  goals: {
    placeholder: "Filter goals",
    hint: "Filters by the goal's own statement.",
  },
};
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

/** Section → glyph, from the icon library (s24 T0). The paths that used to
 *  be inlined here are now `components/icons/*` — source we own, one file per
 *  glyph, render-tested. */
const SECTION_ICON: Record<SectionId, (p: IconProps) => JSX.Element> = {
  approvals: CheckBadgeIcon,
  agents: RobotIcon,
  activity: ClockIcon,
  goals: FlagIcon,
  calendar: CalendarIcon,
  mail: EnvelopeIcon,
  contacts: UsersIcon,
  notes: DocumentTextIcon,
  files: FolderIcon,
  search: MagnifyingGlassIcon,
  settings: Cog6ToothIcon,
};

function Icon({ id, className }: { id: SectionId; className: string }) {
  const Glyph = SECTION_ICON[id];
  return <Glyph class={className} />;
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
 * The realm tray (s25 T4) — the mobile drawer's nav list, grown leaf-nodes.
 *
 * Realm rows come from `sections.ts` exactly as the rail's do; what GROWS is
 * that a realm whose surface has PUBLISHED its collections (lib/shell/
 * publish.ts) gets a chevron and expands them inline — `Mail ▸ Inbox 12 ·
 * Sent`, one tap from anywhere to Mail→Sent. The Gmail-drawer pattern, and
 * Eric's "merge Realm + Category" made real.
 *
 * The rendering is the CollectionTree idiom (CollectionColumn.tsx): the
 * chevron is its own button BESIDE the row (a button inside a link is invalid
 * HTML), expansion is a class-swapped rotate-90, and the expansion set is the
 * same pure `toggleExpansion`. The tree component itself is deliberately NOT
 * reused: its rows are `onSelect` BUTTONS for surfaces that own in-page
 * state, and the tray's rows must be literal `<a href>` — real MPA
 * navigation, zero history calls, which is exactly the shape the
 * tokenInUrl.test.ts sweep allows without exception.
 *
 * Honesty rules, straight from the plumbing contract:
 *   unpublished realm  → a plain row, no chevron (absence is not an error);
 *   stale (>10 min)    → counts muted, with "as of 9:12" naming the instant;
 *   planned section    → disabled with its reason, same as the rail.
 *
 * Pure given its props (published data, expansion set, clock all injected),
 * so it render-tests in plain Node like every other piece of this chrome.
 * The desktop rail is UNCHANGED — it keeps NavList.
 */
export function RealmTray({
  section,
  onNavigate,
  order,
  published,
  expandedIds,
  onToggle,
  now = Date.now(),
  sections = SECTIONS,
}: {
  section?: SectionId;
  onNavigate?: () => void;
  /** The user's own order, if they have set one — same preference the rail honours. */
  order?: SectionId[];
  /** What each realm last published; a missing key renders a plain row. */
  published: Partial<Record<SectionId, PublishedCollections>>;
  /** Realm ids whose leaf-nodes are showing. */
  expandedIds: ReadonlySet<string>;
  onToggle: (id: SectionId) => void;
  /** The staleness clock — injected so tests are deterministic. */
  now?: number;
  /** Test seam: every shipped section is live today, so the planned-row
   *  branch is only reachable with a fabricated roster. */
  sections?: readonly Section[];
}) {
  // The same preference-over-shipped merge NavList does: unknown ids append,
  // so a section added later still appears for someone who reordered.
  const ordered = order?.length
    ? [
        ...order.map((id) => sections.find((s) => s.id === id)).filter((s): s is Section => !!s),
        ...sections.filter((s) => !order.includes(s.id)),
      ]
    : sections;

  return (
    <ul role="list" class="-mx-2 space-y-1">
      {ordered.map((s) => {
        const current = s.id === section;
        const shape = "flex items-center rounded-md p-2 gap-x-3";

        if (s.status !== "live") {
          // The planned-section idiom, unchanged from the rail: disabled WITH
          // its reason, never a dead row and never a 404.
          return (
            <li key={s.id}>
              <span
                class={shape + " cursor-not-allowed text-sm/6 font-semibold text-gray-500"}
                title={s.detail}
                aria-disabled="true"
              >
                <Icon id={s.id} className="size-6 shrink-0 opacity-40" />
                <span class="flex flex-col">
                  {s.label}
                  <span class="text-xs font-normal text-gray-500">{s.reason}</span>
                </span>
              </span>
            </li>
          );
        }

        const record = published[s.id];
        const leaves = record?.items ?? [];
        const open = leaves.length > 0 && expandedIds.has(s.id);
        const stale = record !== undefined && isStale(record, now);

        return (
          <li key={s.id}>
            <div class="flex items-center gap-x-0.5">
              <a
                href={s.href}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                class={
                  shape +
                  " min-w-0 grow text-sm/6 font-semibold " +
                  (current ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white")
                }
              >
                <Icon id={s.id} className="size-6 shrink-0" />
                <span class="truncate">{s.label}</span>
              </a>
              {leaves.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onToggle(s.id)}
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${s.label} collections`}
                  class="shrink-0 rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
                >
                  <ChevronRightIcon
                    class={"size-4 transition-transform duration-150 " + (open ? "rotate-90" : "")}
                    strokeWidth={2}
                  />
                </button>
              ) : null}
            </div>
            {open && record ? (
              <ul role="list" class="mt-0.5 space-y-0.5">
                {leaves.map((item) => (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      onClick={onNavigate}
                      class="flex items-center gap-x-2 rounded-md py-1.5 pr-2 pl-11 text-sm text-gray-400 hover:bg-gray-800 hover:text-white"
                    >
                      <span class="min-w-0 grow truncate">{item.label}</span>
                      {item.count ? (
                        <span class={"shrink-0 text-xs tabular-nums " + (stale ? "text-gray-600" : "text-gray-400")}>
                          {item.count}
                        </span>
                      ) : null}
                    </a>
                  </li>
                ))}
                {stale ? (
                  // Staleness is honest: the muted counts above are dated out
                  // loud, not passed off as live.
                  <li class="py-0.5 pr-2 pl-11 text-xs text-gray-600">as of {publishedAtLabel(record.at)}</li>
                ) : null}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The brand mark: `/antlerO.svg` (`art/antlerO.svg`), restored 2026-08-20.
 *
 * It was swapped for `/mark.svg` in #166 on the grounds that its fine paths
 * "collapse into a flat pink/blue block at 32px" — an observation made from
 * "the first Kitesurf screenshot of the shell". Kitesurf turned out to be
 * Cloudflare's Boa/WASM browser, NOT Chromium, and it renders this app wrong
 * enough to have manufactured a phantom bug we chased twice (see the s25
 * harness note). A design decision resting on that renderer is a decision
 * resting on nothing, so the mark comes back and a human judges it in a real
 * browser.
 *
 * `mark.svg` stays in `public/` — it is the right file for a genuinely tiny
 * target if one is ever needed, and deleting it would only make this
 * reversible in one direction.
 *
 * A file rather than inlined markup so `img-src 'self'` covers it and the
 * paths stay out of every page's HTML.
 */
function Brand({ compact }: { compact?: boolean }) {
  return (
    <a href="/" class={"flex h-16 shrink-0 items-center gap-x-2 " + (compact ? "justify-center" : "")}>
      <img src="/antlerO.svg" alt="bullmoose" class="size-8" />
      {!compact && <span class="font-semibold tracking-tight text-white">bullmoose</span>}
    </a>
  );
}

export default function ShellNav({ section, email: emailProp, realmControl: controlProp }: Props) {
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
  // Two states could not express three. `email === undefined` meant BOTH "not
  // resolved yet" and "resolved, nobody" — so the chip had to pick one, picked
  // "Not signed in", and asserted it during every render before the session
  // came back. That is what forced the whole shell to `client:only`: rendering
  // nothing was the only way to avoid rendering a falsehood.
  //
  // With `settled` the chip can say nothing while it does not know, which is
  // what lets the rail be SERVER-RENDERED — and the rail not being there at
  // all is the flash Eric filmed on 2026-08-22.
  const [settled, setSettled] = useState(false);
  const email = emailProp ?? sessionEmail;
  // Starts wide, then adopts the stored preference on mount. Reading
  // localStorage during render would break hydration and throw in private
  // mode, so it happens in an effect.
  const [collapsed, setCollapsed] = useState(false);
  const [widthStep, setWidthStep] = useState(DEFAULT_WIDTH);
  const [order, setOrder] = useState<SectionId[]>([]);
  const [dragging, setDragging] = useState(false);
  // s34 — the active realm's one chrome control (Contacts' account picker).
  // Same shape as `sessionEmail` above: a prop wins, otherwise the chrome
  // sources it itself. The latch read runs alongside the subscription because
  // the surface island may have published BEFORE this one hydrated —
  // `lib/shell/realmChrome.ts` has the whole argument.
  const [publishedControl, setPublishedControl] = useState<RealmChromeControl | undefined>(undefined);
  const realmControl = controlProp ?? publishedControl;
  // s24 T5 — the contextual bar's realm + the deep-linked query (read once;
  // the island mounts after navigation, so location is settled).
  const searchable = section ? SEARCHABLE[section] : undefined;
  const [initialQ] = useState(() => {
    try {
      return new URLSearchParams(globalThis.location?.search ?? "").get("q") ?? "";
    } catch {
      return "";
    }
  });

  // s25 T4 — the realm tray's data: what each surface has published for the
  // drawer's leaf-nodes. Read on mount and re-read on every `bm:collections`
  // (a surface publishing while the chrome is up) and on drawer open (a
  // cheap freshness pass, so the staleness verdict is judged at look time).
  // s25 T5 — the narrow-screen search state. Below `lg` the contextual bar is
  // a magnifier until you tap it; at `lg` and up this flag is inert (the field
  // is always shown, the trigger never rendered). Not persisted: an expanded
  // search is a moment, not a preference.
  const [searchOpen, setSearchOpen] = useState(false);
  // The form element, so a click landing anywhere else can close it.
  const searchBoxRef = useRef<HTMLFormElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [published, setPublished] = useState<Partial<Record<SectionId, PublishedCollections>>>({});
  // Which realms are showing their leaves. Session state, not a preference:
  // a drawer you summon is re-read each time, unlike the resident rail.
  const [trayOpenIds, setTrayOpenIds] = useState<ReadonlySet<string>>(new Set());

  const menuRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const readAll = () => {
      const next: Partial<Record<SectionId, PublishedCollections>> = {};
      for (const s of SECTIONS) {
        const record = readPublished(s.id);
        if (record) next[s.id] = record;
      }
      setPublished(next);
    };
    readAll();
    globalThis.addEventListener(COLLECTIONS_EVENT, readAll);
    return () => globalThis.removeEventListener(COLLECTIONS_EVENT, readAll);
  }, [drawerOpen]);

  // s34 — the realm chrome control. The mount-time `currentRealmChrome()`
  // read is not an optimisation: island hydration order is undefined, so a
  // surface that published before this component mounted would otherwise
  // never be heard. Skipped entirely when a caller supplied the control.
  useEffect(() => {
    if (controlProp) return;
    const adopt = () => setPublishedControl(currentRealmChrome());
    adopt();
    globalThis.addEventListener(REALM_CHROME_EVENT, adopt);
    return () => globalThis.removeEventListener(REALM_CHROME_EVENT, adopt);
  }, [controlProp]);

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
    if (emailProp) {
      setSettled(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resolved = resolveClient();
        if (resolved.mode === "unauthenticated") {
          if (!cancelled) setSettled(true);
          return;
        }
        const live = await resolved.client.session();
        if (!cancelled) {
          setSessionEmail(live.username);
          setSettled(true);
        }
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

  // One Escape listener for every overlay. Widgets each owning a global key
  // handler is how one of them ends up silently swallowing the other's.
  // s25 T5 folded the expanded narrow search in here for the same reason.
  useEffect(() => {
    if (!drawerOpen && !menuOpen && !searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setDrawerOpen(false);
      setSearchOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, menuOpen, searchOpen]);

  // Expanding puts the caret where the person is already looking. It happens
  // in an effect, not in the click handler: the field is `max-lg:hidden` until
  // this render lands, and focusing a display:none input is a no-op.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // Click-outside. The drawer needs this too now that it has NO backdrop —
  // without a scrim there is nothing to click on to dismiss it, and a panel
  // you can only close from one small button is worse than the scrim was.
  useEffect(() => {
    if (!menuOpen && !drawerOpen && !searchOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (drawerOpen && drawerRef.current && !drawerRef.current.contains(t)) setDrawerOpen(false);
      // Clicking away closes the search. Nothing is discarded: the field stays
      // mounted (the collapse is width, not `display: none`) and the input is
      // uncontrolled, so whatever was typed is still there on reopen. Closing
      // is putting it away, not throwing it out.
      if (searchOpen && searchBoxRef.current && !searchBoxRef.current.contains(t)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // `searchOpen` belongs here: without it the listener is never re-bound
    // when the search opens, so the closure keeps the value from the render
    // that installed it and the search never closes on an outside click.
  }, [menuOpen, drawerOpen, searchOpen]);

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
              <XMarkIcon class="size-6" />
            </button>
          </div>
          <nav class="flex flex-1 flex-col">
            {/* s25 T4 — the drawer is the realm TRAY: NavList's rows grown
                published leaf-nodes. The desktop rail below keeps NavList. */}
            <RealmTray
              section={section}
              order={order}
              onNavigate={() => setDrawerOpen(false)}
              published={published}
              expandedIds={trayOpenIds}
              onToggle={(id) => setTrayOpenIds((prev) => toggleExpansion(prev, id))}
            />
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
            {/* A visible control, not an artifact: a pale filled chip on the
                dark rail so the double-chevron reads as a button, not a
                rendering glitch. */}
            {!collapsed && (
              <button
                type="button"
                onClick={toggleCollapsed}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                aria-expanded={true}
                class="rounded-md bg-gray-200 p-1.5 text-gray-900 hover:bg-white"
              >
                <ChevronDoubleLeftIcon class="size-4" strokeWidth={2} />
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
              class="-mx-2 flex items-center justify-center rounded-md bg-gray-200 p-2 text-gray-900 hover:bg-white"
            >
              <ChevronRightIcon class="size-6" />
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
        <div class="flex flex-1 items-center gap-x-4 self-stretch lg:gap-x-6">
          {/* s24 T5 — the contextual filter: one bar whose meaning is wherever
              you are standing. Prefilled from `?q=` so a deep-linked search
              stays visible and refinable. */}
          {/*
            s25 T5 — THE COLLAPSE. Below `lg` the bar is a magnifier that
            expands IN PLACE; the field is the same element either way, so the
            `bm:search` plumbing under it is untouched — no navigation, no
            second input, no `id` that appears twice in one document
            (`bm-global-search` is what surfaces and tests reach for).
            The collapse applies at EVERY width now — a resting header that
            spends its whole span on an input whose placeholder teaches query
            syntax was the thing worth fixing, and the desktop had it worst.
          */}
          {searchable && !searchOpen ? (
            <>
              {/* One gap-unit in, beyond the header's own padding. The
                  trigger is the first thing after the rail, and on container
                  padding alone it read as crowded against the rail edge
                  rather than as the start of the header's content. `ml-4`
                  rather than an eyeballed value because the header already
                  spaces its items `gap-x-4` — the icon now sits at the same
                  rhythm as everything beside it instead of at its own. */}
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-expanded={false}
                aria-controls="bm-global-search"
                class="ml-4 rounded-md p-2 text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
              >
                <span class="sr-only">{searchable.placeholder}</span>
                <MagnifyingGlassIcon class="size-5" />
              </button>
              {/* The collapsed bar still holds the space the field will take,
                  so the avatar does not slide across the header on expand. */}
              <div class="flex-1" />
            </>
          ) : null}
          {searchable ? (
            <form
              ref={searchBoxRef}
              class={searchFieldClasses(searchOpen)}
              onSubmit={(ev) => {
                // No navigation, ever (tokenInUrl.test.ts holds this file to
                // it, and the generated CSP's form-action 'none' would refuse
                // one regardless). The bar FILTERS THE ACTIVE REALM: submit
                // dispatches to the surface island, which owns the search
                // state. Cross-realm finding is the Search realm's job.
                ev.preventDefault();
                const q = (ev.currentTarget.elements.namedItem("q") as HTMLInputElement | null)?.value ?? "";
                globalThis.dispatchEvent(new CustomEvent("bm:search", { detail: { q } }));
              }}
            >
              <label class="relative block w-full">
                <MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400" />
                <span class="sr-only">{searchable.placeholder}</span>
                <input
                  ref={searchRef}
                  id="bm-global-search"
                  name="q"
                  type="search"
                  defaultValue={initialQ}
                  placeholder={searchable.placeholder}
                  title={searchable.hint}
                  class="w-full rounded-md bg-gray-100 py-1.5 pr-3 pl-9 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-2 focus:-outline-offset-1 focus:outline-brand-600 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500"
                />
              </label>
              {/* The way back. An expanded search that can only be dismissed
                  by Escape strands anyone on a phone, which has no Escape. */}
              {searchOpen ? (
                <button
                  type="button"
                  onClick={() => setSearchOpen(false)}
                  class="ml-1 shrink-0 rounded-md p-2 text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                >
                  <span class="sr-only">Close search</span>
                  <XMarkIcon class="size-5" />
                </button>
              ) : null}
            </form>
          ) : (
            <div class="flex-1" />
          )}
          {/*
            s34 — THE REALM'S OWN CONTROL, top-right, beside the identity chip.

            Contacts' account picker used to sit in the section's private
            `<header class="topbar">`, a full row below the real chrome, which
            put "which account" one row away from "who am I" — the two facts
            that qualify everything else on the page. It belongs here.

            The chrome owns none of it: the surface island publishes the
            options and receives the pick (`lib/shell/realmChrome.ts`), so
            adding a second realm's control costs a publish call and nothing
            here. A control with fewer than two options never renders —
            `isRenderableControl` — which is what keeps this invisible for the
            single-account session that most people have.

            It yields to the narrow search like every other header control,
            and the label hides below `lg` (the `<select>` keeps it as its
            accessible name) so the phone header stays one row.
          */}
          {isRenderableControl(realmControl, section) ? (
            <div class={"flex min-w-0 items-center gap-x-1.5 " + searchYieldClasses(searchOpen)}>
              <span class="hidden shrink-0 text-xs text-gray-500 lg:inline dark:text-gray-400">
                {realmControl.label}
              </span>
              <select
                aria-label={realmControl.label}
                value={realmControl.selectedId}
                class={realmSelectClasses()}
                onChange={(ev) => pickRealmChrome(realmControl.realm, (ev.currentTarget as HTMLSelectElement).value)}
              >
                {realmControl.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {/*
            Everything the person can do about themselves lives on the avatar —
            settings and sign-out included — rather than being scattered across
            the header. One place to look for "me".
          */}
          {/* While the search is expanded these step aside, so the field gets
              the whole bar rather than a 90px slot — at every width now, not
              just below `lg`. This is the "expands beyond its current width"
              half: the open field is wider than the resting bar ever was. */}
          <div class={"relative flex items-center " + searchYieldClasses(searchOpen)} ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              class="flex items-center gap-x-2 rounded-md p-1.5 text-sm/6 font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span class="sr-only">Open user menu</span>
              {/* Neutral while unknown — an empty circle, not a "?" and not an
                  initial. A blank shape resolving into your monogram reads as
                  loading; a wrong letter resolving into a right one reads as a
                  bug. Same line s35 drew for skeletons: stand where the
                  content goes and claim nothing. */}
              <span
                class="grid size-8 place-items-center rounded-full bg-gray-200 text-xs font-bold text-gray-700 dark:bg-white/10 dark:text-white"
                aria-hidden={email === undefined ? "true" : undefined}
              >
                {email === undefined ? "" : email.slice(0, 1).toUpperCase()}
              </span>
              {/* nowrap + truncate: "Not signed in" wrapped to three lines
                  and blew the header open (second Kitesurf screenshot); a
                  long address gets an ellipsis instead of a second line. */}
              <span class="hidden max-w-56 lg:flex lg:items-center lg:gap-x-1 lg:whitespace-nowrap">
                {/* "Not signed in" is a CLAIM, and it may only be made once
                    the session has actually answered. Before that the slot is
                    empty rather than wrong. */}
                <span class="truncate">{email ?? (settled ? "Not signed in" : "")}</span>
                <ChevronDownMiniIcon class="size-5 shrink-0 text-gray-400" />
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
            class={"-m-2.5 p-2.5 text-gray-700 lg:hidden dark:text-gray-200 " + searchYieldClasses(searchOpen)}
            aria-expanded={drawerOpen}
          >
            <span class="sr-only">Open sections</span>
            <Bars3Icon class="size-6" />
          </button>
        </div>
      </div>
    </>
  );
}
