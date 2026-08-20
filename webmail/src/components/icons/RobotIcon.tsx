/** @jsxImportSource preact */
import type { IconProps } from "./base";

/** Outline robot — Agents realm glyph. 24×24, stroke, class-driven (CSP). */
export default function RobotIcon({ class: cls, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg
      class={cls}
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={strokeWidth}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 8.25V4.75" />
      <circle cx="12" cy="3.25" r="1.25" />
      <rect x="5.25" y="8.25" width="13.5" height="11.5" rx="2.25" />
      <circle cx="9.25" cy="13.75" r="1.35" />
      <circle cx="14.75" cy="13.75" r="1.35" />
      <path d="M5.25 12.5H3.85a.85.85 0 0 0-.85.85v2.8a.85.85 0 0 0 .85.85H5.25" />
      <path d="M18.75 12.5h1.4a.85.85 0 0 1 .85.85v2.8a.85.85 0 0 1-.85.85h-1.4" />
    </svg>
  );
}
