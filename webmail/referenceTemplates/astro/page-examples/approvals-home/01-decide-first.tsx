/** @jsxImportSource preact */
/**
 * Composed (not a 1:1 catalog port): the home VIEW as a decide-first surface.
 *
 * `/` is not a dashboard of counts (s07: you arrive to DECIDE, not to find).
 * Today's four equal stacks ("Waiting Approvals" / "Waiting on" / "Looking
 * Ahead" / "Commitments") give emptiness the same weight as a live decision.
 * This composition:
 *
 *   1. Makes Waiting Approvals the primary column (wider), with the Approve
 *      verb on the row — the glance that currently hops to `/approvals`.
 *   2. Collapses the other three stacks into one typed feed. Empty types are
 *      omitted, not rendered as "Nothing on the horizon…".
 *   3. Surfaces a near-expiry as an accent-border alert, not a boxed card.
 *
 * Catalog pieces (Tailwind UI, already in this tree):
 *   layout/containers/02-constrained-with-padded-content
 *   headings/section-headings/03-with-actions
 *   feedback/alerts/05-with-accent-border
 *   layout/list-containers/02-card-with-dividers
 *   lists/stacked-lists/06-with-badges-button-and-actions-menu
 *   forms/radio-groups/03-list-with-description
 *   lists/feeds/01-simple-with-icons
 *
 * Product constraints vs the catalog: `brand-*` not indigo; no Headless UI
 * Menu (CSP: the product hand-rolls overlays). Copy these classes into
 * `HomeView.tsx`; do not import this file from src/.
 */
import {
  CalendarIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckIcon,
  ClockIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  FlagIcon,
} from "../../_kit/heroicons/20-solid";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const pending = [
  {
    id: "p1",
    summary: "Send the assembled-board load calc to Northwind",
    agent: "allen",
    kind: "send",
    tier: "Tier 3",
    tierTone: "red" as const,
    waited: "waited 2h",
    expires: "expires in 18m",
    urgent: true,
    rationale: "The contractor asked for numbers before the 2pm call.",
  },
  {
    id: "p2",
    summary: "Draft a reply to Maya about the Friday ship window",
    agent: "emily",
    kind: "reply",
    tier: "Tier 2",
    tierTone: "yellow" as const,
    waited: "waited 40m",
    expires: "expires in 6h",
    urgent: false,
    rationale: "Holding in Drafts until you say send.",
  },
];

const declineReasons = [
  { id: "wrong", name: "Wrong call", description: "The agent read the thread, but this is not the action." },
  { id: "tone", name: "Wrong tone", description: "Keep the action; rewrite how it is said." },
  { id: "stop", name: "Do not do this", description: "A hard stop — not a stronger no. The agent must not retry." },
];

const aroundYou = [
  {
    id: "c1",
    content: "You promised",
    target: "to send the assembled-board load calc",
    href: "/goals",
    date: "no deadline",
    datetime: "",
    icon: FlagIcon,
    iconBackground: "bg-brand-600",
  },
  {
    id: "w1",
    content: "Waiting on",
    target: "Maya · Friday ship window",
    href: "/mail",
    date: "2d",
    datetime: "2026-08-18",
    icon: ChatBubbleLeftEllipsisIcon,
    iconBackground: "bg-gray-400 dark:bg-gray-600",
  },
  {
    id: "e1",
    content: "Event",
    target: "Northwind load-in",
    href: "/calendar",
    date: "tomorrow 9:00",
    datetime: "2026-08-21T09:00",
    icon: CalendarIcon,
    iconBackground: "bg-gray-400 dark:bg-gray-600",
  },
];

const badge = {
  red: "bg-red-50 text-red-700 inset-ring inset-ring-red-600/20 dark:bg-red-400/10 dark:text-red-400 dark:inset-ring-red-500/20",
  yellow:
    "bg-yellow-50 text-yellow-800 inset-ring inset-ring-yellow-600/20 dark:bg-yellow-400/10 dark:text-yellow-500 dark:inset-ring-yellow-400/20",
  gray: "bg-gray-50 text-gray-600 inset-ring inset-ring-gray-500/10 dark:bg-gray-400/10 dark:text-gray-400 dark:inset-ring-gray-400/20",
};

