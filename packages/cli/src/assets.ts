import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { AttachmentPart, InlinePart } from "./mime.js";

/**
 * Resolve local file references in rendered markdown HTML, three ways by
 * size and kind:
 *
 *   local <img>  under linkMax  → CID inline part (multipart/related);
 *                                 data: URLs are NOT used — Gmail/Outlook
 *                                 strip them; cid: is the email-native way
 *   local <a>    under linkMax  → real attachment, link text annotated
 *   anything     over  linkMax  → uploaded blob shared via an expiring
 *                                 signed URL; the reference is rewritten
 *                                 to that URL (in the text part too)
 *
 * Remote (http/https/mailto/#/cid/data) references pass through untouched.
 */

export interface ShareFn {
  (file: { name: string; type: string; content: Uint8Array }): Promise<string>;
}

export interface ProcessedAssets {
  html: string;
  text: string;
  inline: InlinePart[];
  attachments: AttachmentPart[];
  linked: Array<{ name: string; url: string }>;
  warnings: string[];
}

export async function processAssets(
  markdown: string,
  html: string,
  baseDir: string,
  opts: { linkMaxBytes: number; share: ShareFn },
): Promise<ProcessedAssets> {
  const out: ProcessedAssets = {
    html,
    text: markdown,
    inline: [],
    attachments: [],
    linked: [],
    warnings: [],
  };
  const seenAttachments = new Map<string, string>(); // resolved path → marker

  // ---- images --------------------------------------------------------
  for (const match of [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)]) {
    const src = match[1] as string;
    if (!isLocalRef(src)) continue;
    const file = loadLocal(src, baseDir, out.warnings);
    if (!file) continue;

    if (file.content.byteLength <= opts.linkMaxBytes) {
      const cid = `${out.inline.length}.${crypto.randomUUID()}@bullmoose`;
      out.inline.push({ cid, type: file.type, name: file.name, content: file.content });
      out.html = out.html.replaceAll(`src="${src}"`, `src="cid:${cid}"`);
    } else {
      const url = await opts.share(file);
      out.linked.push({ name: file.name, url });
      out.html = out.html.replaceAll(`src="${src}"`, `src="${url}"`);
      out.text = out.text.replaceAll(src, url);
    }
  }

  // ---- links ---------------------------------------------------------
  for (const match of [...out.html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>(.*?)<\/a>/gis)]) {
    const [anchor, href, inner] = match as unknown as [string, string, string];
    if (!isLocalRef(href)) continue;
    const file = loadLocal(href, baseDir, out.warnings);
    if (!file) continue;

    if (file.content.byteLength <= opts.linkMaxBytes) {
      const key = resolve(baseDir, href);
      if (!seenAttachments.has(key)) {
        out.attachments.push({ type: file.type, name: file.name, content: file.content });
        seenAttachments.set(key, file.name);
      }
      // Email can't hyperlink to its own attachments — annotate instead.
      out.html = out.html.replaceAll(anchor, `${inner} <em>[attached: ${file.name}]</em>`);
    } else {
      const url = await opts.share(file);
      out.linked.push({ name: file.name, url });
      out.html = out.html.replaceAll(`href="${href}"`, `href="${url}"`);
      out.text = out.text.replaceAll(href, url);
    }
  }

  return out;
}

function isLocalRef(ref: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

function loadLocal(
  ref: string,
  baseDir: string,
  warnings: string[],
): { name: string; type: string; content: Uint8Array } | null {
  const path = isAbsolute(ref) ? ref : resolve(baseDir, decodeURI(ref));
  if (!existsSync(path) || !statSync(path).isFile()) {
    warnings.push(`local reference not found, left as-is: ${ref}`);
    return null;
  }
  return { name: basename(path), type: mimeType(path), content: readFileSync(path) };
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

function mimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
