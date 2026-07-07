import { commitChanges } from "@bullmoose/account-do";
import { buildMime } from "@bullmoose/mime";
import type { EmailRow, Mailstore } from "@bullmoose/mailstore";
import { callWithFallback, type BindingConfig, type Env } from "./models.js";

/**
 * Ledger pipeline — "Allen the Analyst" (analyst@bullmoose.cc).
 *
 * Receipts in, enriched digests out. The division of labor is strict:
 * the model EXTRACTS one fact and NARRATES computed numbers; every sum
 * is SQL over spend_facts. The agent never replies to the sender
 * (receipts come from noreply@; answering them is backscatter) — it
 * forwards a digest to a configured target. A plus-tag on the receipt
 * address (analyst+eric@) SELECTS a target from config.digestTargets;
 * it is never used to construct an address from mail content.
 *
 * Ledger gates, in order:
 *   1. Authentication-Results must show spf/dkim pass (config.requireAuth)
 *   2. heuristic prefilter (currency/receipt vocabulary) — no model cost
 *   3. model extraction, JSON-schema validated, one retry
 *   4. dedup hash (vendor|amount|date) — re-forwarded receipts no-op
 *
 * `bootstrap` subject + CSV attachment bulk-imports history so YoY
 * comparisons work from day one. CSV: vendor,amount,currency,date[,category]
 */

interface SpendFact {
  vendor: string;
  amountCents: number;
  currency: string;
  txnDate: string; // YYYY-MM-DD
  category: string;
  confidence: number;
}

const DEFAULT_CATEGORIES = [
  "saas",
  "utilities",
  "home",
  "insurance",
  "travel",
  "food",
  "health",
  "other",
];

