import { describe, expect, it } from "vitest";
import {
  ESCALATION_WINDOW_MAX_MS,
  ESCALATION_WINDOW_MIN_MS,
  ESCALATION_WINDOW_NO_HISTORY_MS,
  FREE_RUNTIME_LIVE_MS,
  escalationWindowMs,
  fit,
  mayClaim,
  normalizeClaimant,
  policy,
  type BudgetState,
  type ClaimCapabilities,
} from "./mayClaim.js";

/**
 * s11 T2 — the policy matrix, as a hand-written table. Every bullet of the
 * spec appears as at least one row; the exhaustive cross-product lives in
 * claimGateAgreement.test.ts, where the assertion is pure-vs-SQL agreement
 * rather than hand-derived expectations.
 */

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const HOUR = 60 * 60_000;

/** A world with nothing special going on: no budget cap, no free runtime
 * seen, the no-history window. Rows override what they test. */
const calm = (over: Partial<BudgetState> = {}): BudgetState => ({
  budgetExhausted: false,
  freeRuntimeLive: false,
  escalationWindowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
  ...over,
});

const FREE = { isFree: true, capabilities: null };
const PAID = { isFree: false, capabilities: null };

describe("policy — sit free, escalate near-due", () => {
  type Row = [
    name: string,
    dueAt: number | null,
    privacy: string | null,
    claimant: { isFree: boolean },
    budget: BudgetState,
    want: boolean,
  ];
  const rows: Row[] = [
    // ---- free claimants: policy never restricts them -----------------------
    ["free / far due → claims", NOW + 3 * HOUR, null, FREE, calm(), true],
    ["free / NULL due, free runtime live → claims", null, null, FREE, calm({ freeRuntimeLive: true }), true],
    ["free / pinned, past due → claims", NOW - HOUR, "pinned", FREE, calm(), true],
    ["free / budget exhausted, near due → claims", NOW + 10 * 60_000, null, FREE, calm({ budgetExhausted: true }), true],
    // ---- paid vs due_at ----------------------------------------------------
    ["paid / far due → holds (sit free)", NOW + 3 * HOUR, null, PAID, calm(), false],
    ["paid / near due (inside window) → claims", NOW + 30 * 60_000, null, PAID, calm(), true],
    ["paid / at the window edge → claims (<=)", NOW + ESCALATION_WINDOW_NO_HISTORY_MS, null, PAID, calm(), true],
    ["paid / 1ms outside the edge → holds", NOW + ESCALATION_WINDOW_NO_HISTORY_MS + 1, null, PAID, calm(), false],
    ["paid / past due → claims", NOW - HOUR, null, PAID, calm(), true],
    ["paid / wider window (history) widens eligibility", NOW + 3 * HOUR, null, PAID, calm({ escalationWindowMs: ESCALATION_WINDOW_MAX_MS }), true],
    // ---- paid vs NULL due: the sit-free rule under absence-inference -------
    ["paid / NULL due, NO free runtime live → claims NOW (STRANDING GUARD)", null, null, PAID, calm(), true],
    ["paid / NULL due, free runtime live → holds (sit free)", null, null, PAID, calm({ freeRuntimeLive: true }), false],
    // ---- the pin: hard, always ---------------------------------------------
    ["paid / pinned, past due → NEVER", NOW - HOUR, "pinned", PAID, calm(), false],
    ["paid / pinned, NULL due, no free runtime → NEVER (pinned MAY sit)", null, "pinned", PAID, calm(), false],
    ["paid / privacy=internal is not a pin → near due claims", NOW + 10 * 60_000, "internal", PAID, calm(), true],
    ["paid / privacy=open is not a pin → past due claims", NOW - HOUR, "open", PAID, calm(), true],
    // ---- budget exhaustion: free only, regardless of due-ness --------------
    ["paid / out of budget, past due → holds (watchdog's problem, T3)", NOW - HOUR, null, PAID, calm({ budgetExhausted: true }), false],
    ["paid / out of budget, NULL due, no free live → holds", null, null, PAID, calm({ budgetExhausted: true }), false],
    // ---- DefaultCase: no facets, default world = today ---------------------
    ["DefaultCase / paid, undeclared world → claims as today", null, null, PAID, calm(), true],
    ["DefaultCase / free → claims as today", null, null, FREE, calm(), true],
  ];

  it.each(rows)("%s", (_name, dueAt, privacy, claimant, budget, want) => {
    expect(policy({ dueAt, privacy }, claimant, budget, NOW)).toBe(want);
  });

  it("trust-but-audit: a declared isFree:true IS believed by policy (the record, not the gate, catches the lie)", () => {
    // A paid claimant lying isFree:true passes policy on far-due work — by
    // design. isFree is fit-shaped: the gate trusts the declaration and the
    // claim RECORDS it (claimant_free = 1), which is what lets the score
    // catch a "free" claimant whose runs keep stamping nonzero cost_micros.
    // Blocking would require remote attestation, deliberately not attempted.
    expect(policy({ dueAt: NOW + 3 * HOUR, privacy: null }, { isFree: true }, calm(), NOW)).toBe(true);
  });
});

