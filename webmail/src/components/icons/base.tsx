/** @jsxImportSource preact */
// The two Heroicons frames (s24 T0). Each glyph file is 5 lines over one of
// these; the path data is the only thing that varies. Class-driven — size via
// `class` (e.g. "size-5"), never inline style (CSP: no unsafe-inline).

export interface IconProps {
  class?: string;
  /** Heroicons outline default; the collapse chevron wants 2. */
  strokeWidth?: number;
}

/** 24×24 outline (stroke) — the Heroicons "outline" set. */
export function Outline({ d, class: cls, strokeWidth = 1.5 }: IconProps & { d: string }) {
  return (
    <svg
      class={cls}
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={strokeWidth}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d={d} />
    </svg>
  );
}

/** 20×20 solid (fill) — the Heroicons "mini" set. */
export function Mini({ d, class: cls }: { d: string; class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d={d} clip-rule="evenodd" />
    </svg>
  );
}