export async function runLedger(
  env: Env,
  store: Mailstore,
  job: {
    id: string;
    account_id: string;
    binding_name: string;
    tenant_id: string;
    context_json?: string;
  },
  cfg: BindingConfig,
  email: EmailRow,
  parsed: {
    text?: string;
    headers?: Array<{ key: string; value: string }>;
  },
  selfAddress: string,
  finish: (status: "done" | "failed", result: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const digestTo = resolveDigestTarget(cfg, email, selfAddress, job.context_json);
  if (!digestTo) return finish("failed", { note: "no digestTo/digestTargets configured" });

  // Anything that isn't a bookable receipt still FORWARDS to the digest
  // target with a light note — the mailbox never silently eats mail.
  const passAlong = async (note: string, invNote: string) => {
    const fwdId = await forwardOriginal(env, store, job, { selfAddress, to: digestTo, note, email, parsed });
    return finish("done", { note: invNote, forwardedEmailId: fwdId });
  };

  // Gate 1: authenticity. Receipts are financial writes — forged From
  // headers must not reach the ledger.
  if (cfg.requireAuth !== false && !authPasses(parsed)) {
    return passAlong(
      "⚠ Could not verify this sender (no SPF/DKIM pass) — treat with care. No spending metrics recorded.",
      "forwarded: no spf/dkim pass",
    );
  }

  const text = parsed.text ?? email.preview;

  // CSV bootstrap path — same validation/insert machinery, no model.
  if (/^bootstrap\b/i.test(email.subject)) {
    return bootstrapCsv(env, store, job, cfg, email, selfAddress, digestTo, finish);
  }

  // Gate 2: cheap vocabulary prefilter before any model spend.
  if (!/[$€£]\s?\d|\bUSD\b|\btotal\b|\breceipt\b|\binvoice\b|\bpayment\b|\bamount\b/i.test(text)) {
    return passAlong(
      "Could not discover spending metrics in this message — forwarding it along.",
      "forwarded: no receipt vocabulary",
    );
  }

  // Gate 3: extraction. One fact, schema-validated, one retry.
  const fact = await extractFact(env, cfg, text, email.subject);
  if (!fact) {
    return passAlong(
      "Could not discover spending metrics in this message — forwarding it along.",
      "forwarded: not a receipt per extraction",
    );
  }

  // Gate 4: dedup.
  const inserted = await insertFact(env, job.account_id, email.id, fact);
  if (!inserted) {
    return passAlong(
      `Already recorded this receipt (${fact.vendor} — ${money(fact.amountCents)} on ${fact.txnDate}); not double-counting. Forwarding for reference.`,
      `duplicate: ${fact.vendor} ${fact.amountCents} ${fact.txnDate}`,
    );
  }

  const agg = await aggregates(env, job.account_id, fact);
  const commentary = await narrate(env, cfg, job.binding_name, fact, agg);
  const digestEmailId = await sendDigest(env, store, job, {
    selfAddress,
    to: digestTo,
    subject: digestSubject(fact, agg),
    fact,
    agg,
    commentary,
    chartMinPoints: cfg.chartMinPoints ?? 10,
  });

  return finish("done", {
    fact: `${fact.vendor} ${(fact.amountCents / 100).toFixed(2)} ${fact.currency}`,
    digestTo,
    digestEmailId,
  });
}

// ---- target resolution -------------------------------------------------

/**
 * analyst+eric@… → digestTargets["eric"]. The envelope RCPT (stashed in the
 * invocation context by ingest) is authoritative; the To header is the
 * fallback. Unknown/absent tag → cfg.digestTo.
 */
function resolveDigestTarget(
  cfg: BindingConfig,
  email: EmailRow,
  selfAddress: string,
  contextJson?: string,
): string | null {
  const [selfLocal, selfDomain] = selfAddress.toLowerCase().split("@");
  const candidates: string[] = [];
  try {
    const ctx = JSON.parse(contextJson ?? "{}") as { envelopeTo?: string };
    if (ctx.envelopeTo) candidates.push(ctx.envelopeTo.toLowerCase());
  } catch {
    /* fall through to headers */
  }
  for (const a of [...email.to, ...email.cc]) candidates.push(a.email.toLowerCase());

  for (const addr of candidates) {
    const m = new RegExp(`^${selfLocal}\\+([a-z0-9._-]+)@${selfDomain}$`).exec(addr);
    const target = m && cfg.digestTargets?.[m[1] as string];
    if (target) return target;
  }
  return cfg.digestTo ?? null;
}

function authPasses(parsed: { headers?: Array<{ key: string; value: string }> }): boolean {
  for (const h of parsed.headers ?? []) {
    if (h.key.toLowerCase() !== "authentication-results") continue;
    if (/\b(spf|dkim)=pass\b/i.test(h.value)) return true;
  }
  return false;
}

// ---- extraction --------------------------------------------------------

async function extractFact(
  env: Env,
  cfg: BindingConfig,
  text: string,
  subject: string,
): Promise<SpendFact | null> {
  const categories = cfg.categories ?? DEFAULT_CATEGORIES;
  const system = `You extract purchase data from emails. Respond with ONLY minified JSON, no code fences, matching:
{"is_receipt":boolean,"vendor":string,"amount":number,"currency":"USD"|string,"date":"YYYY-MM-DD","category":string,"confidence":number}
- is_receipt: true only for a receipt/invoice/payment confirmation for a completed or billed charge
- vendor: short merchant name, lowercase, hyphenated (e.g. "sparkling-pools")
- amount: the total charged, as a number
- date: the transaction/billing date; if absent use the email's date if visible, else ""
- category: one of ${categories.join(", ")}
- confidence: 0..1, your certainty in vendor+amount+date`;
  const user = `Subject: ${subject}\n\n${text.slice(0, 6000)}`;

  const candidates = cfg.modelAliases?.[cfg.defaultModel ?? "cheap"] ?? [];
  if (candidates.length === 0) throw new Error("ledger: no extraction model configured");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = [
      { role: "system" as const, content: system },
      {
        role: "user" as const,
        content: attempt === 0 ? user : `${user}\n\nYour previous output was invalid (${lastError}). JSON only.`,
      },
    ];
    const { output } = await callWithFallback(env, candidates, prompt, 512);
    const parsed = parseFactJson(output, categories);
    if (parsed === "not-receipt") return null;
    if (parsed !== "invalid") return parsed;
    lastError = "failed schema validation";
  }
  return null;
}

