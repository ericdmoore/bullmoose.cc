// The PURE class-logic behind the T0 primitives (s24). The components in
// `components/ui/` are markup over these functions — the same thin-component /
// tested-logic split every island follows (ApprovalsQueue → lib/approvals).
// Everything here returns Tailwind utility strings built on the shell's brand
// palette (styles/tailwind.css) so a primitive matches the chrome by default.

/** Join class fragments, dropping the falsy — the one string-builder every
 *  primitive shares. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

// `whitespace-nowrap min-w-0` is the s34 fix, and it is load-bearing rather
// than cosmetic: in the `w-56` collection column the [New] button is a `grow`
// flex item, so "New contact" broke across two lines as "+ New / contact"
// (Eric's /contacts screenshot, 2026-08-20). A button label that wraps is
// almost always a bug — the label is a verb, not a paragraph — so the rule
// lives on the base rather than on one caller. `min-w-0` is what lets the
// button shrink at all, which is what makes the label's `truncate` (see
// `createLabelClasses`) able to ellipsis instead of overflowing.
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-x-1.5 rounded-md font-semibold whitespace-nowrap min-w-0 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 " +
  "disabled:opacity-50 disabled:pointer-events-none";

/** The standardized [New] SURFACE (s24 Decision 8) — colour and hover only,
 *  no elevation. Split out because the FAB (s25 T5) is the same verb in a
 *  different position: it must read as the same button while carrying a
 *  floating shadow instead of the flat one. Sharing the string is what keeps
 *  "same verb" true rather than merely claimed. */
const PRIMARY_SURFACE = "bg-brand-600 text-white hover:bg-brand-500";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // The standardized [New] look (s24 Decision 8) — one primary, everywhere.
  primary: `${PRIMARY_SURFACE} shadow-xs`,
  secondary:
    "bg-white text-gray-900 shadow-xs ring-1 ring-inset ring-gray-300 hover:bg-gray-50 " +
    "dark:bg-white/10 dark:text-white dark:ring-white/10 dark:hover:bg-white/20",
  ghost: "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10",
  danger: "bg-white text-red-700 shadow-xs ring-1 ring-inset ring-red-200 hover:bg-red-50",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-2.5 py-1.5 text-sm",
};

export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size]);
}

/**
 * The [New] button's LABEL span (s34) — one line, an ellipsis rather than a
 * second line.
 *
 * Shared by `CollectionColumn`'s header button and `CollectionBar`'s, so
 * every realm's create verb behaves the same at a narrow column width: Mail's
 * "New message", Contacts' "New contact", Finder's "New find". Truncating is
 * the lesser evil — a clipped "New conta…" still reads as one verb, where
 * "+ New / contact" reads as a broken layout and steals a line of the
 * toolbar's height.
 *
 * NOT applied to `CreateFab`: the FAB is a `fixed`, shrink-to-fit element with
 * no width to truncate against, and its label is the entire point of it being
 * extended rather than a bare "+" (s25 T5). It carries its own
 * `whitespace-nowrap` and keeps it.
 */
export function createLabelClasses(): string {
  return "min-w-0 truncate";
}

/**
 * The realm-chrome picker in the shared top bar (s34) — the one control a
 * surface may hang beside the identity chip (`lib/shell/realmChrome.ts`).
 *
 * Sized to the 64px header row and capped in width, because the thing it
 * usually holds is an email address: unclamped, a long account name pushes
 * the identity chip off the bar, which is the exact failure the chip's own
 * `max-w-56 truncate` already fixed once.
 */
export function realmSelectClasses(): string {
  return cx(
    "max-w-40 truncate rounded-md bg-gray-100 px-2 py-1 text-sm text-gray-900",
    "focus:outline-2 focus:-outline-offset-1 focus:outline-brand-600",
    "dark:bg-white/5 dark:text-white",
  );
}

/** Square padding for an icon-only button; the label goes sr-only. */
export function iconButtonClasses(size: ButtonSize = "md", opts: { active?: boolean } = {}): string {
  return cx(
    BUTTON_BASE,
    opts.active
      ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-500/30 dark:bg-white/10 dark:text-brand-100"
      : BUTTON_VARIANT.ghost,
    size === "sm" ? "p-1" : "p-1.5",
  );
}

