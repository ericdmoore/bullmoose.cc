import { createHash } from "node:crypto";

/**
 * vCard (RFC 6350, plus 3.0/2.1 compat) → JSContact Card (RFC 9553),
 * following the RFC 9555 property mapping. This is the CLI side of
 * `bullmoose contacts import` — the server only ever stores JSContact.
 * Phase 2 (anglebrackets CardDAV) lifts this into a shared package and
 * adds the serialize direction.
 *
 * Losslessness: properties without a JSContact mapping are preserved in
 * the RFC 9555 `vCardProps` extension property (jCard-shaped entries),
 * so nothing from the source .vcf is dropped.
 */

/** JSContact Card — the CLI treats it as an open object. */
export type Card = Record<string, unknown>;

export interface ParsedVcf {
  cards: Card[];
  warnings: string[];
}

interface VProp {
  group: string | null;
  name: string; // uppercased
  params: Record<string, string[]>; // param names lowercased
  value: string; // raw value (unfolded, QP-decoded), still vCard-escaped
}

// ---- content-line lexing ---------------------------------------------

/** Unfold RFC 6350 physical lines into logical lines. */
function unfold(text: string): string[] {
  const raw = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

/** Split on a delimiter, honouring backslash escapes. */
function splitUnescaped(value: string, delim: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
    } else if (ch === delim) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Split a param value list on commas outside quotes, strip quotes, then
 * split again inside formerly-quoted values — producers disagree on
 * whether TYPE="voice,work" is one value or a quoted list, and for the
 * enum-shaped params we consume, treating it as a list is always right.
 */
function paramValues(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.flatMap((v) => v.split(",")).filter((v) => v.length > 0);
}

/** Undo vCard TEXT escaping (RFC 6350 §3.4). */
function unescapeText(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}

function parseLine(line: string): VProp | null {
  // [group.]NAME[;params]:value — find the first ":" outside quotes.
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const segments: string[] = [];
  let cur = "";
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ";" && !inQuotes) {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segments.push(cur);

  let nameSeg = segments[0] ?? "";
  let group: string | null = null;
  const dot = nameSeg.indexOf(".");
  if (dot > 0) {
    group = nameSeg.slice(0, dot);
    nameSeg = nameSeg.slice(dot + 1);
  }

  const params: Record<string, string[]> = {};
  for (const seg of segments.slice(1)) {
    if (!seg) continue;
    const eq = seg.indexOf("=");
    // v2.1 bare params ("HOME", "CELL", "QUOTED-PRINTABLE") are TYPEs/encodings.
    const pname = (eq === -1 ? "type" : seg.slice(0, eq)).toLowerCase();
    const pvalRaw = eq === -1 ? seg : seg.slice(eq + 1);
    (params[pname] ??= []).push(...paramValues(pvalRaw));
  }

  return { group, name: nameSeg.trim().toUpperCase(), params, value };
}

function decodeQP(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "=" && i + 2 < value.length + 1) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(...Buffer.from(ch, "utf-8"));
  }
  return Buffer.from(bytes).toString("utf-8");
}