function parseFactJson(
  output: string,
  categories: string[],
): SpendFact | "not-receipt" | "invalid" {
  const jsonText = output.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "");
  const m = /\{[\s\S]*\}/.exec(jsonText);
  if (!m) return "invalid";
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (o.is_receipt === false) return "not-receipt";
    const amount = Number(o.amount);
    const date = String(o.date ?? "");
    const vendor = String(o.vendor ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (o.is_receipt !== true || !vendor || !Number.isFinite(amount) || amount <= 0) return "invalid";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "invalid";
    const category = categories.includes(String(o.category)) ? String(o.category) : "other";
    return {
      vendor,
      amountCents: Math.round(amount * 100),
      currency: String(o.currency ?? "USD").toUpperCase().slice(0, 3),
      txnDate: date,
      category,
      confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0.5)),
    };
  } catch {
    return "invalid";
  }
}

// ---- ledger writes -----------------------------------------------------

async function insertFact(
  env: Env,
  accountId: string,
  emailId: string | null,
  f: SpendFact,
): Promise<boolean> {
  const dedup = await sha256Hex(`${f.vendor}|${f.amountCents}|${f.txnDate}`);
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO spend_facts
       (account_id, id, email_id, vendor, amount_cents, currency, txn_date,
        period_month, category, confidence, dedup_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      accountId,
      `sf_${crypto.randomUUID()}`,
      emailId,
      f.vendor,
      f.amountCents,
      f.currency,
      f.txnDate,
      f.txnDate.slice(0, 7),
      f.category,
      f.confidence,
      dedup,
      Date.now(),
    )
    .run();
  return res.meta.changes === 1;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- aggregation (SQL owns the arithmetic) -----------------------------

export interface Aggregates {
  currency: string;
  totalYtdCents: number;
  lastYearSamePeriodCents: number;
  vendorYtdCents: number;
  vendorYtdCount: number;
  points: number;
  monthly: Array<{ month: string; thisYearCents: number; lastYearCents: number }>;
  year: string;
  lastYear: string;
}

async function aggregates(env: Env, accountId: string, f: SpendFact): Promise<Aggregates> {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const lastYear = String(Number(year) - 1);
  const lyToday = `${lastYear}${today.slice(4)}`;

  const one = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).first<{ v: number }>())?.v ?? 0;

  const cur = f.currency;
  const totalYtdCents = await one(
    `SELECT COALESCE(SUM(amount_cents),0) v FROM spend_facts
     WHERE account_id = ? AND currency = ? AND txn_date >= ? AND txn_date <= ?`,
    accountId, cur, `${year}-01-01`, today,
  );
  const lastYearSamePeriodCents = await one(
    `SELECT COALESCE(SUM(amount_cents),0) v FROM spend_facts
     WHERE account_id = ? AND currency = ? AND txn_date >= ? AND txn_date <= ?`,
    accountId, cur, `${lastYear}-01-01`, lyToday,
  );
  const vendorYtdCents = await one(
    `SELECT COALESCE(SUM(amount_cents),0) v FROM spend_facts
     WHERE account_id = ? AND currency = ? AND vendor = ? AND txn_date >= ?`,
    accountId, cur, f.vendor, `${year}-01-01`,
  );
  const vendorYtdCount = await one(
    `SELECT COUNT(*) v FROM spend_facts
     WHERE account_id = ? AND currency = ? AND vendor = ? AND txn_date >= ?`,
    accountId, cur, f.vendor, `${year}-01-01`,
  );
  const points = await one(
    `SELECT COUNT(*) v FROM spend_facts WHERE account_id = ? AND currency = ?`,
    accountId, cur,
  );

  const { results } = await env.DB.prepare(
    `SELECT period_month, SUM(amount_cents) c FROM spend_facts
     WHERE account_id = ? AND currency = ? AND (period_month LIKE ? OR period_month LIKE ?)
     GROUP BY period_month`,
  )
    .bind(accountId, cur, `${year}-%`, `${lastYear}-%`)
    .all<{ period_month: string; c: number }>();
  const byMonth = new Map(results.map((r) => [r.period_month, r.c]));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, "0");
    return {
      month: mm,
      thisYearCents: byMonth.get(`${year}-${mm}`) ?? 0,
      lastYearCents: byMonth.get(`${lastYear}-${mm}`) ?? 0,
    };
  });

  return {
    currency: cur,
    totalYtdCents,
    lastYearSamePeriodCents,
    vendorYtdCents,
    vendorYtdCount,
    points,
    monthly,
    year,
    lastYear,
  };
}

