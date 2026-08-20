/** @jsxImportSource preact */
import { statusDotClasses, type StatusDotTone } from "../../lib/ui/classes";

/** The live/error/idle pip from Tailwind UI `lists/stacked-lists/17-narrow-with-badges`. */
export default function StatusDot({ tone = "neutral", class: cls }: { tone?: StatusDotTone; class?: string }) {
  return (
    <div class={`${statusDotClasses(tone)}${cls ? ` ${cls}` : ""}`}>
      <div class="size-2 rounded-full bg-current" />
    </div>
  );
}
