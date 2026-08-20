/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx, iconButtonClasses, type ButtonSize } from "../../lib/ui/classes";

// An icon-only button whose LABEL is mandatory — it becomes the sr-only text
// and the tooltip, so collapsing to a glyph never hides the meaning from a
// screen reader (the ShellNav compact-rail rule, made a primitive).

export interface IconButtonProps {
  label: string;
  size?: ButtonSize;
  disabled?: boolean;
  /** Selected state on a compact rail (collapsed CollectionColumn folders). */
  active?: boolean;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  "aria-expanded"?: boolean;
  children: ComponentChildren; // the icon
}

export default function IconButton({
  label,
  size = "md",
  disabled,
  active,
  onClick,
  class: cls,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      class={cx(iconButtonClasses(size, { active }), cls)}
      disabled={disabled}
      onClick={onClick}
      title={label}
      {...rest}
      aria-current={active ? "true" : undefined}
    >
      <span class="sr-only">{label}</span>
      {children}
    </button>
  );
}