export type BadgeTone = "neutral" | "accent" | "warn" | "error" | "success";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300",
  accent: "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-100",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200",
  error: "bg-red-100 text-red-700 dark:bg-red-400/20 dark:text-red-200",
  success: "bg-green-100 text-green-700 dark:bg-green-400/20 dark:text-green-200",
};

export function badgeClasses(tone: BadgeTone = "neutral"): string {
  return cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium", BADGE_TONE[tone]);
}

export type AvatarSize = "sm" | "md" | "lg";

const AVATAR_SIZE: Record<AvatarSize, string> = {
  sm: "size-6 text-xs",
  md: "size-8 text-sm",
  lg: "size-10 text-base",
};

export function avatarClasses(size: AvatarSize = "md"): string {
  return cx(
    "inline-flex items-center justify-center rounded-full bg-brand-600 font-medium text-white select-none",
    AVATAR_SIZE[size],
  );
}

/** The initial an avatar shows — first grapheme of the name or address, upper-
 *  cased; "?" for the empty/unknown (the ShellNav convention). */
export function avatarInitial(nameOrEmail: string | undefined | null): string {
  const s = (nameOrEmail ?? "").trim();
  return s === "" ? "?" : s.slice(0, 1).toUpperCase();
}

/** A selectable row in a list/collection — the active state is the approvals
 *  header-list treatment, so selection reads the same in every realm. */
export function listRowClasses(opts: { active?: boolean; muted?: boolean } = {}): string {
  return cx(
    "flex w-full items-center gap-x-2 rounded-md px-2 py-1.5 text-left text-sm",
    opts.active ? "bg-brand-50 ring-1 ring-brand-500/30 dark:bg-white/10" : "hover:bg-gray-50 dark:hover:bg-white/5",
    opts.muted ? "text-gray-500" : "text-gray-900 dark:text-white",
  );
}

// ── Tailwind UI ports (alerts, empty states, stacked lists, forms) ────────
//
// Markup + classes from `webmail/referenceTemplates/astro/` (the licensed kit),
// indigo swapped for brand so these match the chrome. Second callers earned
// each of these: Approvals, Mail, Agents, Files, Activity, Goals.

export type AlertTone = "info" | "warn" | "error" | "success";

const ALERT_TONE: Record<AlertTone, string> = {
  info: "bg-brand-50 dark:bg-brand-500/10 dark:outline dark:outline-brand-500/20",
  warn: "bg-yellow-50 dark:bg-yellow-500/10 dark:outline dark:outline-yellow-500/15",
  error: "bg-red-50 dark:bg-red-500/10 dark:outline dark:outline-red-500/15",
  success: "bg-green-50 dark:bg-green-500/10 dark:outline dark:outline-green-500/15",
};

const ALERT_TITLE: Record<AlertTone, string> = {
  info: "text-brand-800 dark:text-brand-100",
  warn: "text-yellow-800 dark:text-yellow-100",
  error: "text-red-800 dark:text-red-100",
  success: "text-green-800 dark:text-green-100",
};

const ALERT_BODY: Record<AlertTone, string> = {
  info: "text-brand-700 dark:text-brand-100/80",
  warn: "text-yellow-700 dark:text-yellow-100/80",
  error: "text-red-700 dark:text-red-100/80",
  success: "text-green-700 dark:text-green-100/80",
};

const ALERT_ICON: Record<AlertTone, string> = {
  info: "text-brand-400 dark:text-brand-300",
  warn: "text-yellow-400 dark:text-yellow-300",
  error: "text-red-400 dark:text-red-300",
  success: "text-green-400 dark:text-green-300",
};

export function alertClasses(tone: AlertTone = "info"): string {
  return cx("rounded-md p-4", ALERT_TONE[tone]);
}
export function alertTitleClasses(tone: AlertTone = "info"): string {
  return cx("text-sm font-medium", ALERT_TITLE[tone]);
}
export function alertBodyClasses(tone: AlertTone = "info"): string {
  return cx("text-sm", ALERT_BODY[tone]);
}
export function alertIconClasses(tone: AlertTone = "info"): string {
  return cx("size-5", ALERT_ICON[tone]);
}

/** The divided stacked-list (Tailwind UI `lists/stacked-lists/01-simple`). */
export function stackedListClasses(): string {
  return "divide-y divide-gray-100 dark:divide-white/5";
}

