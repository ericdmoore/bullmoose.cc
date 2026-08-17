import { describe, expect, it } from "vitest";
import { DEMO_NOW, demoConsoleData } from "./demoConsole";
import {
  answerCan,
  bindingWarnings,
  buildAgentView,
  describeCredential,
  describeGrant,
  grantState,
} from "./perAgent";
import type { AgentDossier, ConsoleBinding, ConsoleGrant } from "./types";

const data = demoConsoleData();
const allen = data.dossiers.acct_allen as AgentDossier;
const analyst = data.dossiers.acct_analyst as AgentDossier;

const grant = (over: Partial<ConsoleGrant>): ConsoleGrant => ({
  grantId: "g_1",
  scopes: ["read"],
  allows: [],
  collection: null,
  collectionId: null,
  createdBy: "p_eric",
  createdAt: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

// ── "can Allen even do that?" ───────────────────────────────────────────────

describe("answerCan — the headline question", () => {
  it("answers `send` correctly through the `mail` bundle, and says it was implied", () => {
    // devPlan.md T1 done-when: "can Allen send?" is answerable at a glance and
    // correct — INCLUDING the mail-is-a-superset case. Nothing in Allen's token
    // or grant names `send`.
    expect(allen.tokenScopes).not.toContain("send");
    expect((allen.grantsHeld[0] as ConsoleGrant).scopes).not.toContain("send");

    const a = answerCan(allen, "send", DEMO_NOW);
    expect(a.can).toBe(true);
    expect(a.impliedOnly).toBe(true);
    expect(a.because).toContain("Nothing NAMES");
    expect(a.because).toContain("would have shown this as absent");
    expect(a.meaning).toContain("no human review step");
  });

  it("answers `delete` the same way — the other permission `mail` hides", () => {
    expect(answerCan(allen, "delete", DEMO_NOW).can).toBe(true);
  });

  it("says no when nothing confers the permission", () => {
    const a = answerCan(analyst, "send", DEMO_NOW);
    expect(a.can).toBe(false);
    expect(a.because).toContain("does not expand to send");
  });

  it("refuses to read the grant alone — effective rights are token ∩ grant", () => {
    // A grant conferring everything, held by a token that holds only `read`.
    // The grant cannot exceed the token, and saying otherwise is the mistake
    // this screen exists to stop someone making.
    const narrowToken: AgentDossier = {
      ...analyst,
      tokenScopes: ["read"],
      grantsHeld: [grant({ scopes: ["mail"] })],
    };
    const a = answerCan(narrowToken, "send", DEMO_NOW);
    expect(a.can).toBe(false);
    expect(a.via).toEqual([]);
    expect(a.because).toContain("a grant cannot exceed the token");
    expect(answerCan(narrowToken, "read", DEMO_NOW).can).toBe(true);
  });

  it("separates own-account capability from what a grant extends", () => {
    // "Allen can send" and "Allen can send FROM ERIC'S ACCOUNT" are different
    // facts; one boolean has to be wrong about one of them.
    const a = answerCan(allen, "send", DEMO_NOW);
    expect(a.onOwnAccount).toBe(true);
    expect(a.via.map((v) => v.grant.grantId)).toEqual(["g_allen_mail"]);
  });

  it("drops a grant from `via` once it is revoked", () => {
    const revoked: AgentDossier = {
      ...allen,
      grantsHeld: [grant({ scopes: ["mail"], revokedAt: DEMO_NOW - 1 })],
    };
    // The token still allows `send` on its own account either way — the ONLY
    // thing the tombstone changes is the reach into someone else's.
    expect(answerCan(revoked, "send", DEMO_NOW).via).toEqual([]);
    expect(answerCan(revoked, "send", DEMO_NOW - 10_000).via).toHaveLength(1);
  });

  it("does not mark a directly-named permission as implied", () => {
    const named: AgentDossier = { ...allen, tokenScopes: ["send"], grantsHeld: [] };
    const a = answerCan(named, "send", DEMO_NOW);
    expect(a.can).toBe(true);
    expect(a.impliedOnly).toBe(false);
  });
});

// ── liveness, tombstone-first ───────────────────────────────────────────────

describe("grantState reads the s03.A tombstone FIRST", () => {
  it("calls a revoked grant revoked, not live", () => {
    // 015's renderGrant computes `live` from expires_at alone and predates
    // tombstones, so it reports this grant as live. This is the divergence.
    expect(grantState(grant({ revokedAt: 100 }), 200)).toBe("revoked");
    expect(grantState(grant({ revokedAt: 100, expiresAt: 50 }), 200)).toBe("revoked");
  });
  it("still distinguishes expiry", () => {
    expect(grantState(grant({ expiresAt: 100 }), 200)).toBe("expired");
    expect(grantState(grant({ expiresAt: 300 }), 200)).toBe("live");
    expect(grantState(grant({}), 200)).toBe("live");
  });
  it("treats a future revocation as not yet applied", () => {
    expect(grantState(grant({ revokedAt: 300 }), 200)).toBe("live");
  });
});

describe("describeGrant surfaces the understatement", () => {
  it("shows the permissions the stored list does not name", () => {
    const d = describeGrant(grant({ scopes: ["mail"] }), 0);
    expect(d.allows).toContain("send");
    expect(d.hidden).toContain("send");
    expect(d.grant.scopes).toEqual(["mail"]);
  });
});

// ── bindings ────────────────────────────────────────────────────────────────

const binding = (over: Partial<ConsoleBinding>): ConsoleBinding => ({
  bindingId: "b1",
  name: "x",
  triggerOn: "mailbox-delivery",
  slaSeconds: null,
  enabled: true,
  config: { pipeline: "reply", replyMode: "draft" },
  ...over,
});

describe("bindingWarnings", () => {
  it("flags a sending binding with no allowlist as the exfiltration shape", () => {
    const w = bindingWarnings(
      binding({
        config: { pipeline: "reply", replyMode: "send", senderAllowlist: { active: false } },
      }),
    );
    expect(w.join(" ")).toContain("replyMode is SEND");
    expect(w.join(" ")).toContain("anyone who can get a human-looking message");
  });

  it("explains a binding that cannot fire", () => {
    expect(bindingWarnings(binding({ enabled: false })).join(" ")).toContain("disabled");
    expect(bindingWarnings(binding({ triggerOn: "schedule" })).join(" ")).toContain(
      "nothing fires this binding today",
    );
  });

  it("admits when the config could not be parsed", () => {
    const w = bindingWarnings(
      binding({ config: { pipeline: null, replyMode: null, configUnparseable: true } }),
    );
    expect(w.join(" ")).toContain("could not be parsed");
  });
});

// ── credentials ─────────────────────────────────────────────────────────────

describe("describeCredential", () => {
  const creds = allen.credentials;
  const find = (name: string) => creds.find((c) => c.name === name) as (typeof creds)[number];

  it("lists live verbs as capabilities, and shows a revoked grant as revoked", () => {
    const s = describeCredential(find("aws-mcp"), allen.bureauGrants, DEMO_NOW);
    expect(s.verbs.sort()).toEqual(["fetch", "sign_sigv4"]);
    const stripe = describeCredential(find("stripe-key"), allen.bureauGrants, DEMO_NOW);
    expect(stripe.verbs).toEqual([]);
    expect(stripe.grants[0]?.state).toBe("revoked");
  });

  it("says out loud that enforcement=broad means only our code enforces (§5.2)", () => {
    const s = describeCredential(find("aws-mcp"), allen.bureauGrants, DEMO_NOW);
    expect(s.selfEnforcedOnly).toBe(true);
    expect(s.notes.join(" ")).toContain("narrowed only by our own code");
    expect(s.notes.join(" ")).toContain("Rung 3");
  });

  it("calls a federated credential rung 1 and does not flag it", () => {
    const s = describeCredential(find("google-oauth"), allen.bureauGrants, DEMO_NOW);
    expect(s.selfEnforcedOnly).toBe(false);
    expect(s.notes.join(" ")).toContain("Rung 1");
  });

  it("explains an unbound credential as fail-closed", () => {
    const s = describeCredential(find("unbound-key"), allen.bureauGrants, DEMO_NOW);
    expect(s.notes.join(" ")).toContain("fails closed");
  });

  it("never carries a value, and says why there is no reveal button", () => {
    for (const c of creds) {
      expect(Object.keys(c)).not.toContain("secret");
      expect(Object.keys(c)).not.toContain("value");
      expect(Object.keys(c)).not.toContain("enc_json");
      const s = describeCredential(c, allen.bureauGrants, DEMO_NOW);
      expect(s.notes.join(" ")).toContain("no vault route returns one");
    }
  });
});

// ── the assembled view ──────────────────────────────────────────────────────

describe("buildAgentView", () => {
  const view = buildAgentView(allen, DEMO_NOW);

  it("answers every irreversible permission up front", () => {
    expect(view.headline.map((h) => h.permission)).toEqual(["send", "delete", "vault", "admin"]);
    expect(view.headline.find((h) => h.permission === "send")?.can).toBe(true);
    expect(view.headline.find((h) => h.permission === "admin")?.can).toBe(false);
  });

  it("shows what the token allows and what it hides", () => {
    expect(view.tokenAllows).toContain("send");
    expect(view.tokenHidden).toContain("send");
    expect(view.tokenHidden).toContain("delete");
  });

  it("finds the exfiltration combination in the demo deployment", () => {
    const ids = view.combinations.map((c) => c.id);
    expect(ids).toContain("send-plus-egress");
    expect(ids).toContain("broad-enforcement:aws-mcp");
    expect(ids).toContain("wildcard-allow:aws-mcp");
    expect(ids).toContain("send-without-allowlist");
  });

  it("orders recent actions newest first and keeps the runtime's own note", () => {
    expect(view.recent[0]?.invocationId).toBe("inv_9");
    expect(view.recent.map((r) => r.note).join(" ")).toContain("skipped: noreply@vendor.example");
  });

  it("renders spend as the ledger, never as a budget (s04 owns budgets)", () => {
    expect(view.spendLine).toContain("USD 42.11");
    expect(view.spendLine).toContain("not a budget");
    expect(view.spendLine).toContain("no limit is enforced here");
  });

  it("states that a binding is not a grant", () => {
    expect(view.notes.join(" ")).toContain("A binding is not a grant");
  });

  it("says nothing dangerous about a quiet agent", () => {
    const quiet = buildAgentView(analyst, DEMO_NOW);
    expect(quiet.combinations).toEqual([]);
    expect(quiet.headline.find((h) => h.permission === "send")?.can).toBe(false);
  });
});