describe("fit — identical semantics to the fleet host's fitsRequirements", () => {
  const caps: ClaimCapabilities = { vision: false, contextTokens: 32_000, tools: false };
  type Row = [caps: ClaimCapabilities | null | undefined, requires: unknown, want: boolean];
  const rows: Row[] = [
    // DefaultCase: no facet → claim exactly as today.
    [caps, null, true],
    [caps, undefined, true],
    [caps, "garbage", true],
    // NO DECLARED VECTOR → claimable as today (the T2-FIT-CONTRACT clause).
    [null, { vision: true }, true],
    [undefined, { contextTokens: 1_000_000 }, true],
    // Booleans: required-and-absent refuses; declaring it admits.
    [caps, { vision: true }, false],
    [{ ...caps, vision: true }, { vision: true }, true],
    [caps, { tools: true }, false],
    [{ ...caps, tools: true }, { tools: true }, true],
    [caps, { vision: false, tools: false }, true],
    // A declared-but-empty vector means "nothing special": booleans refuse.
    [{}, { vision: true }, false],
    [{}, { contextTokens: 4_000 }, true], // unstated contextTokens = no known limit
    // Context window: numeric comparison, only when both sides are numbers.
    [caps, { contextTokens: 32_000 }, true],
    [caps, { contextTokens: 32_001 }, false],
    [{ vision: true }, { contextTokens: 1_000_000 }, true],
    [caps, { contextTokens: "9999999" }, true], // non-numeric requirement = no constraint
    // Combined: every axis must fit.
    [{ ...caps, vision: true }, { vision: true, contextTokens: 64_000 }, false],
  ];
  it.each(rows.map((r, i) => [i, ...r] as const))(
    "case %d: caps=%j requires=%j → %s",
    (_i, c, r, want) => {
      expect(fit(c, r)).toBe(want);
    },
  );

  it("mayClaim = fit ∧ policy", () => {
    const facets = { dueAt: null, privacy: null, requires: { vision: true } };
    // Policy passes (free) but fit fails (declared vector without vision).
    expect(mayClaim(facets, { isFree: true, capabilities: {} }, calm(), NOW)).toBe(false);
    // Fit passes (vision declared) and policy passes.
    expect(mayClaim(facets, { isFree: true, capabilities: { vision: true } }, calm(), NOW)).toBe(true);
    // Fit passes (no vector declared) but policy fails (paid, free live).
    expect(
      mayClaim(facets, { isFree: false, capabilities: null }, calm({ freeRuntimeLive: true }), NOW),
    ).toBe(false);
  });
});

describe("escalationWindowMs — clamp(3 × median duration, 15min, 4h); no history → 1h", () => {
  it("no history → the 1h default", () => {
    expect(escalationWindowMs([])).toBe(ESCALATION_WINDOW_NO_HISTORY_MS);
  });
  it("single duration → 3× it", () => {
    expect(escalationWindowMs([10 * 60_000])).toBe(30 * 60_000);
  });
  it("odd count → middle; unsorted input is fine", () => {
    expect(escalationWindowMs([40 * 60_000, 10 * 60_000, 20 * 60_000])).toBe(60 * 60_000); // 3×20min
  });
  it("even count → mean of the two middles", () => {
    // medians 10 and 20 → 15min median → 45min window
    expect(escalationWindowMs([5 * 60_000, 10 * 60_000, 20 * 60_000, 60 * 60_000])).toBe(45 * 60_000);
  });
  it("clamps up to the 15min floor (a 1min job still gets retry room)", () => {
    expect(escalationWindowMs([60_000])).toBe(ESCALATION_WINDOW_MIN_MS);
  });
  it("clamps down to the 4h ceiling (a 5h job does not escalate at breakfast)", () => {
    expect(escalationWindowMs([5 * 60 * 60_000])).toBe(ESCALATION_WINDOW_MAX_MS);
  });
});

describe("normalizeClaimant — absent or malformed = paid, no vector (conservative)", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "free"],
    ["an array", [true]],
    ["a number", 1],
  ])("%s → paid, no capabilities", (_n, raw) => {
    expect(normalizeClaimant(raw)).toEqual({ isFree: false, capabilities: null });
  });

  it("isFree counts only as the literal boolean true", () => {
    expect(normalizeClaimant({ isFree: "true" }).isFree).toBe(false);
    expect(normalizeClaimant({ isFree: 1 }).isFree).toBe(false);
    expect(normalizeClaimant({ isFree: true }).isFree).toBe(true);
  });

  it("keeps well-typed capability fields, drops garbage (degrades to 'cannot', never 'can')", () => {
    expect(
      normalizeClaimant({
        isFree: true,
        capabilities: { vision: "yes", tools: true, contextTokens: "lots", extra: 1 },
      }),
    ).toEqual({ isFree: true, capabilities: { tools: true } });
    // Declared-but-empty stays declared (≠ null): booleans then read "cannot".
    expect(normalizeClaimant({ capabilities: {} })).toEqual({ isFree: false, capabilities: {} });
  });

  it("liveness horizon is the documented 15 minutes", () => {
    expect(FREE_RUNTIME_LIVE_MS).toBe(15 * 60_000);
  });
});
