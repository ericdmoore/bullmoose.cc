import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  VOCAB_CAP,
  bayesClassify,
  bayesTrain,
  bayesVerdict,
  emptyBayesState,
  prunedTokens,
  type BayesState,
} from "./bayes.js";
import type { BoundaryMessage } from "./message.js";

const bm = (
  from: string,
  subject: string,
  textBody: string,
  headers: Record<string, string> = {},
): BoundaryMessage => ({
  from,
  fromDomain: from.split("@")[1] ?? "",
  subject,
  textBody,
  headers,
  sizeBytes: textBody.length,
  hasAttachments: false,
});

// ── The corpus fixture — hand-written, two voices ──────────────────────────
// Spam: prizes, crypto, pills, wire fraud, phishing, casino. Ham: work,
// family, school, clubs. Vocabulary repeats WITHIN each class (that is what
// gives naive Bayes its evidence) and barely crosses classes.

const SPAM: BoundaryMessage[] = [
  bm(
    "prize@win-big.biz",
    "You are our WINNER — claim your prize now",
    "Congratulations winner! Click the link to claim your free prize money today. Act now, offer expires.",
  ),
  bm(
    "promo@win-big.biz",
    "Claim your FREE prize money",
    "You won the lottery jackpot! Claim the prize now with one click. Free money guaranteed.",
  ),
  bm(
    "alerts@crypto-moon.io",
    "Double your bitcoin in 24 hours",
    "Guaranteed bitcoin profits. Send crypto now and double your money fast. Limited offer.",
  ),
  bm(
    "invest@crypto-moon.io",
    "Urgent: exclusive crypto investment offer",
    "Guaranteed returns on bitcoin investment. Act now, limited spots. Double your money.",
  ),
  bm(
    "meds@cheap-pills.net",
    "Cheap pills no prescription",
    "Buy discount pills online. No prescription needed. Cheap miracle supplements shipped discreet.",
  ),
  bm(
    "sales@cheap-pills.net",
    "Miracle weight loss pills — 80% off",
    "Lose weight fast with miracle pills. Discount offer, no prescription. Order now.",
  ),
  bm(
    "prince@wire-now.biz",
    "Urgent business proposal",
    "I am a prince with ten million dollars. Send your bank account details for urgent wire transfer. Strictly confidential.",
  ),
  bm(
    "barrister@wire-now.biz",
    "Inheritance funds — reply urgent",
    "Unclaimed inheritance of five million dollars awaits. Send bank details now for the wire transfer.",
  ),
  bm(
    "deals@mega-offers.info",
    "80% OFF everything — today only",
    "Massive discount deals. Click now, free shipping, offer expires today.",
  ),
  bm(
    "promo@mega-offers.info",
    "FREE gift card waiting for you",
    "Claim your free gift card now. Click the link, limited offer, act fast.",
  ),
  bm(
    "winner@lotto-int.net",
    "International lottery final notice",
    "Your email won the international lottery jackpot. Claim the prize money now. Send processing fee.",
  ),
  bm(
    "claims@lotto-int.net",
    "Second notice: unclaimed jackpot",
    "Final notice for your unclaimed lottery prize. Claim now or forfeit the jackpot money.",
  ),
  bm(
    "support@account-verify.net",
    "Your account will be suspended",
    "Verify your account now. Click the link and confirm your password or the account will be suspended.",
  ),
  bm(
    "security@account-verify.net",
    "Password expires today — verify now",
    "Urgent: confirm your password now. Click to verify the account or lose access today.",
  ),
  bm(
    "offers@hot-singles.date",
    "Hot singles in your area",
    "Meet hot singles tonight. Click now, free registration, no strings.",
  ),
  bm(
    "dating@hot-singles.date",
    "She is waiting for your reply",
    "Lonely singles want to meet you tonight. Free chat, click the link now.",
  ),
  bm(
    "billing@fake-invoice.biz",
    "Invoice overdue — pay immediately",
    "Your invoice is overdue. Pay now by wire transfer or face legal action immediately.",
  ),
  bm(
    "collections@fake-invoice.biz",
    "FINAL WARNING: unpaid invoice",
    "Final warning: unpaid invoice. Immediate wire transfer required or legal action follows.",
  ),
  bm(
    "bonus@casino-win.vip",
    "500 free spins waiting",
    "Exclusive casino bonus: free spins, guaranteed winnings. Deposit now and win big jackpot.",
  ),
  bm(
    "vip@casino-win.vip",
    "You qualify for VIP casino bonus",
    "Claim your casino bonus now. Guaranteed jackpot winnings, free spins, act fast.",
  ),
];

