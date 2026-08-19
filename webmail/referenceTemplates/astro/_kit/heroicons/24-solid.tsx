/** @jsxImportSource preact */
/** Inlined Heroicons (MIT) used by the Tailwind UI React templates. */

import type { IconProps } from "./props";

/** An icon's own geometry, plus everything the caller forwards to the <svg>. */
interface InlineIconProps extends IconProps {
  /** viewBox of the source Heroicon. */
  viewBox: string;
  /** Inner markup of the source Heroicon, injected verbatim. */
  inner: string;
  /** Outline icons stroke rather than fill; solid icons do the reverse. */
  stroke: boolean;
}

function Icon({ viewBox, inner, stroke, className, class: cls, ...rest }: InlineIconProps) {
  const extra = stroke ? { fill: "none", stroke: "currentColor", "stroke-width": "1.5" } : { fill: "currentColor" };
  return (
    <svg
      viewBox={viewBox}
      class={className ?? cls}
      aria-hidden="true"
      {...extra}
      {...rest}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 24 24"
      inner={
        '<path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 24 24"
      inner={
        '<path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function PhotoIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 24 24"
      inner={
        '<path fill-rule="evenodd" d="M1.5 6a2.25 2.25 0 0 1 2.25-2.25h16.5A2.25 2.25 0 0 1 22.5 6v12a2.25 2.25 0 0 1-2.25 2.25H3.75A2.25 2.25 0 0 1 1.5 18V6ZM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0 0 21 18v-1.94l-2.69-2.689a1.5 1.5 0 0 0-2.12 0l-.88.879.97.97a.75.75 0 1 1-1.06 1.06l-5.16-5.159a1.5 1.5 0 0 0-2.12 0L3 16.061Zm10.125-7.81a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function UserCircleIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 24 24"
      inner={
        '<path fill-rule="evenodd" d="M18.685 19.097A9.723 9.723 0 0 0 21.75 12c0-5.385-4.365-9.75-9.75-9.75S2.25 6.615 2.25 12a9.723 9.723 0 0 0 3.065 7.097A9.716 9.716 0 0 0 12 21.75a9.716 9.716 0 0 0 6.685-2.653Zm-12.54-1.285A7.486 7.486 0 0 1 12 15a7.486 7.486 0 0 1 5.855 2.812A8.224 8.224 0 0 1 12 20.25a8.224 8.224 0 0 1-5.855-2.438ZM15.75 9a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}
