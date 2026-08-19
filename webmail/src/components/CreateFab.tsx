/** @jsxImportSource preact */
import { fabClasses } from "../lib/ui/classes";
import { PlusIcon } from "./icons";

/**
 * The contextual [New], as a floating action button (s25 T5).
 *
 * ## The same verb, a different position
 *
 * s24 Decision 8 standardized ONE create affordance per realm and put it at
 * the top of the collection column. On a phone that corner is the furthest
 * point from a thumb, and the column itself is either stacked away or replaced
 * by the collection sheet. So below `lg` the same button moves to the
 * bottom-right — and it is the SAME button: same label, same handler, same
 * disabled semantics, sourced from the same props, because a second create
 * path with its own copy is how "New message" and "Compose" end up on one
 * product.
 *
 * It follows that a realm with no [New] gets no FAB. There is no fallback
 * verb, no "+" that means whatever the surface guesses — `CollectionColumn`
 * renders this only when it renders the column button, so absence stays
 * absence (Calendar, Settings, Activity, Agents, Approvals: no FAB, because
 * approving is not creating).
 *
 * ## Why it does not cover the list
 *
 * A FAB that floats over the last row makes that row unreachable and the bug
 * invisible — you scroll to the end and the thing you wanted is under your own
 * button. The fix is not a z-index: the scroll containers pad themselves by
 * `FAB_CLEARANCE_PX` below `lg` (each surface's page CSS), so the content ends
 * above the button rather than behind it.
 *
 * CSP: position, the safe-area inset and the disabled state are all utility
 * classes (`lib/ui/classes.ts`), never an inline style.
 */
export interface CreateFabProps {
  /** The realm's verb — "New message", "New contact", "New find". */
  label: string;
  onClick: () => void;
  /** Disabled, not hidden: the realm still HAS this verb, this session cannot
   *  use it (the CollectionColumn `newDisabled` idiom, unchanged). */
  disabled?: boolean;
}

export default function CreateFab({ label, onClick, disabled }: CreateFabProps) {
  return (
    <button
      type="button"
      onClick={() => onClick()}
      disabled={disabled}
      // The label is visible AND the accessible name — no sr-only stand-in,
      // because the words are the realm-contextual part.
      aria-label={label}
      class={fabClasses()}
    >
      <PlusIcon class="size-5 shrink-0" strokeWidth={2} />
      <span class="whitespace-nowrap">{label}</span>
    </button>
  );
}