// ---- narration (model sees ONLY computed numbers) ----------------------

async function narrate(
  env: Env,
  cfg: BindingConfig,
  bindingName: string,
  f: SpendFact,
  agg: Aggregates,
): Promise<string> {
  const candidates = cfg.modelAliases?.[cfg.defaultModel ?? "cheap"] ?? [];
  const facts = {
    newCharge: `${money(f.amountCents)} ${f.currency} from ${f.vendor} on ${f.txnDate} (${f.category})`,
    vendorYtd: `${money(agg.vendorYtdCents)} across ${agg.vendorYtdCount} charge(s)`,
    totalYtd: money(agg.totalYtdCents),
    sameTimeLastYear: money(agg.lastYearSamePeriodCents),
  };
  try {
    const { output } = await callWithFallback(
      env,
      candidates,
      [
        {
          role: "system",
          content: `You are ${bindingName}, a concise financial analyst. Write 2-3 plain sentences of context using ONLY the numbers provided — do not compute new figures beyond simple comparisons, do not invent data. No preamble.`,
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
      256,
    );
    return output.trim();
  } catch {
    return ""; // digest still ships — the math is already done
  }
}

// ---- digest ------------------------------------------------------------

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function digestSubject(f: SpendFact, agg: Aggregates): string {
  const delta =
    agg.lastYearSamePeriodCents > 0
      ? ` (${agg.totalYtdCents >= agg.lastYearSamePeriodCents ? "+" : ""}${Math.round(((agg.totalYtdCents - agg.lastYearSamePeriodCents) / agg.lastYearSamePeriodCents) * 100)}% YoY)`
      : "";
  return `💰 ${money(f.amountCents)} ${f.vendor} — YTD ${money(agg.totalYtdCents)}${delta}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Email-safe chart: table rows with inline-styled div bars. No SVG, no images. */
export function chartHtml(agg: Aggregates): string {
  const max = Math.max(1, ...agg.monthly.flatMap((m) => [m.thisYearCents, m.lastYearCents]));
  const rows = agg.monthly
    .filter((m) => m.thisYearCents > 0 || m.lastYearCents > 0)
    .map((m) => {
      const w1 = Math.round((m.thisYearCents / max) * 100);
      const w2 = Math.round((m.lastYearCents / max) * 100);
      return `<tr>
<td style="padding:2px 8px 2px 0;font:12px monospace;vertical-align:top">${MONTH_NAMES[Number(m.month) - 1]}</td>
<td style="width:320px;padding:2px 0">
<div style="background:#0a4d8c;width:${w1}%;height:9px;margin-bottom:2px"></div>
<div style="background:#9fc3e8;width:${w2}%;height:9px"></div>
</td>
<td style="padding:2px 0 2px 8px;font:12px monospace;white-space:nowrap">${money(m.thisYearCents)} / ${money(m.lastYearCents)}</td>
</tr>`;
    })
    .join("\n");
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr><td></td><td style="font:11px sans-serif;color:#555;padding-bottom:4px">
<span style="background:#0a4d8c;padding:0 6px;margin-right:4px"></span>${agg.year}
<span style="background:#9fc3e8;padding:0 6px;margin:0 4px 0 12px"></span>${agg.lastYear}
</td><td style="font:11px sans-serif;color:#555">this yr / last yr</td></tr>
${rows}
</table>`;
}

async function sendDigest(
  env: Env,
  store: Mailstore,
  job: { id: string; account_id: string; binding_name: string; tenant_id: string },
  d: {
    selfAddress: string;
    to: string;
    subject: string;
    fact: SpendFact | null;
    agg: Aggregates;
    commentary: string;
    chartMinPoints: number;
    extraText?: string;
  },
): Promise<string> {
  const { agg } = d;
  const lines: string[] = [];
  if (d.fact) {
    lines.push(
      `${d.fact.vendor} — ${money(d.fact.amountCents)} ${d.fact.currency} (${d.fact.txnDate}, ${d.fact.category})${d.fact.confidence < 0.7 ? "  ⚠ low confidence — please verify" : ""}`,
    );
    lines.push(`YTD with them: ${money(agg.vendorYtdCents)} across ${agg.vendorYtdCount} charge(s).`);
  }
  if (d.extraText) lines.push(d.extraText);
  lines.push(
    `Total ${agg.year} YTD: ${money(agg.totalYtdCents)}${
      agg.lastYearSamePeriodCents > 0
        ? ` vs ${money(agg.lastYearSamePeriodCents)} by this date ${agg.lastYear}`
        : ""
    }.`,
  );
  if (d.commentary) lines.push("", d.commentary);

  const hasChart = agg.points >= d.chartMinPoints;
  const progress = hasChart
    ? ""
    : `\n\n${agg.points}/${d.chartMinPoints} data points toward your first chart.`;

  const text = lines.join("\n") + progress + `\n\n— ${job.binding_name} · bullmoose agent`;
  const html = `<div style="font:14px/1.5 sans-serif;max-width:520px">
${lines.map((l) => (l === "" ? "<br>" : `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`)).join("\n")}
${hasChart ? chartHtml(agg) : `<p style="color:#777">${escapeHtml(progress.trim())}</p>`}
<p style="color:#999;font-size:12px;margin-top:16px">— ${escapeHtml(job.binding_name)} · bullmoose agent</p>
</div>`;

  const now = Date.now();
  const messageId = `${crypto.randomUUID()}@${d.selfAddress.split("@")[1] ?? "localhost"}`;
  const raw = buildMime({
    from: [{ name: job.binding_name, email: d.selfAddress }],
    to: [{ email: d.to }],
    subject: d.subject,
    messageId,
    date: new Date(now),
    text,
    html,
    extraHeaders: [
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
      `X-Bullmoose-Invocation: ${job.id}`,
    ],
  });

  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(job.tenant_id, job.account_id, buf);
  const res = await env.SUBMIT.fetch("https://submit.internal/internal/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify({
      accountId: job.account_id,
      tenantId: job.tenant_id,
      blobId,
      envelope: { mailFrom: d.selfAddress, rcptTo: [d.to] },
    }),
  });
  if (!res.ok) throw new Error(`digest relay failed (${res.status}): ${await res.text()}`);

  const sentId = await store.ensureRoleMailbox(job.account_id, "sent", "Sent");
  const emailId = `e_${crypto.randomUUID()}`;
  await store.insertEmail(job.account_id, {
    id: emailId,
    blobId,
    threadId: `t_${crypto.randomUUID()}`,
    messageId,
    inReplyTo: null,
    subject: d.subject,
    from: [{ name: job.binding_name, email: d.selfAddress }],
    to: [{ email: d.to }],
    cc: [],
    bcc: [],
    preview: text.slice(0, 256),
    size: raw.byteLength,
    receivedAt: now,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [sentId],
    keywords: ["$seen", "$agent"],
  });
  await commitChanges(env.ACCOUNT_DO, job.account_id, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [sentId] },
  ]);
  return emailId;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- pass-along forwarding ---------------------------------------------