const HAM: BoundaryMessage[] = [
  bm(
    "sarah@acme-corp.com",
    "Team meeting moved to Thursday",
    "Hi all, the weekly team meeting moves to Thursday at ten. Agenda notes attached. Thanks, Sarah.",
  ),
  bm(
    "mike@acme-corp.com",
    "Q3 project status notes",
    "Here are the project status notes from the standup. Review before Thursday's meeting. Thanks, Mike.",
  ),
  bm(
    "sarah@acme-corp.com",
    "Lunch after the design review?",
    "Want to grab lunch after the design review tomorrow? The new place near the office. Sarah",
  ),
  bm(
    "hr@acme-corp.com",
    "Benefits enrollment reminder",
    "Friendly reminder: benefits enrollment closes Friday. See the intranet page for details. HR team.",
  ),
  bm(
    "grandma@gardner.family",
    "Sunday dinner at our place",
    "We would love to have everyone for Sunday dinner. Bring the kids and the famous salad. Love, Grandma.",
  ),
  bm(
    "dad@gardner.family",
    "Cabin weekend packing list",
    "Packing list for the cabin weekend: boots, rain jackets, board games. Leaving Saturday morning. Dad",
  ),
  bm(
    "aunt.june@gardner.family",
    "Photos from the reunion",
    "Sharing photos from the family reunion. The kids grew so much! See the album link. June",
  ),
  bm(
    "office@lakeside-school.org",
    "Field trip permission slip due",
    "The science museum field trip is next week. Permission slips due Wednesday. Thank you, front office.",
  ),
  bm(
    "coach@rivertown.club",
    "Practice moved to 5pm",
    "Soccer practice moves to five pm this week because of field maintenance. See everyone Tuesday. Coach",
  ),
  bm(
    "office@lakeside-school.org",
    "Early dismissal Friday",
    "Reminder: early dismissal Friday for teacher conferences. Pickup at noon. Front office.",
  ),
  bm(
    "mike@acme-corp.com",
    "Code review feedback",
    "Left feedback on your merge request. Mostly small naming things, one question about the migration. Mike",
  ),
  bm(
    "anna@bookclub.example",
    "Next book: chapters one to five",
    "For next month we are reading chapters one through five. Meeting at Anna's, snacks provided.",
  ),
  bm(
    "dr.patel@rivertown-dental.com",
    "Appointment reminder Tuesday",
    "Your cleaning appointment is Tuesday at nine. Reply to reschedule. Rivertown Dental.",
  ),
  bm(
    "no-reply@utility-coop.com",
    "Your monthly statement is ready",
    "Your monthly statement is ready in the portal. Autopay drafts on the fifteenth. Utility cooperative.",
  ),
  bm(
    "sarah@acme-corp.com",
    "Draft agenda for the offsite",
    "Draft agenda for the offsite attached. Add topics by Wednesday please. Sarah",
  ),
  bm(
    "neighbor.tom@rivertown.club",
    "Borrowing the ladder this weekend",
    "Mind if I borrow the ladder this weekend? Gutters again. Happy to help with the fence after. Tom",
  ),
  bm(
    "grandma@gardner.family",
    "Recipe for the apple pie",
    "Here is the apple pie recipe you asked about. The trick is cold butter. Love, Grandma",
  ),
  bm(
    "coach@rivertown.club",
    "Snack schedule for Saturday games",
    "Snack schedule for Saturday: oranges first half, granola after. Thanks for volunteering. Coach",
  ),
  bm(
    "mike@acme-corp.com",
    "Standup moved to 9:30",
    "Standup moves to nine thirty tomorrow so the platform team can join. Same room. Mike",
  ),
  bm(
    "library@rivertown.club",
    "Hold ready for pickup",
    "Your hold is ready for pickup at the front desk. We will keep it through next Friday. Library",
  ),
];

/** Corpus, folded. Alternating order (spam, ham, spam, …) so no class is
 * "recent" — irrelevant to the math, but keeps the fixture honest. */
function trainedState(): BayesState {
  let state = emptyBayesState();
  const n = Math.max(SPAM.length, HAM.length);
  for (let i = 0; i < n; i++) {
    const s = SPAM[i];
    const h = HAM[i];
    if (s) state = bayesTrain(state, s, "spam");
    if (h) state = bayesTrain(state, h, "ham");
  }
  return state;
}

