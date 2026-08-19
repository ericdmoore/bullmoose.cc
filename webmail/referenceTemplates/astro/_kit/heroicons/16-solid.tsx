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

export function BarsArrowUpIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M2 2.75A.75.75 0 0 1 2.75 2h9.5a.75.75 0 0 1 0 1.5h-9.5A.75.75 0 0 1 2 2.75ZM2 6.25a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 2 6.25Zm0 3.5A.75.75 0 0 1 2.75 9h3.5a.75.75 0 0 1 0 1.5h-3.5A.75.75 0 0 1 2 9.75ZM9.22 9.53a.75.75 0 0 1 0-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1-1.06 1.06l-.97-.97v5.69a.75.75 0 0 1-1.5 0V8.56l-.97.97a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function ChevronUpDownIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M5.22 10.22a.75.75 0 0 1 1.06 0L8 11.94l1.72-1.72a.75.75 0 1 1 1.06 1.06l-2.25 2.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 0 1 0-1.06ZM10.78 5.78a.75.75 0 0 1-1.06 0L8 4.06 6.28 5.78a.75.75 0 0 1-1.06-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function EnvelopeIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path d="M2.5 3A1.5 1.5 0 0 0 1 4.5v.793c.026.009.051.02.076.032L7.674 8.51c.206.1.446.1.652 0l6.598-3.185A.755.755 0 0 1 15 5.293V4.5A1.5 1.5 0 0 0 13.5 3h-11Z"/>\n  <path d="M15 6.954 8.978 9.86a2.25 2.25 0 0 1-1.956 0L1 6.954V11.5A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.954Z"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function ExclamationCircleIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function MagnifyingGlassIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function QuestionMarkCircleIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path fill-rule="evenodd" d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Zm-6 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM7.293 5.293a1 1 0 1 1 .99 1.667c-.459.134-1.033.566-1.033 1.29v.25a.75.75 0 1 0 1.5 0v-.115a2.5 2.5 0 1 0-2.518-4.153.75.75 0 1 0 1.061 1.06Z" clip-rule="evenodd"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z"/>'
      }
      stroke={false}
      {...props}
    />
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon
      viewBox="0 0 16 16"
      inner={
        '<path d="M8.5 4.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM10.9 12.006c.11.542-.348.994-.9.994H2c-.553 0-1.01-.452-.902-.994a5.002 5.002 0 0 1 9.803 0ZM14.002 12h-1.59a2.556 2.556 0 0 0-.04-.29 6.476 6.476 0 0 0-1.167-2.603 3.002 3.002 0 0 1 3.633 1.911c.18.522-.283.982-.836.982ZM12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>'
      }
      stroke={false}
      {...props}
    />
  );
}
