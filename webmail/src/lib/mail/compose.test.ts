import { describe, expect, it } from "vitest";
import { createDemoBackend, demoIdentities } from "../jmap/demo";
import {
  ComposeError,
  buildForwardDraft,
  buildReplyDraft,
  loadIdentities,
  newDraft,
  parseAddressList,
  prefixSubject,
  saveAndSend,
  saveDraft,
  sendDraft,
  validateDraft,
} from "./compose";
import type { Email, Identity } from "./types";

const ACCOUNT = "acct-fake";
const identity = demoIdentities()[0] as Identity;

function original(partial: Partial<Email> = {}): Email {
  return {
    id: "e-orig",
    blobId: "b",
    threadId: "t",
    mailboxIds: { "mb-inbox": true },
    keywords: { $seen: true },
    size: 1,
    receivedAt: "2026-07-01T12:00:00.000Z",
    messageId: ["orig@x.test"],
    inReplyTo: null,
    from: [{ name: "Grace Hopper", email: "grace@example.test" }],
    to: [
      { name: "Eric Moore", email: "eric@bullmoose.test" },
      { name: "Alan", email: "alan@example.test" },
    ],
    cc: [{ name: "Ada", email: "ada@example.test" }],
    bcc: [],
    subject: "Kickoff",
    sentAt: null,
    hasAttachment: false,
    preview: "Let us begin.",
    attachments: [],
    textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
    bodyValues: { t: { value: "Let us begin." } },
    ...partial,
  } as Email;
}

