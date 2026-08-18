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

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-x-1.5 rounded-md font-semibold " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 " +
  "disabled:opacity-50 disabled:pointer-events-none";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // The standardized [New] look (s24 Decision 8) — one primary, everywhere.
  primary: "bg-brand-600 text-white shadow-xs hover:bg-brand-500",
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

/** Square padding for an icon-only button; the label goes sr-only. */
export function iconButtonClasses(size: ButtonSize = "md"): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT.ghost, size === "sm" ? "p-1" : "p-1.5");
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