describe("bayes — corpus separation", () => {
  const state = trainedState();

  it("every spam fixture scores high, every ham fixture scores low", () => {
    for (const m of SPAM) expect(bayesClassify(state, m).score).toBeGreaterThan(0.9);
    for (const m of HAM) expect(bayesClassify(state, m).score).toBeLessThan(0.1);
  });

  it("DEFAULT_THRESHOLDS cleanly separates the whole fixture (REJECT vs CONTINUE_CLEAN, no mid-band)", () => {
    for (const m of SPAM) {
      expect(bayesVerdict(bayesClassify(state, m).score, DEFAULT_THRESHOLDS)).toBe("REJECT");
    }
    for (const m of HAM) {
      expect(bayesVerdict(bayesClassify(state, m).score, DEFAULT_THRESHOLDS)).toBe("CONTINUE_CLEAN");
    }
  });

  it("an UNSEEN spam-voiced message from a new sender still rejects", () => {
    const holdout = bm(
      "grand@new-prizes.top",
      "Final notice: claim your prize money now",
      "Winner! Your free jackpot prize is waiting. Click now, act fast, guaranteed money.",
    );
    const { score } = bayesClassify(state, holdout);
    expect(bayesVerdict(score, DEFAULT_THRESHOLDS)).toBe("REJECT");
  });

  it("an UNSEEN ham-voiced message from a new sender continues clean", () => {
    const holdout = bm(
      "pat@new-neighbor.com",
      "Team dinner Thursday — schedule and notes",
      "Moving our dinner to Thursday. Bring the kids, Grandma is making the salad. Thanks, see everyone there.",
    );
    const { score } = bayesClassify(state, holdout);
    expect(bayesVerdict(score, DEFAULT_THRESHOLDS)).toBe("CONTINUE_CLEAN");
  });

  it("an all-unseen-token message lands EXACTLY mid — finite, 0.5, MID_BAND (Laplace at work)", () => {
    // Balanced corpus (20/20): the prior is log(21/21)=0 and every unseen
    // token contributes log(1/22) − log(1/22) = 0. Without Laplace this is
    // log(0) − log(0) = NaN — the mutation this test exists to catch.
    const stranger = bm("zork@qqfnord.example", "Xylophone quandary", "Grommet flange bezel widget sprocket.");
    const { score } = bayesClassify(state, stranger);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeCloseTo(0.5, 10);
    expect(bayesVerdict(score, DEFAULT_THRESHOLDS)).toBe("MID_BAND");
  });

  it("empty state classifies anything at 0.5 → MID_BAND (the honest ignorance answer)", () => {
    const first = SPAM[0]!;
    const { score } = bayesClassify(emptyBayesState(), first);
    expect(score).toBeCloseTo(0.5, 10);
    expect(bayesVerdict(score, DEFAULT_THRESHOLDS)).toBe("MID_BAND");
  });
});

describe("bayesVerdict — the two-threshold table", () => {
  type Row = [score: number, want: "REJECT" | "CONTINUE_CLEAN" | "MID_BAND"];
  const rows: Row[] = [
    [0, "CONTINUE_CLEAN"],
    [0.1, "CONTINUE_CLEAN"],
    [0.2, "CONTINUE_CLEAN"], // ≤ T_clean is INCLUSIVE — the boundary equality
    [0.200001, "MID_BAND"],
    [0.5, "MID_BAND"],
    [0.9799, "MID_BAND"],
    [0.98, "REJECT"], // ≥ T_reject is INCLUSIVE — the boundary equality
    [0.99, "REJECT"],
    [1, "REJECT"],
  ];
  it.each(rows)("score %d → %s (defaults)", (score, want) => {
    expect(bayesVerdict(score, DEFAULT_THRESHOLDS)).toBe(want);
  });

  it("custom thresholds are honored", () => {
    expect(bayesVerdict(0.5, { reject: 0.4, clean: 0.1 })).toBe("REJECT");
    expect(bayesVerdict(0.05, { reject: 0.4, clean: 0.1 })).toBe("CONTINUE_CLEAN");
    expect(bayesVerdict(0.2, { reject: 0.4, clean: 0.1 })).toBe("MID_BAND");
  });

  it("degenerate config (reject ≤ clean): REJECT is checked first, deterministically", () => {
    expect(bayesVerdict(0.5, { reject: 0.5, clean: 0.5 })).toBe("REJECT");
  });
});

describe("bayes — tokenizer shape (via the public state)", () => {
  it("prefixes subject/header tokens, keeps domains whole, counts unique-per-message", () => {
    const state = bayesTrain(
      emptyBayesState(),
      bm("promo@win-big.biz", "Hello offer", "pills pills pills", {
        "List-Id": "<deals.mega.example>",
      }),
      "spam",
    );
    expect(state.tokens["from:promo@win-big.biz"]).toEqual({ s: 1, h: 0 });
    expect(state.tokens["domain:win-big.biz"]).toEqual({ s: 1, h: 0 }); // hyphen-dotted domain = ONE token
    expect(state.tokens["subj:hello"]).toEqual({ s: 1, h: 0 }); // subject-prefixed
    expect(state.tokens["hello"]).toBeUndefined(); // …and NOT a bare body token
    expect(state.tokens["pills"]).toEqual({ s: 1, h: 0 }); // presence, not multiplicity
    expect(state.tokens["hdr:list-id:deals.mega.example"]).toEqual({ s: 1, h: 0 });
  });
});