export function stackedRowClasses(opts: { active?: boolean } = {}): string {
  return cx(
    "relative flex w-full items-center gap-x-4 py-4 pr-2 pl-2 text-left",
    opts.active ? "bg-brand-50 dark:bg-white/5" : "hover:bg-gray-50 dark:hover:bg-white/[0.03]",
  );
}

export type StatusDotTone = "neutral" | "success" | "warn" | "error";

export function statusDotClasses(tone: StatusDotTone = "neutral"): string {
  const ring: Record<StatusDotTone, string> = {
    neutral: "bg-gray-100/80 text-gray-500 dark:bg-white/10",
    success: "bg-green-100 text-green-500 dark:bg-green-400/20 dark:text-green-400",
    warn: "bg-amber-100 text-amber-500 dark:bg-amber-400/20 dark:text-amber-400",
    error: "bg-rose-100 text-rose-500 dark:bg-rose-400/20 dark:text-rose-400",
  };
  return cx("flex-none rounded-full p-1", ring[tone]);
}

/** Form fields (Tailwind UI `forms/input-groups`) — brand outline, never indigo. */
export function inputClasses(): string {
  return (
    "block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 " +
    "outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-brand-600 " +
    "sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 " +
    "dark:focus:outline-brand-500"
  );
}

// ── s25 T5: the phone's chrome ────────────────────────────────────────────
//
// TWO RULES hold every string below, and both are load-bearing:
//
//  1. NO INLINE STYLE. Positioning, the safe-area insets and every transition
//     are utility classes, because the generated CSP carries a `style-src`
//     with no 'unsafe-inline' (ShellNav.tsx explains why that stays).
//  2. SHOW/HIDE IS ALWAYS VARIANT-SCOPED (`lg:hidden`, `max-lg:hidden`), never
//     a bare `hidden` fighting a bare `flex`. Two display utilities with no
//     variant between them resolve by Tailwind's own source order, not by the
//     order you typed them — a coin flip. A variant always wins over the
//     unvariant base, so the breakpoint decides and the class list reads true.

/**
 * The floating action button (s25 T5) — the realm's [New], moved into the
 * thumb zone on a phone. Bottom-right, above `env(safe-area-inset-bottom)` so
 * it clears the home indicator (the T1 groundwork), and `lg:hidden` because
 * the desktop already has the column's button and two of the same verb on one
 * screen is one too many.
 *
 * Extended (icon + words), not a bare `+`: the label is the whole point —
 * "New message" in Mail, "New contact" in Contacts, "New find" in Finder —
 * and an unlabelled circle turns a realm-contextual verb into a guess.
 */
export function fabClasses(): string {
  return cx(
    "fixed right-4 bottom-4 z-40 inline-flex items-center gap-x-2",
    "mr-[env(safe-area-inset-right)] mb-[env(safe-area-inset-bottom)]",
    "rounded-full px-4 py-3 text-sm font-semibold shadow-lg",
    PRIMARY_SURFACE,
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
    "disabled:pointer-events-none disabled:opacity-50",
    "lg:hidden",
  );
}

/**
 * How much room a fixed FAB needs at the foot of a scroll container. The rule
 * the plan is explicit about: the button must never COVER the last row, so
 * the list pads itself out from under it rather than floating over content.
 * A number rather than a class because the padding is applied in each page's
 * own CSS (where it composes with `env(safe-area-inset-bottom)`); this is the
 * value that CSS mirrors, and the one the test pins.
 */
export const FAB_CLEARANCE_PX = 72;

/**
 * The header search, collapsed (s25 T5). Below `lg` the bar is a magnifier
 * that expands IN PLACE; at `lg` and up it is always the full field, so the
 * desktop header is what it was.
 *
 * The `bm:search` plumbing underneath is untouched — no navigation, no form
 * action, no history call (tokenInUrl.test.ts holds ShellNav to all three).
 */
export function searchFieldClasses(open: boolean): string {
  return cx("flex min-w-0 flex-1 items-center", !open && "max-lg:hidden");
}

/** Header chrome that steps aside while the narrow search is expanded, so the
 *  field gets the whole bar instead of a 90px slot. Desktop never yields. */
export function searchYieldClasses(open: boolean): string {
  return open ? "max-lg:hidden" : "";
}