/** Split unfolded lines into vCard blocks of parsed properties. */
function parseBlocks(text: string): { blocks: VProp[][]; warnings: string[] } {
  const lines = unfold(text);
  const blocks: VProp[][] = [];
  const warnings: string[] = [];
  let current: VProp[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prop = parseLine(line);
    if (!prop) {
      if (line.trim()) warnings.push(`unparseable line skipped: ${line.slice(0, 60)}`);
      continue;
    }
    if (prop.name === "BEGIN" && prop.value.trim().toUpperCase() === "VCARD") {
      if (current) warnings.push("nested BEGIN:VCARD — starting a new card");
      current = [];
      continue;
    }
    if (prop.name === "END" && prop.value.trim().toUpperCase() === "VCARD") {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    // v2.1 quoted-printable: a trailing "=" continues on the next line.
    if ((prop.params.encoding ?? []).some((e) => e.toUpperCase() === "QUOTED-PRINTABLE")) {
      while (prop.value.endsWith("=") && i + 1 < lines.length) {
        prop.value = prop.value.slice(0, -1) + lines[++i]!;
      }
      prop.value = decodeQP(prop.value);
    }
    current.push(prop);
  }
  if (current) warnings.push("unterminated vCard (missing END:VCARD)");
  return { blocks, warnings };
}

// ---- vCard → JSContact -----------------------------------------------

const TEL_FEATURES: Record<string, string> = {
  cell: "mobile",
  voice: "voice",
  fax: "fax",
  pager: "pager",
  text: "text",
  video: "video",
  textphone: "textphone",
};

function contexts(prop: VProp): Record<string, true> | undefined {
  const out: Record<string, true> = {};
  for (const t of (prop.params.type ?? []).map((t) => t.toLowerCase())) {
    if (t === "home") out.private = true;
    if (t === "work") out.work = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function prefOf(prop: VProp): number | undefined {
  const p = prop.params.pref?.[0];
  if (p !== undefined) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  }
  // v3 style: TYPE=pref
  if ((prop.params.type ?? []).some((t) => t.toLowerCase() === "pref")) return 1;
  return undefined;
}

/** Apple's "_$!<Home>!$_" X-ABLabel wrapper → plain text. */
function cleanLabel(raw: string): string {
  const m = raw.match(/^_\$!<(.+)>!\$_$/);
  return m ? m[1]! : raw;
}

/** vCard DATE-AND-OR-TIME → JSContact PartialDate or Timestamp. */
function anniversaryDate(value: string): Record<string, unknown> | null {
  const v = value.trim();
  // Timestamp forms contain a time part.
  if (v.includes("T")) {
    const iso = isoTimestamp(v);
    return iso ? { "@type": "Timestamp", utc: iso } : null;
  }
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  m = v.match(/^--(\d{2})-?(\d{2})$/);
  if (m) return { month: Number(m[1]), day: Number(m[2]) };
  m = v.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (m) return { year: Number(m[1]), ...(m[2] ? { month: Number(m[2]) } : {}) };
  return null;
}

/** vCard timestamp (basic or extended format) → RFC 3339 UTC, or null. */
function isoTimestamp(v: string): string | null {
  const compact = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}${compact[7] ?? "Z"}`
    : v;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const N_COMPONENT_KINDS = ["surname", "given", "given2", "title", "credential"] as const;
const ADR_COMPONENT_KINDS = [
  "postOfficeBox",
  "apartment",
  "name",
  "locality",
  "region",
  "postcode",
  "country",
] as const;

/** Properties that map structurally (everything else → vCardProps). */
const MAPPED = new Set([
  "VERSION",
  "UID",
  "FN",
  "N",
  "NICKNAME",
  "ORG",
  "TITLE",
  "ROLE",
  "EMAIL",
  "TEL",
  "ADR",
  "BDAY",
  "ANNIVERSARY",
  "NOTE",
  "URL",
  "PHOTO",
  "CATEGORIES",
  "IMPP",
  "KIND",
  "REV",
  "PRODID",
  "X-ABLABEL",
  "X-ABSHOWAS",
]);

function cardFromBlock(props: VProp[], warnings: string[]): Card {
  const card: Card = { "@type": "Card", version: "1.0" };
  const vCardProps: unknown[] = [];

  // Apple item groups: itemN.X-ABLabel names its sibling properties.
  const groupLabels = new Map<string, string>();
  for (const p of props) {
    if (p.name === "X-ABLABEL" && p.group) {
      groupLabels.set(p.group, cleanLabel(unescapeText(p.value)));
    }
  }
  const labelOf = (p: VProp): string | undefined =>
    p.group ? groupLabels.get(p.group) : undefined;

  const emails: Record<string, unknown> = {};
  const phones: Record<string, unknown> = {};
  const addresses: Record<string, unknown> = {};
  const nicknames: Record<string, unknown> = {};
  const organizations: Record<string, unknown> = {};
  const titles: Record<string, unknown> = {};
  const notes: Record<string, unknown> = {};
  const links: Record<string, unknown> = {};
  const media: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const anniversaries: Record<string, unknown> = {};
  const keywords: Record<string, true> = {};
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;

  for (const p of props) {
    switch (p.name) {
      case "VERSION":
      case "X-ABLABEL":
        break;
      case "UID":
        card.uid = unescapeText(p.value.trim());
        break;
      case "FN": {
        const name = (card.name ??= {}) as Record<string, unknown>;
        if (name.full === undefined) name.full = unescapeText(p.value).trim();
        break;
      }
      case "N": {
        const parts = splitUnescaped(p.value, ";");
        const components: Array<{ kind: string; value: string }> = [];
        N_COMPONENT_KINDS.forEach((kind, idx) => {
          for (const v of splitUnescaped(parts[idx] ?? "", ",")) {
            const value = unescapeText(v).trim();
            if (value) components.push({ kind, value });
          }
        });
        if (components.length > 0) {
          const name = (card.name ??= {}) as Record<string, unknown>;
          name.components = components;
        }
        break;
      }
      case "NICKNAME":
        for (const v of splitUnescaped(p.value, ",")) {
          const value = unescapeText(v).trim();
          if (value) nicknames[nextId("nick")] = { name: value };
        }
        break;
      case "ORG": {
        const parts = splitUnescaped(p.value, ";").map((v) => unescapeText(v).trim());
        const [orgName, ...units] = parts;
        organizations[nextId("org")] = {
          ...(orgName ? { name: orgName } : {}),
          ...(units.filter(Boolean).length > 0
            ? { units: units.filter(Boolean).map((u) => ({ name: u })) }
            : {}),
        };
        break;
      }
      case "TITLE":
      case "ROLE":
        titles[nextId("title")] = {
          kind: p.name === "TITLE" ? "title" : "role",
          name: unescapeText(p.value).trim(),
        };
        break;
      case "EMAIL":
        emails[nextId("email")] = {
          address: unescapeText(p.value).trim(),
          ...(contexts(p) ? { contexts: contexts(p) } : {}),
          ...(prefOf(p) !== undefined ? { pref: prefOf(p) } : {}),
          ...(labelOf(p) ? { label: labelOf(p) } : {}),
        };
        break;
      case "TEL": {
        const features: Record<string, true> = {};
        for (const t of (p.params.type ?? []).map((t) => t.toLowerCase())) {
          const f = TEL_FEATURES[t];
          if (f) features[f] = true;
        }
        phones[nextId("phone")] = {
          number: unescapeText(p.value).trim(),
          ...(Object.keys(features).length > 0 ? { features } : {}),
          ...(contexts(p) ? { contexts: contexts(p) } : {}),
          ...(prefOf(p) !== undefined ? { pref: prefOf(p) } : {}),
          ...(labelOf(p) ? { label: labelOf(p) } : {}),
        };
        break;
      }
      case "ADR": {
        const parts = splitUnescaped(p.value, ";");
        const components: Array<{ kind: string; value: string }> = [];
        ADR_COMPONENT_KINDS.forEach((kind, idx) => {
          for (const v of splitUnescaped(parts[idx] ?? "", ",")) {
            const value = unescapeText(v).trim();
            if (value) components.push({ kind, value });
          }
        });
        if (components.length === 0) break;
        const label = p.params.label?.[0];
        addresses[nextId("addr")] = {
          components,
          ...(contexts(p) ? { contexts: contexts(p) } : {}),
          ...(label ? { full: unescapeText(label) } : {}),
          ...(prefOf(p) !== undefined ? { pref: prefOf(p) } : {}),
        };
        break;
      }
      case "BDAY":
      case "ANNIVERSARY": {
        const date = anniversaryDate(p.value);
        if (date) {
          anniversaries[nextId("ann")] = {
            kind: p.name === "BDAY" ? "birth" : "wedding",
            date,
          };
        } else {
          vCardProps.push(jcard(p));
        }
        break;
      }
      case "NOTE": {
        const note = unescapeText(p.value).trim();
        if (note) notes[nextId("note")] = { note };
        break;
      }
      case "URL":
        links[nextId("link")] = {
          uri: unescapeText(p.value).trim(),
          ...(labelOf(p) ? { label: labelOf(p) } : {}),
        };
        break;
      case "PHOTO": {
        const uri = photoUri(p);
        if (uri) media[nextId("photo")] = { kind: "photo", uri };
        else vCardProps.push(jcard(p));
        break;
      }
      case "CATEGORIES":
        for (const v of splitUnescaped(p.value, ",")) {
          const kw = unescapeText(v).trim();
          if (kw) keywords[kw] = true;
        }
        break;
      case "IMPP":
        services[nextId("svc")] = {
          uri: unescapeText(p.value).trim(),
          ...(labelOf(p) ? { label: labelOf(p) } : {}),
        };
        break;
      case "KIND": {
        const kind = p.value.trim().toLowerCase();
        if (["individual", "org", "group", "location", "device", "application"].includes(kind)) {
          card.kind = kind;
        }
        break;
      }
      case "X-ABSHOWAS":
        if (p.value.trim().toUpperCase() === "COMPANY") card.kind = "org";
        break;
      case "REV": {
        const iso = isoTimestamp(p.value.trim());
        if (iso) card.updated = iso;
        break;
      }
      case "PRODID":
        card.prodId = unescapeText(p.value).trim();
        break;
      default:
        vCardProps.push(jcard(p));
    }
  }

  if (Object.keys(emails).length > 0) card.emails = emails;
  if (Object.keys(phones).length > 0) card.phones = phones;
  if (Object.keys(addresses).length > 0) card.addresses = addresses;
  if (Object.keys(nicknames).length > 0) card.nicknames = nicknames;
  if (Object.keys(organizations).length > 0) card.organizations = organizations;
  if (Object.keys(titles).length > 0) card.titles = titles;
  if (Object.keys(notes).length > 0) card.notes = notes;
  if (Object.keys(links).length > 0) card.links = links;
  if (Object.keys(media).length > 0) card.media = media;
  if (Object.keys(services).length > 0) card.onlineServices = services;
  if (Object.keys(anniversaries).length > 0) card.anniversaries = anniversaries;
  if (Object.keys(keywords).length > 0) card.keywords = keywords;
  if (vCardProps.length > 0) card.vCardProps = vCardProps;

  // No UID: derive a deterministic one from identifying content so
  // re-importing the same file is idempotent (dedup keys on uid).
  if (typeof card.uid !== "string" || card.uid.length === 0) {
    card.uid = deterministicUid(card);
  }
  if (!card.name && !card.organizations) {
    warnings.push(`card ${String(card.uid)} has no name or organization`);
  }
  return card;
}

/** PHOTO → data: URI (inline base64) or the literal URI. */
function photoUri(p: VProp): string | null {
  const enc = (p.params.encoding ?? []).map((e) => e.toUpperCase());
  const value = p.value.trim();
  if (enc.includes("B") || enc.includes("BASE64")) {
    const subtype = (p.params.type?.[0] ?? "jpeg").toLowerCase().replace("image/", "");
    return `data:image/${subtype};base64,${value.replaceAll(/\s/g, "")}`;
  }
  if (/^(data|https?):/i.test(value)) return value;
  return null;
}

/** jCard-shaped lossless fallback (RFC 9555 vCardProps). */
function jcard(p: VProp): unknown[] {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.params)) params[k] = v.length === 1 ? v[0] : v;
  if (p.group) params.group = p.group;
  return [p.name.toLowerCase(), params, "unknown", p.value];
}

function deterministicUid(card: Card): string {
  const name = card.name as { full?: string; components?: Array<{ value?: string }> } | undefined;
  const key = [
    name?.full ?? "",
    ...(name?.components?.map((c) => c.value ?? "") ?? []),
    ...Object.values((card.emails as Record<string, { address?: string }>) ?? {}).map(
      (e) => e.address ?? "",
    ),
    ...Object.values((card.phones as Record<string, { number?: string }>) ?? {}).map(
      (e) => e.number ?? "",
    ),
    ...Object.values((card.organizations as Record<string, { name?: string }>) ?? {}).map(
      (o) => o.name ?? "",
    ),
  ].join("|");
  return `urn:bullmoose:vcf:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/** Parse a .vcf file (any number of cards) into JSContact Cards. */
export function parseVcf(text: string): ParsedVcf {
  const { blocks, warnings } = parseBlocks(text);
  const cards = blocks.map((b) => cardFromBlock(b, warnings));
  return { cards, warnings };
}