/** Forward a non-receipt to the digest target, original body intact. */
async function forwardOriginal(
  env: Env,
  store: Mailstore,
  job: { id: string; account_id: string; binding_name: string; tenant_id: string },
  f: {
    selfAddress: string;
    to: string;
    note: string;
    email: EmailRow;
    parsed: { text?: string };
  },
): Promise<string> {
  const orig = f.email;
  const from = orig.from[0];
  const subject = /^fwd:/i.test(orig.subject) ? orig.subject : `Fwd: ${orig.subject}`;
  const text = `${f.note}

---------- Forwarded message ----------
From: ${from?.name ? `${from.name} <${from.email}>` : from?.email ?? "(unknown)"}
Date: ${new Date(orig.receivedAt).toUTCString()}
Subject: ${orig.subject}

${f.parsed.text ?? orig.preview}`;

  const now = Date.now();
  const messageId = `${crypto.randomUUID()}@${f.selfAddress.split("@")[1] ?? "localhost"}`;
  const raw = buildMime({
    from: [{ name: job.binding_name, email: f.selfAddress }],
    to: [{ email: f.to }],
    subject,
    messageId,
    date: new Date(now),
    text,
    extraHeaders: [
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
      `X-Bullmoose-Invocation: ${job.id}`,
    ],
  });

  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(job.tenant_id, job.account_id, buf);
  const res = await env.SUBMIT.fetch("https://submit.internal/internal/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify({
      accountId: job.account_id,
      tenantId: job.tenant_id,
      blobId,
      envelope: { mailFrom: f.selfAddress, rcptTo: [f.to] },
    }),
  });
  if (!res.ok) throw new Error(`forward relay failed (${res.status}): ${await res.text()}`);

  const sentId = await store.ensureRoleMailbox(job.account_id, "sent", "Sent");
  const emailId = `e_${crypto.randomUUID()}`;
  await store.insertEmail(job.account_id, {
    id: emailId,
    blobId,
    threadId: `t_${crypto.randomUUID()}`,
    messageId,
    inReplyTo: null,
    subject,
    from: [{ name: job.binding_name, email: f.selfAddress }],
    to: [{ email: f.to }],
    cc: [],
    bcc: [],
    preview: text.slice(0, 256),
    size: raw.byteLength,
    receivedAt: now,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [sentId],
    keywords: ["$seen", "$agent"],
  });
  await commitChanges(env.ACCOUNT_DO, job.account_id, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [sentId] },
  ]);
  return emailId;
}

