// Post-deploy delivery check: send a message to yourself, wait for it to
// arrive. Token-only — no browser, no passkey, no human.
//
// ## Why this exists
//
// On 2026-08-24 a deploy shipped code whose INSERT named a column the shard
// did not have. Ingest threw on every inbound message and Email Routing
// bounced mail for fourteen hours. It surfaced because a human received a
// bounce.
//
// #382 added a gate that refuses to deploy when a migration marked
// `blocks: "deploy"` is unapplied. That gate is real, and it is not enough:
// it only catches failures somebody PREDICTED and remembered to tag. Had that
// migration not carried the marker, the gate would have passed and the mail
// would still have bounced.
//
// This check predicts nothing. It sends a real message down the real path —
// submit → SES → the internet → Cloudflare Email Routing → ingest → mailbox —
// and asserts it arrives. It does not care WHY delivery is broken, which is
// exactly the property the gate cannot have.
//
// ## What a failure tells you
//
// The two halves fail differently and that difference is the diagnosis:
//
//   send failed        submit / SES / identity / auth — outbound
//   sent, never came   ingest / Email Routing / delivery — INBOUND, the
//                      yesterday shape
//
// So the report names which half, rather than "smoke test failed".
//
// ## Running it
//
//   BULLMOOSE_SMOKE_BASE=https://app.bullmoose.cc \
//   BULLMOOSE_SMOKE_TOKEN=… \
//   BULLMOOSE_SMOKE_ADDRESS=you@example.com \
//   node tools/smoke-mail.mjs
//
// Exit codes: 0 delivered · 1 delivery is broken · 2 not configured (which is
// NOT a pass — an unconfigured check that exits 0 is the marker-nobody-reads
// failure this whole exercise was about).

const BASE = process.env.BULLMOOSE_SMOKE_BASE ?? "";
const TOKEN = process.env.BULLMOOSE_SMOKE_TOKEN ?? "";
const ADDRESS = process.env.BULLMOOSE_SMOKE_ADDRESS ?? "";
// Routing is usually seconds. Minutes of headroom costs nothing on a deploy
// and is the difference between a real signal and a flaky one that gets muted.
const DEADLINE_MS = Number(process.env.BULLMOOSE_SMOKE_TIMEOUT_MS ?? 180_000);
const POLL_MS = 5_000;

if (!BASE || !TOKEN || !ADDRESS) {
  console.error(
    "smoke-mail is not configured. It needs, all three:\n" +
      "  BULLMOOSE_SMOKE_BASE     the JMAP origin, e.g. https://app.bullmoose.cc\n" +
      "  BULLMOOSE_SMOKE_TOKEN    an account token that may send and read its own mail\n" +
      "  BULLMOOSE_SMOKE_ADDRESS  that account's address — the message goes to itself\n\n" +
      "Exiting 2: an unconfigured check must not report success.",
  );
  process.exit(2);
}

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SUBJECT = `bullmoose post-deploy delivery check ${RUN}`;

const log = (m) => console.log(`  ${m}`);
const die = (half, m, detail) => {
  console.error(`\n✗ ${half}: ${m}`);
  if (detail) console.error(`    ${String(detail).slice(0, 500)}`);
  process.exit(1);
};

async function jmap(methodCalls, half) {
  let res;
  try {
    res = await fetch(`${BASE}/api/jmap`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
        methodCalls,
      }),
    });
  } catch (e) {
    die(half, `could not reach ${BASE}/api/jmap`, e.message);
  }
  if (!res.ok) die(half, `api/jmap answered HTTP ${res.status}`, await res.text());
  const body = await res.json();
  const errors = (body.methodResponses ?? []).filter((r) => r[0] === "error");
  if (errors.length) die(half, "JMAP returned an error", JSON.stringify(errors));
  return body.methodResponses;
}

const main = async () => {
  console.log(`\npost-deploy delivery check — ${ADDRESS}`);

  // ---- who am I, and where do drafts and inbox live ----
  const [session, mailboxes, identities] = await jmap(
    [
      ["Core/echo", {}, "s"],
      ["Mailbox/get", { accountId: null, properties: ["id", "role", "name"] }, "m"],
      ["Identity/get", { accountId: null }, "i"],
    ],
    "setup",
  ).then(async (r) => {
    // accountId: null is not universally accepted; fall back to the session.
    if (r[1]?.[0] === "Mailbox/get") return [r[0], r[1], r[2]];
    return r;
  });
  void session;

  const boxes = mailboxes[1]?.list ?? [];
  const accountId = mailboxes[1]?.accountId;
  const inbox = boxes.find((b) => b.role === "inbox");
  const drafts = boxes.find((b) => b.role === "drafts");
  const identity = identities[1]?.list?.[0];
  if (!inbox) die("setup", "this account has no inbox — nothing to deliver into");
  if (!identity) die("setup", "this account has no identity — nothing to send from");

  // ---- send ----
  const created = await jmap(
    [
      [
        "Email/set",
        {
          accountId,
          create: {
            draft: {
              mailboxIds: { [(drafts ?? inbox).id]: true },
              keywords: { $draft: true },
              from: [{ email: ADDRESS }],
              to: [{ email: ADDRESS }],
              subject: SUBJECT,
              bodyStructure: { type: "text/plain", partId: "b" },
              bodyValues: {
                b: {
                  value:
                    `Automated delivery check for run ${RUN}.\n\n` +
                    `If you are reading this in a mailbox, the inbound path works: ` +
                    `submit -> SES -> Email Routing -> ingest -> here.\n`,
                },
              },
            },
          },
        },
        "e",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            sub: {
              emailId: "#draft",
              identityId: identity.id,
              envelope: { mailFrom: { email: ADDRESS }, rcptTo: [{ email: ADDRESS }] },
            },
          },
          // Clean up after ourselves: the draft has served its purpose the
          // moment it is submitted, and a mailbox slowly filling with smoke
          // tests is its own small mess.
          onSuccessDestroyEmail: ["#sub"],
        },
        "s",
      ],
    ],
    "send",
  );

  const notCreated = created[1]?.notCreated ?? created[0]?.[1]?.notCreated;
  if (notCreated && Object.keys(notCreated).length) {
    die("send", "the submission was refused", JSON.stringify(notCreated));
  }
  log(`sent  ${SUBJECT}`);

  // ---- wait for it to come back ----
  const started = Date.now();
  for (;;) {
    const [q] = await jmap(
      [["Email/query", { accountId, filter: { inMailbox: inbox.id, subject: SUBJECT }, limit: 5 }, "q"]],
      "receive",
    );
    const ids = q[1]?.ids ?? [];
    if (ids.length) {
      const waited = ((Date.now() - started) / 1000).toFixed(1);
      log(`arrived after ${waited}s`);
      // Leave the mailbox as we found it.
      await jmap([["Email/set", { accountId, destroy: ids }, "d"]], "cleanup");
      log("cleaned up");
      console.log("\n✓ delivery works end to end\n");
      process.exit(0);
    }
    if (Date.now() - started > DEADLINE_MS) {
      die(
        "receive",
        `the message was SENT but never arrived within ${DEADLINE_MS / 1000}s`,
        "Outbound worked, so this is the INBOUND path: Cloudflare Email Routing, the ingest worker, or " +
          "delivery itself. This is the shape of the 2026-08-24 outage — check `wrangler tail bullmoose-ingest` " +
          "and whether a migration is unapplied.",
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

main().catch((e) => {
  console.error(`\n✗ smoke-mail crashed: ${e.message}\n`);
  process.exit(1);
});
