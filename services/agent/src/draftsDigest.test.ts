import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  DRAFT_STALE_MS,
  draftsMarkerId,
  renderDraftsDigest,
  sameDraftSet,
  sweepDraftsDigest,
  utcDayKey,
} from "./draftsDigest.js";
import type { Env } from "./models.js";

// CJ's drafts digest (board #43): mail you receive about mail you never sent.
// The tests mirror the design's two silences, because the silences are the
// feature — a digest that nags becomes a digest that gets deleted.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 15, 0, 0);
const ACCOUNT = "t_bm__a_eric";

describe("renderDraftsDigest", () => {
  const drafts = [
    { id: "e1", threadId: "th_1", subject: "Re: tournament", receivedAt: NOW - 2 * DAY },
    { id: "e2", threadId: "th_2", subject: null, receivedAt: NOW - 30 * DAY },
  ];

  it("1. one line per draft, aged, deep-linked — the link is the point", () => {
    const { subject, text } = renderDraftsDigest(drafts, { now: NOW, webmailOrigin: "https://app.bullmoose.cc" });
    expect(subject).toBe("2 drafts waiting to be sent");
    expect(text).toContain("Re: tournament — 2 days");
    expect(text).toContain("https://app.bullmoose.cc/mail?thread=th_1");
    expect(text).toContain("(no subject) — 30 days");
    expect(text).toContain("— CJ");
  });

  it("2. singular grammar for a single draft — a digest that cannot count reads as a bot", () => {
    const { subject, text } = renderDraftsDigest([drafts[0]!], { now: NOW, webmailOrigin: "https://x" });
    expect(subject).toBe("1 draft waiting to be sent");
    expect(text).toContain("1 draft that has been");
  });

  it("3. thread ids are URL-encoded, not concatenated on faith", () => {
    const { text } = renderDraftsDigest([{ id: "e", threadId: "th?&=x", subject: "s", receivedAt: NOW - 2 * DAY }], {
      now: NOW,
      webmailOrigin: "https://app.bullmoose.cc",
    });
    expect(text).toContain("/mail?thread=th%3F%26%3Dx");
  });
});

describe("sameDraftSet", () => {
  it("10. order does not matter — two sweeps can enumerate differently and mean the same", () => {
    expect(sameDraftSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameDraftSet(["a"], ["a", "b"])).toBe(false);
    expect(sameDraftSet([], [])).toBe(true);
  });
});

describe("sweepDraftsDigest — the two silences", () => {
  function world() {
    const w = fakeEnv();
    w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@bullmoose.cc", displayName: "Eric" });
    // Delivery needs an identity to address the digest to — seedAccount does
    // not create one (harness.test.ts seeds it the same way).
    void w.env.DB.prepare(
      `INSERT INTO identities (id, account_id, email, name) VALUES ('id_e', ?, 'eric@bullmoose.cc', 'Eric')`,
    )
      .bind(ACCOUNT)
      .run();
    return w;
  }

  async function seedDraft(w: ReturnType<typeof fakeEnv>, id: string, receivedAt: number) {
    // A draft is an email in the drafts-role mailbox. Seed the mailbox once.
    const box = await w.env.DB.prepare(`SELECT id FROM mailboxes WHERE account_id = ? AND role = 'drafts'`)
      .bind(ACCOUNT)
      .first<{ id: string }>();
    let boxId = box?.id;
    if (!boxId) {
      boxId = "mb_drafts";
      await w.env.DB.prepare(
        `INSERT INTO mailboxes (id, account_id, name, role, sort_order) VALUES (?, ?, 'Drafts', 'drafts', 0)`,
      )
        .bind(boxId, ACCOUNT)
        .run();
    }
    await w.env.DB.prepare(
      `INSERT INTO emails (id, account_id, blob_id, thread_id, subject, received_at, size)
       VALUES (?, ?, 'b_x', ?, 'draft ' || ?, ?, 10)`,
    )
      .bind(id, ACCOUNT, `th_${id}`, id, receivedAt)
      .run();
    await w.env.DB.prepare(`INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)`)
      .bind(ACCOUNT, id, boxId)
      .run();
  }

  const inboxCount = (w: ReturnType<typeof fakeEnv>) =>
    w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM emails e
        JOIN email_mailboxes em ON em.email_id = e.id AND em.account_id = e.account_id
        JOIN mailboxes m ON m.id = em.mailbox_id AND m.account_id = em.account_id
       WHERE e.account_id = ? AND m.role = 'inbox'`,
      ACCOUNT,
    )[0]!.n;

  it("20. a stale draft earns a digest in the inbox, once per day", async () => {
    const w = world();
    await seedDraft(w, "e_old", NOW - 3 * DAY);
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(1);
    expect(inboxCount(w)).toBe(1);
    // Same tick again — the daily marker holds.
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(0);
    expect(inboxCount(w)).toBe(1);
    // The marker is the deterministic id, so the guard is the primary key.
    const marker = w.db.query<{ id: string }>(
      `SELECT id FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      draftsMarkerId(ACCOUNT, utcDayKey(NOW)),
    );
    expect(marker).toHaveLength(1);
  });

  it("21. SILENCE ONE: a fresh draft is not nagged about", async () => {
    // The draft being typed right now must not appear in a digest — a digest
    // that mentions today's work-in-progress teaches the reader to delete
    // digests.
    const w = world();
    await seedDraft(w, "e_fresh", NOW - DRAFT_STALE_MS / 2);
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(0);
    expect(inboxCount(w)).toBe(0);
  });

  it("22. SILENCE TWO: an unchanged list is not re-sent the next day", async () => {
    const w = world();
    await seedDraft(w, "e_old", NOW - 3 * DAY);
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(1);
    // Next day, same drafts: silence. A daily repeat of an unchanged list is
    // a nag, and a nag trains deletion.
    expect((await sweepDraftsDigest(w.env as Env, NOW + DAY)).sent).toBe(0);
    // A NEW stale draft changes the set, and the digest speaks again.
    await seedDraft(w, "e_new", NOW - 2 * DAY);
    expect((await sweepDraftsDigest(w.env as Env, NOW + 2 * DAY)).sent).toBe(1);
  });

  it("23a. a broken account UN-marks, so it retries rather than going silent forever", async () => {
    // The bug the first draft of this module had: the marker went down before
    // the identity check, so a skip left today's set on record and every
    // later sweep read it as "unchanged" — silence forever for exactly the
    // account that needed attention.
    const w = fakeEnv();
    w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@bullmoose.cc", displayName: "Eric" });
    await seedDraft(w, "e_old", NOW - 3 * DAY);
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(0); // no identity yet
    expect(w.db.query(`SELECT id FROM agent_invocations WHERE account_id = ?`, ACCOUNT)).toHaveLength(0); // marker gone — tomorrow retries
    await w.env.DB.prepare(`INSERT INTO identities (id, account_id, email, name) VALUES ('id_e', ?, 'e@b.cc', 'E')`)
      .bind(ACCOUNT)
      .run();
    expect((await sweepDraftsDigest(w.env as Env, NOW + DAY)).sent).toBe(1);
  });

  it("23. an account with no drafts mailbox is silence, not a crash", async () => {
    const w = world();
    expect((await sweepDraftsDigest(w.env as Env, NOW)).sent).toBe(0);
  });
});