describe("bayes — log-space arithmetic survives huge messages", () => {
  it("a 10k-unique-token message yields a finite, saturated score both ways", () => {
    const spamBody = Array.from({ length: 10_000 }, (_, i) => `sp${i}x`).join(" ");
    const hamBody = Array.from({ length: 10_000 }, (_, i) => `hm${i}x`).join(" ");
    let state = emptyBayesState();
    const bigSpam = bm("a@a.example", "big", spamBody);
    const bigHam = bm("b@b.example", "big", hamBody);
    state = bayesTrain(state, bigSpam, "spam");
    state = bayesTrain(state, bigHam, "ham");

    const s = bayesClassify(state, bigSpam).score;
    const h = bayesClassify(state, bigHam).score;
    // Naive probability products would underflow to 0/0 ≈ NaN thousands of
    // tokens earlier; the log-odds sum saturates cleanly instead.
    expect(Number.isFinite(s)).toBe(true);
    expect(Number.isFinite(h)).toBe(true);
    expect(s).toBeGreaterThan(0.999);
    expect(h).toBeLessThan(0.001);
  });

  it("a 10k-token message against an EMPTY state is still exactly 0.5", () => {
    const body = Array.from({ length: 10_000 }, (_, i) => `tk${i}x`).join(" ");
    const { score } = bayesClassify(emptyBayesState(), bm("a@a.example", "big", body));
    expect(score).toBeCloseTo(0.5, 10);
  });
});

describe("bayesTrain — purity", () => {
  it("returns a NEW state and leaves the input byte-identical (classify too)", () => {
    const before = trainedState();
    const snapshot = JSON.parse(JSON.stringify(before));
    const probe = bm("x@y.example", "probe", "probe body words here");

    const after = bayesTrain(before, probe, "spam");
    bayesClassify(before, probe);

    expect(before).toEqual(snapshot); // unmutated
    expect(after).not.toBe(before);
    expect(after.spamCount).toBe(before.spamCount + 1);
    expect(after.hamCount).toBe(before.hamCount);
    expect(before.tokens["probe"]).toBeUndefined();
    expect(after.tokens["probe"]).toEqual({ s: 1, h: 0 });
  });

  it("round-trips through JSON (plain-serializable state)", () => {
    const state = trainedState();
    const revived: BayesState = JSON.parse(JSON.stringify(state));
    const m = SPAM[3]!;
    expect(bayesClassify(revived, m).score).toBe(bayesClassify(state, m).score);
  });
});

describe("prunedTokens — the deterministic vocab cap", () => {
  it("evicts lowest total first; ties evict the lexicographically smaller; output keys sorted", () => {
    const tokens = {
      ee: { s: 3, h: 3 }, // total 6 — safe
      dd: { s: 0, h: 1 }, // total 1 — tie…
      cc: { s: 1, h: 0 }, // total 1 — tie…
      aa: { s: 0, h: 1 }, // total 1 — tie: aa and cc go (smaller first), dd stays
      bb: { s: 2, h: 0 }, // total 2 — safe
    };
    const out = prunedTokens(tokens, 3);
    expect(Object.keys(out)).toEqual(["bb", "dd", "ee"]);
    expect(out["dd"]).toEqual({ s: 0, h: 1 });
    // Input untouched.
    expect(Object.keys(tokens)).toHaveLength(5);
  });

  it("at or under cap returns the input unchanged", () => {
    const tokens = { aa: { s: 1, h: 0 } };
    expect(prunedTokens(tokens, 1)).toBe(tokens);
  });

  it("training past VOCAB_CAP prunes hapaxes and KEEPS the fixture separation", () => {
    let state = trainedState();
    // One junk-storm message: VOCAB_CAP unique hapax tokens (Base64-shrapnel
    // stand-ins). Pushes the vocab over cap; the prune must shed hapaxes,
    // never the repeated discriminative corpus tokens.
    const junk = Array.from({ length: VOCAB_CAP }, (_, i) => `junk${i}z`).join(" ");
    state = bayesTrain(state, bm("noise@junkstorm.example", "junk", junk), "spam");

    expect(Object.keys(state.tokens).length).toBeLessThanOrEqual(VOCAB_CAP);
    // Classification on the fixture is stable through the prune.
    for (const m of SPAM) {
      expect(bayesVerdict(bayesClassify(state, m).score, DEFAULT_THRESHOLDS)).toBe("REJECT");
    }
    for (const m of HAM) {
      expect(bayesVerdict(bayesClassify(state, m).score, DEFAULT_THRESHOLDS)).toBe("CONTINUE_CLEAN");
    }
  });
});