export default function Example() {
  return (
    <div className="min-h-full bg-white dark:bg-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-8">
          <section className="lg:col-span-7" aria-label="Waiting Approvals">
            <div className="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Waiting on you</h2>
              <a
                href="/approvals"
                className="mt-3 text-sm font-semibold text-brand-600 hover:text-brand-500 sm:mt-0 sm:ml-4 dark:text-brand-400"
              >
                Full queue
                <span aria-hidden="true"> →</span>
              </a>
            </div>

            <div className="mt-4 border-l-4 border-yellow-400 bg-yellow-50 p-4 dark:border-yellow-500 dark:bg-yellow-500/10">
              <div className="flex">
                <div className="shrink-0">
                  <ExclamationTriangleIcon aria-hidden="true" className="size-5 text-yellow-400 dark:text-yellow-500" />
                </div>
                <div className="ml-3">
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    One proposal expires in 18 minutes. Decide it here, or open the{" "}
                    <a
                      href="/approvals"
                      className="font-medium underline hover:text-yellow-600 dark:hover:text-yellow-200"
                    >
                      full queue
                    </a>
                    .
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-md bg-white shadow-sm dark:bg-gray-800/50 dark:shadow-none dark:outline dark:outline-offset-0 dark:outline-white/10">
              <ul role="list" className="divide-y divide-gray-200 dark:divide-white/10">
                {pending.map((p, idx) => (
                  <li key={p.id} className="px-4 py-5 sm:px-6">
                    <div className="flex items-start justify-between gap-x-6">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                          <p className="text-sm/6 font-semibold text-gray-900 dark:text-white">{p.summary}</p>
                          <p className={cx("mt-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium", badge[p.tierTone])}>
                            {p.tier}
                          </p>
                        </div>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{p.rationale}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs/5 text-gray-500 dark:text-gray-400">
                          <p className="truncate">{p.agent}</p>
                          <svg viewBox="0 0 2 2" className="size-0.5 fill-current">
                            <circle r={1} cx={1} cy={1} />
                          </svg>
                          <p>{p.kind}</p>
                          <svg viewBox="0 0 2 2" className="size-0.5 fill-current">
                            <circle r={1} cx={1} cy={1} />
                          </svg>
                          <p>{p.waited}</p>
                          <svg viewBox="0 0 2 2" className="size-0.5 fill-current">
                            <circle r={1} cx={1} cy={1} />
                          </svg>
                          <p className={p.urgent ? "font-medium text-yellow-800 dark:text-yellow-400" : undefined}>
                            {p.expires}
                          </p>
                        </div>
                      </div>
                      {idx === 0 ? (
                        <div className="flex flex-none flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-md bg-brand-600 px-2.5 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                          >
                            <EnvelopeIcon aria-hidden="true" className="mr-1.5 -ml-0.5 size-4" />
                            Approve send
                          </button>
                          <button
                            type="button"
                            className="hidden rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 sm:block dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-red-700 shadow-xs inset-ring inset-ring-red-200 hover:bg-red-50 dark:bg-white/10 dark:text-red-400 dark:inset-ring-red-500/30 dark:hover:bg-red-500/10"
                          >
                            Decline
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {idx === 1 ? (
                      <fieldset
                        className="mt-4 border-t border-gray-100 pt-4 dark:border-white/10"
                        aria-label="Why not?"
                      >
                        <legend className="text-sm font-medium text-gray-900 dark:text-white">Why not?</legend>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                          Each reason steers a different correction — the last one is a hard stop, not a stronger no.
                        </p>
                        <div className="mt-4 space-y-5">
                          {declineReasons.map((r) => (
                            <div key={r.id} className="relative flex items-start">
                              <div className="flex h-6 items-center">
                                <input
                                  id={`decline-${r.id}`}
                                  name="decline-reason"
                                  type="radio"
                                  defaultChecked={r.id === "wrong"}
                                  aria-describedby={`decline-${r.id}-description`}
                                  className="relative size-4 appearance-none rounded-full border border-gray-300 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:border-white/10 dark:bg-white/5 dark:checked:border-brand-500 dark:checked:bg-brand-500"
                                />
                              </div>
                              <div className="ml-3 text-sm/6">
                                <label
                                  htmlFor={`decline-${r.id}`}
                                  className="font-medium text-gray-900 dark:text-white"
                                >
                                  {r.name}
                                </label>
                                <p id={`decline-${r.id}-description`} className="text-gray-500 dark:text-gray-400">
                                  {r.description}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-4 flex gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-red-700 shadow-xs inset-ring inset-ring-red-200 hover:bg-red-50"
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:inset-ring-white/5"
                          >
                            Cancel
                          </button>
                        </div>
                      </fieldset>
                    ) : null}
                  </li>
                ))}
              </ul>
              <a
                href="/approvals"
                className="flex w-full items-center justify-center border-t border-gray-200 bg-white px-3 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:border-white/10 dark:bg-gray-800/50 dark:text-white dark:hover:bg-white/5"
              >
                4 more waiting → full queue
              </a>
            </div>
          </section>

          <aside className="mt-10 lg:col-span-5 lg:mt-0" aria-label="Around you">
            <div className="border-b border-gray-200 pb-5 dark:border-white/10">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Around you</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Commitments, waiting-on, and the next 48 hours — one feed, empty types omitted.
              </p>
            </div>
            <div className="mt-6 flow-root">
              <ul role="list" className="-mb-8">
                {aroundYou.map((event, eventIdx) => (
                  <li key={event.id}>
                    <div className="relative pb-8">
                      {eventIdx !== aroundYou.length - 1 ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-gray-200 dark:bg-white/10"
                        />
                      ) : null}
                      <div className="relative flex space-x-3">
                        <div>
                          <span
                            className={cx(
                              event.iconBackground,
                              "flex size-8 items-center justify-center rounded-full ring-8 ring-white dark:ring-gray-900",
                            )}
                          >
                            <event.icon aria-hidden="true" className="size-5 text-white" />
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-1 justify-between space-x-4 pt-1.5">
                          <div>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                              {event.content}{" "}
                              <a href={event.href} className="font-medium text-gray-900 dark:text-white">
                                {event.target}
                              </a>
                            </p>
                          </div>
                          <div className="text-right text-sm whitespace-nowrap text-gray-500 dark:text-gray-400">
                            {event.datetime ? <time dateTime={event.datetime}>{event.date}</time> : event.date}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