describe("reply", () => {
  it("addresses the sender, prefixes Re:, and threads by In-Reply-To", () => {
    const draft = buildReplyDraft(original(), { identity });
    expect(draft.to.map((a) => a.email)).toEqual(["grace@example.test"]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe("Re: Kickoff");
    expect(draft.inReplyTo).toEqual(["orig@x.test"]);
  });

  it("does not double up the Re: prefix", () => {
    expect(prefixSubject("Re: Kickoff", "Re:")).toBe("Re: Kickoff");
    expect(prefixSubject("RE: Kickoff", "Re:")).toBe("RE: Kickoff");
    expect(prefixSubject("Fwd: x", "Fwd:")).toBe("Fwd: x");
  });

  it("names an empty subject rather than sending a bare prefix", () => {
    expect(prefixSubject("", "Re:")).toBe("Re: (no subject)");
  });

  it("reply-all keeps the other recipients but never mails you back", () => {
    const draft = buildReplyDraft(original(), { identity, replyAll: true });
    const everyone = [...draft.to, ...draft.cc].map((a) => a.email);
    expect(everyone).toContain("alan@example.test");
    expect(everyone).toContain("ada@example.test");
    expect(everyone).not.toContain("eric@bullmoose.test");
  });

  it("does not put the same person in both To and Cc", () => {
    const draft = buildReplyDraft(
      original({ cc: [{ name: "Grace Hopper", email: "grace@example.test" }] }),
      { identity, replyAll: true },
    );
    expect(draft.cc.map((a) => a.email)).not.toContain("grace@example.test");
  });

  it("quotes what they wrote, not what they in turn quoted", () => {
    const draft = buildReplyDraft(
      original({
        bodyValues: {
          t: { value: "Second thought.\n\nOn Monday, Bob wrote:\n> first thought" },
        },
      }),
      { identity },
    );
    expect(draft.text).toContain("> Second thought.");
    expect(draft.text).not.toContain("first thought");
  });

  it("includes an attribution line naming the sender", () => {
    const draft = buildReplyDraft(original(), { identity });
    expect(draft.text).toMatch(/On .*Grace Hopper <grace@example\.test> wrote:/);
  });
});

describe("forward", () => {
  it("prefixes Fwd:, empties the recipients and writes the header block", () => {
    const draft = buildForwardDraft(original(), { identity });
    expect(draft.subject).toBe("Fwd: Kickoff");
    expect(draft.to).toEqual([]);
    expect(draft.text).toContain("---------- Forwarded message ----------");
    expect(draft.text).toContain("From: Grace Hopper <grace@example.test>");
    expect(draft.text).toContain("Subject: Kickoff");
  });

  it("WARNS that attachments will not travel, rather than dropping them silently", () => {
    // `Email/set create` builds MIME from addresses/subject/body only; it has
    // no attachment path at all. Losing a PDF without saying so is the bug.
    const draft = buildForwardDraft(
      original({
        hasAttachment: true,
        attachments: [
          {
            partId: null,
            blobId: "b1",
            size: 1024,
            name: "spec.pdf",
            type: "application/pdf",
            cid: null,
            disposition: "attachment",
          },
        ],
      }),
      { identity },
    );
    expect(draft.droppedAttachments).toEqual([
      { name: "spec.pdf", size: 1024, type: "application/pdf" },
    ]);
  });

  it("does not warn about inline images, which are part of the body", () => {
    const draft = buildForwardDraft(
      original({
        attachments: [
          {
            partId: null,
            blobId: "b1",
            size: 10,
            name: "logo.png",
            type: "image/png",
            cid: "logo@x",
            disposition: "inline",
          },
        ],
      }),
      { identity },
    );
    expect(draft.droppedAttachments).toBeUndefined();
  });
});

describe("address parsing and validation", () => {
  it("parses names, angle brackets and separators", () => {
    expect(parseAddressList('Ada <ada@x.test>, bob@y.test; "Dr. C" <c@z.test>')).toEqual([
      { name: "Ada", email: "ada@x.test" },
      { name: null, email: "bob@y.test" },
      { name: "Dr. C", email: "c@z.test" },
    ]);
  });

  it("rejects a draft with no recipient", () => {
    expect(validateDraft(newDraft({ identity }))).toContain("Add at least one recipient.");
  });

  it("rejects an address that is not one", () => {
    const draft = { ...newDraft({ identity }), to: parseAddressList("not-an-address") };
    expect(validateDraft(draft).join(" ")).toContain("not an email address");
  });

  it("accepts a well-formed draft", () => {
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test") };
    expect(validateDraft(draft)).toEqual([]);
  });
});

describe("drafts", () => {
  it("creates the draft in the Drafts mailbox with $draft set", async () => {
    const { client, emails } = createDemoBackend();
    const draft = {
      ...newDraft({ identity }),
      to: parseAddressList("ada@x.test"),
      subject: "Hello",
    };
    const saved = await saveDraft(client, ACCOUNT, "mb-drafts", draft);

    const stored = emails.find((e) => e.id === saved.id);
    expect(stored?.mailboxIds["mb-drafts"]).toBe(true);
    expect(stored?.keywords.$draft).toBe(true);
    expect(stored?.keywords.$seen).toBe(true);
    expect(stored?.subject).toBe("Hello");
  });

  it("re-saving replaces the old copy in ONE Email/set", async () => {
    // A stored message is a pointer at an immutable MIME blob — `applyEmailPatch`
    // accepts only keywords/mailboxIds — so an edit is create + destroy.
    const { client, emails } = createDemoBackend();
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test"), subject: "v1" };
    const first = await saveDraft(client, ACCOUNT, "mb-drafts", draft);

    const before = client.sentBatches.length;
    const second = await saveDraft(
      client,
      ACCOUNT,
      "mb-drafts",
      { ...draft, subject: "v2" },
      { replaces: first.id },
    );

    expect(client.sentBatches.length).toBe(before + 1);
    expect(emails.find((e) => e.id === first.id)).toBeUndefined();
    expect(emails.find((e) => e.id === second.id)?.subject).toBe("v2");
  });

  it("reports a refusal instead of pretending the draft saved", async () => {
    const { client } = createDemoBackend({ scopes: ["read"] });
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test") };
    await expect(saveDraft(client, ACCOUNT, "mb-drafts", draft)).rejects.toBeInstanceOf(
      ComposeError,
    );
  });
});

describe("sending", () => {
  it("files the draft into Sent and clears $draft in the SAME call", async () => {
    const { client, emails, sent } = createDemoBackend();
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test"), subject: "Hi" };
    const saved = await saveDraft(client, ACCOUNT, "mb-drafts", draft);

    const before = client.sentBatches.length;
    const result = await sendDraft(client, ACCOUNT, {
      emailId: saved.id,
      identityId: identity.id,
      draftsMailboxId: "mb-drafts",
      sentMailboxId: "mb-sent",
      recipients: draft.to,
    });

    // One request carries both the submission and the filing.
    expect(client.sentBatches.length).toBe(before + 1);
    expect(result.submissionId).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rcptTo).toEqual(["ada@x.test"]);

    const stored = emails.find((e) => e.id === saved.id);
    expect(stored?.mailboxIds["mb-sent"]).toBe(true);
    expect(stored?.mailboxIds["mb-drafts"]).toBeUndefined();
    expect(stored?.keywords.$draft).toBeUndefined();
  });

  it("sends Bcc recipients in the envelope, where the relay can see them", async () => {
    const { client, sent } = createDemoBackend();
    const draft = {
      ...newDraft({ identity }),
      to: parseAddressList("ada@x.test"),
      bcc: parseAddressList("secret@x.test"),
      subject: "Hi",
    };
    await saveAndSend(client, ACCOUNT, {
      spec: draft,
      identityId: identity.id,
      draftsMailboxId: "mb-drafts",
      sentMailboxId: "mb-sent",
    });
    expect(sent[0]?.rcptTo).toEqual(["ada@x.test", "secret@x.test"]);
  });

  it("does not send envelope.mailFrom — the identity is authoritative", async () => {
    const { client } = createDemoBackend();
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test") };
    await saveAndSend(client, ACCOUNT, {
      spec: draft,
      identityId: identity.id,
      draftsMailboxId: "mb-drafts",
      sentMailboxId: "mb-sent",
    });
    const submit = client.sentBatches.at(-1)?.[0]?.[1] as {
      create: Record<string, { envelope?: Record<string, unknown> }>;
    };
    expect(submit.create.s0?.envelope).not.toHaveProperty("mailFrom");
  });

  it("refuses to relay a message that is not a draft", async () => {
    const { client, emails } = createDemoBackend();
    const inbound = emails[0] as Email;
    await expect(
      sendDraft(client, ACCOUNT, {
        emailId: inbound.id,
        identityId: identity.id,
        draftsMailboxId: "mb-drafts",
        sentMailboxId: "mb-sent",
        recipients: [{ name: null, email: "ada@x.test" }],
      }),
    ).rejects.toThrow(/not a draft/);
  });

  it("explains a send-scope refusal in words, not an error code", async () => {
    const { client } = createDemoBackend({ scopes: ["read", "draft"] });
    const draft = { ...newDraft({ identity }), to: parseAddressList("ada@x.test") };
    await expect(
      saveAndSend(client, ACCOUNT, {
        spec: draft,
        identityId: identity.id,
        draftsMailboxId: "mb-drafts",
        sentMailboxId: "mb-sent",
      }),
    ).rejects.toThrow(/needs the “send” permission/);
  });

  it("validates before it writes anything", async () => {
    const { client, emails } = createDemoBackend();
    const count = emails.length;
    await expect(
      saveAndSend(client, ACCOUNT, {
        spec: newDraft({ identity }),
        identityId: identity.id,
        draftsMailboxId: "mb-drafts",
        sentMailboxId: "mb-sent",
      }),
    ).rejects.toThrow(/at least one recipient/);
    expect(emails).toHaveLength(count);
  });
});

describe("identities", () => {
  it("loads the addresses this account may send as", async () => {
    const { client } = createDemoBackend();
    const list = await loadIdentities(client, ACCOUNT);
    expect(list.map((i) => i.email)).toEqual(["eric@bullmoose.test"]);
  });
});
