// Agent recipes — one source of truth for the /recipes page AND the /deploy
// wizard's "what should it help you do?" agent cards. Each is an email-native
// agent pattern you can wire up with a binding + the vault + scheduling.

export interface Recipe {
  addr: string; // localpart, e.g. "receipts"
  title: string; // human name for the pattern
  purpose: string; // short verb phrase — the wizard's agent-card label
  blurb: string; // the marketing description
  example?: { role: "you" | "agent"; text: string }[];
}

export const RECIPES: Recipe[] = [
  {
    addr: "receipts",
    title: "Spend ledger",
    purpose: "file & categorize receipts",
    blurb:
      "Forward receipts; it extracts the amount, categorizes it, and forwards a running YTD digest with a chart. SQL does the sums — the model just reads.",
    example: [{ role: "agent", text: "Filed $42.00 · saas (Stripe). YTD saas: $1,284." }],
  },
  {
    addr: "crm",
    title: "Relationship memory",
    purpose: "remember who's who",
    blurb:
      "Grant it read access to your mail and it keeps a quiet CRM — who's who, birthdays, kids' names — inferred from what people already tell you.",
    example: [
      { role: "you", text: "Can't make it — it's little Timmy's 3rd birthday." },
      { role: "agent", text: "Noted: Sarah's son Timothy, DOB this week (±3d, from her Mar 2 email). I'll surface gift ideas next year." },
    ],
  },
  {
    addr: "reviews",
    title: "Buying analyst",
    purpose: "research a purchase",
    blurb:
      "Tell it what you're shopping for; it reads the review sites and comes back with the beginner / best / budget / best-value pick — and shows its work.",
    example: [
      { role: "you", text: "I need a vacuum." },
      { role: "agent", text: "Best-value, budget, and best picks — each with sources." },
    ],
  },
  {
    addr: "reservations",
    title: "Table watcher",
    purpose: "watch for openings",
    blurb:
      "It watches the hard-to-get spots (OpenTable, Resy, recreation.gov) and emails a direct booking link the moment something opens.",
    example: [{ role: "agent", text: "6:45 opened at Tatsu tonight — book: [link]. Yosemite permits open in 5 months; I'll remind you." }],
  },
  {
    addr: "news",
    title: "Local desk",
    purpose: "keep up with a beat",
    blurb:
      "Hand it a login through the write-only vault and it follows your town — school-board results, city council, whatever's local — and digests it.",
    example: [{ role: "you", text: "Follow the Times-Herald for school and city-council news." }],
  },
  {
    addr: "bouncer",
    title: "Inbox gatekeeper",
    purpose: "screen cold senders",
    blurb:
      "Front your main inbox: unsolicited senders get a polite human-check first. No reply, no pass — and the address gets filtered.",
    example: [{ role: "agent", text: "Eric's assistant here — I couldn't tell if a human sent this. Mind sharing your name?" }],
  },
  {
    addr: "newsletters",
    title: "Reading pile, summarized",
    purpose: "digest newsletters",
    blurb:
      "Subscribe everything here; it only ever sends one daily summary — and you can ask it things (“any sales at my yoga studio?”).",
  },
  {
    addr: "followups",
    title: "The nudge",
    purpose: "chase loose threads",
    blurb:
      "It watches the threads you never answered and nudges you before they go cold — “you left three people hanging.”",
  },
  {
    addr: "dailyreport",
    title: "Morning brief",
    purpose: "summarize the other agents",
    blurb:
      "One email each morning: what your other agents did overnight — receipts filed, reservations found, newsletters summarized.",
  },
];
