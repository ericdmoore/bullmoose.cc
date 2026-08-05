/**
 * contacts-core — vCard (RFC 6350 + 3.0/2.1 compat) ⇄ JSContact
 * (RFC 9553) translation per the RFC 9555 mapping, WebCrypto/worker-safe
 * (no Node Buffer). The parse direction is the proven CLI importer
 * (packages/cli/src/vcard.ts drove the 4,120-card production import —
 * the CLI keeps its Node copy until it grows a dependency build step);
 * the serialize direction is new for Phase 2: anglebrackets CardDAV
 * serves vCard 3.0 (what Apple Contacts speaks) from card_json.
 *
 * Losslessness: unmapped properties ride in the RFC 9555 `vCardProps`
 * extension (jCard-shaped) and are re-emitted verbatim on serialize.
 */

/** JSContact Card — treated as an open object. */
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

function unescapeText(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}

/** vCard TEXT escaping (RFC 6350 §3.4 / 2426 §5). */
function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

/** Escaping for one component of a structured value (N/ADR/ORG). */
function escapeComponent(value: string): string {
  return escapeText(value);
}

/** Split a param value list on commas outside quotes, then inside
 * formerly-quoted values (producers disagree; list-reading is safe for
 * the enum params we consume). */
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

function parseLine(line: string): VProp | null {
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
  const enc = new TextEncoder();
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
    bytes.push(...enc.encode(ch));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

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
  if ((prop.params.type ?? []).some((t) => t.toLowerCase() === "pref")) return 1;
  return undefined;
}

function cleanLabel(raw: string): string {
  const m = raw.match(/^_\$!<(.+)>!\$_$/);
  return m ? m[1]! : raw;
}

function anniversaryDate(value: string): Record<string, unknown> | null {
  const v = value.trim();
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

function cardFromBlock(props: VProp[], warnings: string[]): Card {
  const card: Card = { "@type": "Card", version: "1.0" };
  const vCardProps: unknown[] = [];

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

  // DAV PUTs virtually always carry UID; if not, mint one (the CLI
  // import uses a content-derived urn instead — different tradeoff).
  if (typeof card.uid !== "string" || card.uid.length === 0) {
    card.uid = `urn:uuid:${crypto.randomUUID()}`;
  }
  if (!card.name && !card.organizations) {
    warnings.push(`card ${String(card.uid)} has no name or organization`);
  }
  return card;
}

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

function jcard(p: VProp): unknown[] {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.params)) params[k] = v.length === 1 ? v[0] : v;
  if (p.group) params.group = p.group;
  return [p.name.toLowerCase(), params, "unknown", p.value];
}

/** Parse a .vcf payload (any number of cards) into JSContact Cards. */
export function parseVcf(text: string): ParsedVcf {
  const { blocks, warnings } = parseBlocks(text);
  const cards = blocks.map((b) => cardFromBlock(b, warnings));
  return { cards, warnings };
}

// ---- JSContact → vCard 3.0 ---------------------------------------------
//
// 3.0 because that's what Apple Contacts requests and emits. Types map
// back per RFC 9555; labels round-trip through Apple item groups.

interface Line {
  group?: string;
  name: string;
  params?: string[]; // preformatted "TYPE=HOME" segments
  value: string; // already escaped as appropriate for the property
}

