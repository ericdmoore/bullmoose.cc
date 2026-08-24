// s33 slice 1 — stop throwing away the positive.
//
// stage2EnvelopeAuth has always been correct as a REJECT gate: topmost
// Authentication-Results only (RFC 8601 §1.6 — our edge prepends, so a
// forged header can only sit below and is never consulted), reject on an
// explicit dmarc=fail. But on a pass it recorded NOTHING — the aligned
// mechanism, the signing domain and the verdict itself were discarded into
// the raw blob, unrecoverable without a re-parse.
//
// This file extracts the structured fact the ladder's tier 1 stands on:
//
//   { "dmarc": "pass", "aligned": "dkim", "d": "company.com", "at": … }
//
// House rule, stated in the plan and enforced by the shape: ABSENT MEANS
// "NOT KNOWN", NOT "NOT AUTHENTIC" — exactly as a NULL cost means "not
// recorded" rather than "free". A message with no Authentication-Results
// header, or a dmarc verdict other than pass, stores nothing.
//
// `aligned` records WHICH mechanism aligned, because the plan is explicit
// that collapsing it to a boolean throws away a material distinction: DKIM
// alignment is a cryptographic claim over the message; SPF authenticates
// only the envelope and breaks under forwarding. When the header carries a
// dmarc=pass but not enough detail to attribute alignment, `aligned` is
// "unknown" — a weaker fact stated as one, never upgraded by guesswork.

/** The stored shape. `at` is when WE evaluated it, not a header claim. */
export interface EmailAssurance {
  dmarc: "pass";
  aligned: "dkim" | "spf" | "unknown";
  /** The aligned domain: DKIM's d= when DKIM aligned, else the mail-from
   *  domain SPF authenticated, else the From: domain the verdict covered. */
  d: string;
  at: number;
}

interface HeaderLike {
  key: string;
  value: string;
}

/**
 * Relaxed alignment, approximated: exact match, or one domain is a
 * parent/child of the other at a label boundary. True RFC 7489 relaxed
 * alignment compares "organizational domains" via the Public Suffix List;
 * shipping the PSL to answer a question the upstream verifier has already
 * answered (dmarc=pass IS the alignment verdict) would be weight without
 * information — this approximation only decides which mechanism to
 * ATTRIBUTE, never whether the message passed.
 */
export function domainsAligned(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, "");
  const y = b.toLowerCase().replace(/\.$/, "");
  if (!x || !y) return false;
  return x === y || x.endsWith("." + y) || y.endsWith("." + x);
}

/** Every `<method>=<verdict> …properties` clause of one AR header value. */
function clauses(value: string): Array<{ method: string; verdict: string; props: string }> {
  const out: Array<{ method: string; verdict: string; props: string }> = [];
  // Clauses are `;`-separated; the first segment is the authserv-id.
  for (const part of value.split(";").slice(1)) {
    const m = part.trim().match(/^([a-z0-9_-]+)\s*=\s*([a-z0-9]+)\b(.*)$/i);
    if (m) out.push({ method: m[1]!.toLowerCase(), verdict: m[2]!.toLowerCase(), props: m[3] ?? "" });
  }
  return out;
}

function prop(props: string, name: string): string | null {
  const m = props.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s;()]+)`, "i"));
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The structured fact, or null when there is nothing safe to assert.
 *
 * Reads ONLY the topmost authentication-results header, the same trust
 * model as stage 2 — and deliberately shares its failure surface: if the
 * edge did not evaluate, we know nothing and store nothing.
 */
export function parseAssurance(headers: HeaderLike[], fromDomain: string, at: number): EmailAssurance | null {
  const topmost = headers.find((h) => h.key === "authentication-results");
  if (!topmost) return null;
  const all = clauses(topmost.value);
  const dmarc = all.find((c) => c.method === "dmarc");
  if (!dmarc || dmarc.verdict !== "pass") return null;

  const from = (prop(dmarc.props, "header.from") ?? fromDomain).toLowerCase();

  // DKIM first — the stronger fact wins the attribution when both align.
  for (const c of all) {
    if (c.method !== "dkim" || c.verdict !== "pass") continue;
    const d = prop(c.props, "header.d");
    if (d && domainsAligned(d, from)) return { dmarc: "pass", aligned: "dkim", d, at };
  }
  for (const c of all) {
    if (c.method !== "spf" || c.verdict !== "pass") continue;
    const mailfrom = prop(c.props, "smtp.mailfrom");
    const d = mailfrom ? (mailfrom.split("@").pop() ?? "") : "";
    if (d && domainsAligned(d, from)) return { dmarc: "pass", aligned: "spf", d, at };
  }
  // The verdict is pass (the upstream verifier established alignment) but
  // the header does not say via which mechanism. State the weaker fact.
  return { dmarc: "pass", aligned: "unknown", d: from, at };
}
