#!/usr/bin/env node
// Follow one message through every stage it touches, in order, and say where
// it stopped. The unit tests prove each stage in isolation; this proves they
// are CONNECTED — the seam where a silent stall hides (an invocation nobody
// claims looks exactly like an invocation nobody needed).
//
//   node infra/trace.mjs                 # the newest inbound message
//   node infra/trace.mjs <email-id>      # one specific message
//   node infra/trace.mjs --recent 5      # the last N, one line each
//
// Read-only. Runs every query against the REMOTE shard via wrangler.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DB = "bullmoose-mail-shard0";

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
  // The names are inverted relative to capability on this account: only
  // RUNTIME can read worker/D1 resources. Pick by capability, not by label.
  env.CLOUDFLARE_API_TOKEN = env.BULLMOOSE_RUNTIME_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  return env;
}

const env = loadEnv();

function q(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out)[0].results;
}

const one = (sql) => q(sql)[0] ?? null;
const esc = (s) => String(s).replace(/'/g, "''");
const when = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—");
/** emails.from_json is a JSON EmailAddress[] — show the first address. */
function senderOf(json) {
  try {
    const a = JSON.parse(json ?? "[]")[0];
    return a?.email ?? a?.address ?? "(unknown)";
  } catch {
    return "(unparseable)";
  }
}

const OK = "✓";
const NO = "✗";
const DOT = "·";

/** A stage line: mark, label, detail. `state` drives the mark only. */
function line(state, label, detail = "") {
  const mark = state === "ok" ? OK : state === "stop" ? NO : DOT;
  console.log(`  ${mark} ${label.padEnd(22)} ${detail}`);
}

function traceOne(emailId) {
  const e = one(`
    SELECT id, account_id, subject, from_json, received_at
      FROM emails WHERE id = '${esc(emailId)}'`);
  if (!e) {
    console.log(`no email ${emailId}`);
    return;
  }

  console.log(`\n${e.id}`);
  console.log(`  from ${senderOf(e.from_json)}  ${when(e.received_at)}`);
  console.log(`  "${(e.subject ?? "").slice(0, 68)}"\n`);

  // 1. stored, and where it landed (quarantine is a real mailbox, so the
  // mailbox name IS the cascade's verdict for a held message)
  const boxes = q(`
    SELECT m.name, m.role FROM email_mailboxes em
      JOIN mailboxes m ON m.id = em.mailbox_id AND m.account_id = em.account_id
     WHERE em.email_id = '${esc(e.id)}'`);
  line(
    "ok",
    "stored",
    boxes.map((b) => `${b.name}${b.role ? ` (${b.role})` : ""}`).join(", ") || "no mailbox",
  );

  // 2. the boundary cascade — quarantine events name the firing stage
  const qe = q(`
    SELECT event, stage, at FROM quarantine_events
     WHERE email_id = '${esc(e.id)}' ORDER BY at`);
  if (qe.length === 0) {
    line("ok", "boundary cascade", "passed (no quarantine event)");
  } else {
    for (const r of qe)
      line(
        r.event === "rescued" || r.event === "released" ? "ok" : "stop",
        "boundary cascade",
        `${r.event} @ ${r.stage ?? "?"}  ${when(r.at)}`,
      );
  }

  // 3. invocations — the facets ingest stamped, and whether anyone claimed
  const invs = q(`
    SELECT id, binding_id, status, claimed_at, done_at, note, due_at,
           privacy, sender_class, effort_prior, requires_json,
           claimant_free, cost_micros, alert_kind
      FROM agent_invocations
     WHERE email_id = '${esc(e.id)}' ORDER BY created_at`);
  if (invs.length === 0) {
    line("dot", "invocations", "none created (no binding triggered)");
  }
  for (const inv of invs) {
    const facets = [
      inv.due_at ? `due=${when(inv.due_at)}` : null,
      inv.privacy ? `privacy=${inv.privacy}` : null,
      inv.sender_class ? `sender=${inv.sender_class}` : null,
      inv.effort_prior ? `effort=${inv.effort_prior}` : null,
      inv.requires_json ? `requires=${inv.requires_json}` : null,
    ].filter(Boolean);
    line("ok", "facets stamped", facets.length ? facets.join("  ") : "none (DefaultCase)");

    const claimed = inv.claimed_at
      ? `claimed ${when(inv.claimed_at)} by ${inv.claimant_free === 1 ? "free" : "paid"}`
      : "UNCLAIMED";
    // A pending invocation nobody has claimed is the silent-stall shape this
    // tool exists to surface — the gate refusing everyone looks like idleness.
    line(inv.claimed_at ? "ok" : "stop", `invocation ${inv.status}`, `${inv.id}  ${claimed}`);
    if (inv.alert_kind) line("stop", "  alert", inv.alert_kind);
    if (inv.note) line("dot", "  note", inv.note);
    if (inv.cost_micros != null) line("dot", "  cost", `${inv.cost_micros} micro-USD`);

    // agent_proposals.id IS agent_invocations.id — a 1:1 key, not a foreign one
    const props = q(`
      SELECT id, kind, status FROM agent_proposals WHERE id = '${esc(inv.id)}'`);
    if (props.length === 0 && inv.status === "done") {
      line("dot", "  proposal", "none (the run produced no proposal)");
    }
    for (const p of props) {
      line("ok", "  proposal", `${p.kind} → ${p.status}  ${p.id}`);
    }
  }

  // 4. did anything reach a governing book? (a widening is chained)
  const chain = q(`
    SELECT event, address, actor, via_proposal_id, at
      FROM book_membership_log
     WHERE account_id = '${esc(e.account_id)}' AND at >= ${Number(e.received_at) || 0}
     ORDER BY at`);
  for (const c of chain) {
    line(
      "ok",
      "book chain",
      `${c.event} ${c.address} by ${c.actor}${c.via_proposal_id ? ` via ${c.via_proposal_id}` : ""}`,
    );
  }
  console.log("");
}

function recent(n) {
  const rows = q(`
    SELECT e.id, e.from_json, e.subject, e.received_at,
           (SELECT count(*) FROM agent_invocations i WHERE i.email_id = e.id) AS invs,
           (SELECT count(*) FROM quarantine_events x WHERE x.email_id = e.id) AS quar
      FROM emails e ORDER BY e.received_at DESC LIMIT ${Number(n) || 5}`);
  console.log("");
  for (const r of rows) {
    console.log(
      `  ${when(r.received_at)}  ${String(r.id).padEnd(22)} inv=${r.invs} quar=${r.quar}  ${senderOf(r.from_json).slice(0, 30)}`,
    );
  }
  console.log("");
}

const [arg, val] = process.argv.slice(2);
if (arg === "--recent") {
  recent(val ?? 5);
} else if (arg) {
  traceOne(arg);
} else {
  const newest = one(`SELECT id FROM emails ORDER BY received_at DESC LIMIT 1`);
  if (!newest) console.log("no mail in the shard");
  else traceOne(newest.id);
}