export function serializeVcard(card: Card): string {
  const lines: Line[] = [];
  let item = 0;
  const push = (l: Line) => lines.push(l);
  const withLabel = (label: string | undefined, l: Line): void => {
    if (!label) {
      push(l);
      return;
    }
    const group = `item${++item}`;
    push({ ...l, group });
    push({ group, name: "X-ABLABEL", value: escapeText(label) });
  };

  const name = card.name as
    | { full?: string; components?: Array<{ kind?: string; value?: string }> }
    | undefined;

  // FN is mandatory in 3.0.
  const fn =
    name?.full ??
    name?.components
      ?.filter((c) => c.kind !== "separator" && c.value)
      .map((c) => c.value)
      .join(" ")
      .trim() ??
    firstValue(card.organizations, "name") ??
    firstValue(card.emails, "address") ??
    "Unnamed";
  push({ name: "FN", value: escapeText(String(fn)) });

  if (name?.components && name.components.length > 0) {
    const slots: Record<(typeof N_COMPONENT_KINDS)[number], string[]> = {
      surname: [],
      given: [],
      given2: [],
      title: [],
      credential: [],
    };
    for (const c of name.components) {
      const kind = c.kind as keyof typeof slots;
      if (kind in slots && typeof c.value === "string") slots[kind].push(c.value);
    }
    push({
      name: "N",
      value: N_COMPONENT_KINDS.map((k) => slots[k].map(escapeComponent).join(",")).join(";"),
    });
  }

  for (const org of values(card.organizations)) {
    const units = Array.isArray(org.units)
      ? (org.units as Array<{ name?: string }>).map((u) => u.name ?? "")
      : [];
    push({
      name: "ORG",
      value: [org.name ?? "", ...units].map((v) => escapeComponent(String(v))).join(";"),
    });
  }
  for (const t of values(card.titles)) {
    push({
      name: t.kind === "role" ? "ROLE" : "TITLE",
      value: escapeText(String(t.name ?? "")),
    });
  }
  const nicknames = values(card.nicknames)
    .map((n) => n.name)
    .filter(Boolean);
  if (nicknames.length > 0) {
    push({ name: "NICKNAME", value: nicknames.map((n) => escapeText(String(n))).join(",") });
  }

  for (const e of values(card.emails)) {
    withLabel(e.label as string | undefined, {
      name: "EMAIL",
      params: ["TYPE=INTERNET", ...typeParams(e)],
      value: escapeText(String(e.address ?? "")),
    });
  }

  const FEATURE_TYPES: Record<string, string> = {
    mobile: "CELL",
    voice: "VOICE",
    fax: "FAX",
    pager: "PAGER",
    video: "VIDEO",
    text: "TEXT",
    textphone: "TEXTPHONE",
  };
  for (const p of values(card.phones)) {
    const featureTypes = Object.keys((p.features as Record<string, boolean>) ?? {})
      .map((f) => FEATURE_TYPES[f])
      .filter((f): f is string => Boolean(f))
      .map((f) => `TYPE=${f}`);
    withLabel(p.label as string | undefined, {
      name: "TEL",
      params: [...featureTypes, ...typeParams(p)],
      value: escapeText(String(p.number ?? "")),
    });
  }

  for (const a of values(card.addresses)) {
    const comps = (a.components as Array<{ kind?: string; value?: string }>) ?? [];
    const slots: Record<(typeof ADR_COMPONENT_KINDS)[number], string[]> = {
      postOfficeBox: [],
      apartment: [],
      name: [],
      locality: [],
      region: [],
      postcode: [],
      country: [],
    };
    for (const c of comps) {
      const kind = c.kind as keyof typeof slots;
      if (kind in slots && typeof c.value === "string") slots[kind].push(c.value);
    }
    push({
      name: "ADR",
      params: typeParams(a),
      value: ADR_COMPONENT_KINDS.map((k) => slots[k].map(escapeComponent).join(",")).join(";"),
    });
  }

  for (const ann of values(card.anniversaries)) {
    const d = ann.date as
      | { year?: number; month?: number; day?: number; utc?: string }
      | undefined;
    if (!d) continue;
    let value: string | null = null;
    if (typeof d.utc === "string") value = d.utc.slice(0, 10);
    else if (d.year && d.month && d.day) {
      value = `${pad4(d.year)}-${pad2(d.month)}-${pad2(d.day)}`;
    } else if (d.month && d.day) {
      // Apple's yearless-date convention.
      value = `1604-${pad2(d.month)}-${pad2(d.day)}`;
    }
    if (!value) continue;
    const params = value.startsWith("1604-") ? ["X-APPLE-OMIT-YEAR=1604"] : undefined;
    if (ann.kind === "birth") push({ name: "BDAY", params, value });
    else if (ann.kind === "wedding") push({ name: "ANNIVERSARY", params, value });
  }

  for (const n of values(card.notes)) {
    if (n.note) push({ name: "NOTE", value: escapeText(String(n.note)) });
  }
  for (const l of values(card.links)) {
    if (l.uri) {
      withLabel(l.label as string | undefined, { name: "URL", value: String(l.uri) });
    }
  }
  for (const s of values(card.onlineServices)) {
    if (s.uri) {
      withLabel(s.label as string | undefined, { name: "IMPP", value: String(s.uri) });
    }
  }
  for (const m of values(card.media)) {
    if (m.kind !== "photo" || typeof m.uri !== "string") continue;
    const data = m.uri.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/is);
    if (data) {
      push({
        name: "PHOTO",
        params: ["ENCODING=b", `TYPE=${data[1]!.toUpperCase()}`],
        value: data[2]!.replaceAll(/\s/g, ""),
      });
    } else if (/^https?:/i.test(m.uri)) {
      push({ name: "PHOTO", params: ["VALUE=uri"], value: m.uri });
    }
  }

  const keywords = Object.keys((card.keywords as Record<string, boolean>) ?? {});
  if (keywords.length > 0) {
    push({ name: "CATEGORIES", value: keywords.map(escapeText).join(",") });
  }
  if (card.kind === "org") push({ name: "X-ABSHOWAS", value: "COMPANY" });
  if (typeof card.updated === "string") {
    const ms = Date.parse(card.updated);
    if (Number.isFinite(ms)) {
      push({ name: "REV", value: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") });
    }
  }

  // Lossless tail: re-emit preserved unmapped properties verbatim.
  for (const raw of (card.vCardProps as unknown[]) ?? []) {
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const [pname, pparams, , pvalue] = raw as [string, Record<string, unknown>, string, string];
    const { group, ...rest } = pparams ?? {};
    const params = Object.entries(rest).flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).map((x) => `${k.toUpperCase()}=${String(x)}`),
    );
    // Prefix preserved group names so they can't collide with the
    // itemN groups this serializer mints for labels (relative grouping
    // among preserved props survives the consistent rename).
    push({
      ...(typeof group === "string" ? { group: `p${group}` } : {}),
      name: pname.toUpperCase(),
      ...(params.length > 0 ? { params } : {}),
      value: String(pvalue),
    });
  }

  const out: string[] = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//bullmoose//anglebrackets//EN"];
  if (typeof card.uid === "string") out.push(fold(`UID:${escapeText(card.uid)}`));
  for (const l of lines) {
    const head = `${l.group ? `${l.group}.` : ""}${l.name}${l.params?.length ? ";" + l.params.join(";") : ""}`;
    out.push(fold(`${head}:${l.value}`));
  }
  out.push("END:VCARD");
  return out.join("\r\n") + "\r\n";
}

/** RFC 6350 §3.2 folding at 75 octets, never splitting a code point. */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let budget = 75;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > budget) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
      budget = 75;
    }
    cur += ch;
    curBytes += chBytes;
  }
  if (cur.length > 0) out.push(cur);
  return out.join("\r\n");
}

function values(map: unknown): Array<Record<string, unknown>> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.values(map as Record<string, unknown>).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object",
  );
}

function firstValue(map: unknown, key: string): string | undefined {
  for (const v of values(map)) {
    if (typeof v[key] === "string" && v[key]) return v[key] as string;
  }
  return undefined;
}

function typeParams(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ctx = (entry.contexts as Record<string, boolean>) ?? {};
  if (ctx.private) out.push("TYPE=HOME");
  if (ctx.work) out.push("TYPE=WORK");
  if (typeof entry.pref === "number" && entry.pref === 1) out.push("TYPE=pref");
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
