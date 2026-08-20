/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import {
  alertBodyClasses,
  alertClasses,
  alertIconClasses,
  alertTitleClasses,
  cx,
  type AlertTone,
} from "../../lib/ui/classes";
import { ExclamationTriangleIcon } from "../icons";

/** Tailwind UI `feedback/alerts/01-with-description` — brand, never indigo. */
export default function Alert({
  tone = "info",
  title,
  class: cls,
  children,
}: {
  tone?: AlertTone;
  title?: string;
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class={cx(alertClasses(tone), cls)} role="alert">
      <div class="flex">
        <div class="shrink-0">
          <ExclamationTriangleIcon class={alertIconClasses(tone)} />
        </div>
        <div class="ml-3 min-w-0">
          {title ? <h3 class={alertTitleClasses(tone)}>{title}</h3> : null}
          {children ? <div class={cx(alertBodyClasses(tone), title && "mt-2")}>{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