// ---- CSV bootstrap -----------------------------------------------------

async function bootstrapCsv(
  env: Env,
  store: Mailstore,
  job: { id: string; account_id: string; binding_name: string; tenant_id: string },
  cfg: BindingConfig,
  email: EmailRow,
  selfAddress: string,
  digestTo: string,
  finish: (status: "done" | "failed", result: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const att = email.attachments.find(
    (a) => a.type.includes("csv") || (a.name ?? "").toLowerCase().endsWith(".csv"),
  );
  if (!att) {
    const fwdId = await forwardOriginal(env, store, job, {
      selfAddress,
      to: digestTo,
      note: "Bootstrap requested but I found no CSV attachment — expected columns: vendor,amount,currency,date[,category].",
      email,
      parsed: { text: email.preview },
    });
    return finish("done", { note: "bootstrap: no CSV attachment", forwardedEmailId: fwdId });
  }

  const blob = await store.getBlob(job.tenant_id, job.account_id, att.blobId);
  if (!blob) return finish("failed", { note: "bootstrap: attachment blob missing" });
  const csv = await blob.text();

  const categories = cfg.categories ?? DEFAULT_CATEGORIES;
  let imported = 0;
  let skipped = 0;
  const bad: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^vendor\s*,/i.test(t)) continue; // blank or header row
    const [vendor = "", amount = "", currency = "USD", date = "", category = "other"] = t
      .split(",")
      .map((s) => s.trim());
    const cents = Math.round(Number(amount) * 100);
    if (!vendor || !Number.isFinite(cents) || cents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      bad.push(t.slice(0, 60));
      continue;
    }
    const ok = await insertFact(env, job.account_id, email.id, {
      vendor: vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      amountCents: cents,
      currency: currency.toUpperCase().slice(0, 3),
      txnDate: date,
      category: categories.includes(category) ? category : "other",
      confidence: 1,
    });
    ok ? imported++ : skipped++;
  }

  const agg = await aggregates(env, job.account_id, {
    vendor: "-",
    amountCents: 0,
    currency: "USD",
    txnDate: new Date().toISOString().slice(0, 10),
    category: "other",
    confidence: 1,
  });
  const digestEmailId = await sendDigest(env, store, job, {
    selfAddress,
    to: digestTo,
    subject: `📥 bootstrap: ${imported} facts imported${skipped ? `, ${skipped} duplicates` : ""}`,
    fact: null,
    agg,
    commentary: "",
    chartMinPoints: cfg.chartMinPoints ?? 10,
    extraText: `Imported ${imported} facts${skipped ? `, skipped ${skipped} duplicates` : ""}${bad.length ? `, ${bad.length} unparseable rows (first: "${bad[0]}")` : ""}.`,
  });
  return finish("done", { imported, skipped, bad: bad.length, digestEmailId });
}
