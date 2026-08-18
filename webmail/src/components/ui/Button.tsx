/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { buttonClasses, cx, type ButtonSize, type ButtonVariant } from "../../lib/ui/classes";

// The one button (s24 T0). `variant="primary"` is the standardized [New]
// treatment (Decision 8) — one create affordance, every realm. Renders an <a>
// when given href, a <button> otherwise; identical look either way.

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit";
  disabled?: boolean;
  href?: string;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  title?: string;
  "aria-label"?: string;
  children: ComponentChildren;
}

export default function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  disabled,
  href,
  onClick,
  class: cls,
  children,
  ...rest
}: ButtonProps) {
  const classes = cx(buttonClasses(variant, size), cls);
  if (href !== undefined && !disabled) {
    return (
      <a href={href} class={classes} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} class={classes} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}
