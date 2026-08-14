// Sizes, types and times, rendered.
//
// Small functions, but they are here rather than inline in the island for the
// reason this whole folder exists: vitest runs in plain Node with no jsdom
// (`vitest.config.ts`), so a rule that lives in a `.tsx` is a rule with no
// test. "1.5 MB" vs "1.5 MiB" is exactly the kind of thing that is wrong for a
// year because nobody could assert it.
//
// The unit choice: **decimal (kB/MB/GB), not binary.** The sidestep threshold
// is written in MiB (`DEFAULT_SIDESTEP_MIN_BYTES = 5 * 1024 * 1024`) but every
// other surface a person compares against — macOS Finder, the size their mail
// provider quotes, the number on a download page — is decimal, and a browser
// that reports 4.8 MB for a file Finder calls 5 MB reads as a bug in the
// browser. One convention, stated, beats two that are each right somewhere.

/** `size` is nullable on the wire (directories have none). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // One decimal below 10, none above: "9.4 MB" then "94 MB". Trailing ".0" is
  // noise, so 5.0 renders as "5 MB".
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/**
 * A short label for an IANA media type.
 *
 * Deliberately shallow: it names the handful of families a person recognises
 * and otherwise shows the subtype verbatim. It never GUESSES from the
 * extension — the server stores what was uploaded, and inventing a type the
 * server does not hold would make the detail pane disagree with the download.
 */
export function formatType(type: string | null | undefined, nodeType?: string): string {
  if (nodeType === "directory") return "Folder";
  if (!type) return "Unknown type";
  const clean = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const known: Record<string, string> = {
    "application/pdf": "PDF",
    "application/zip": "ZIP archive",
    "application/x-zip-compressed": "ZIP archive",
    "application/json": "JSON",
    "application/octet-stream": "Binary file",
    "text/plain": "Text",
    "text/csv": "CSV",
    "text/html": "HTML",
  };
  if (known[clean]) return known[clean];
  const [family, subtype] = clean.split("/");
  if (!subtype) return clean || "Unknown type";
  if (family === "image") return `${subtype.toUpperCase()} image`;
  if (family === "video") return `${subtype.toUpperCase()} video`;
  if (family === "audio") return `${subtype.toUpperCase()} audio`;
  if (family === "text") return `${subtype.toUpperCase()} text`;
  return subtype.toUpperCase();
}

/**
 * An ISO timestamp as a short local string. Every FileNode date property
 * (`created`/`modified`/`accessed`/`changed`) is ISO 8601 from
 * `iso()` (filenode.ts:470), so a bad value means a bug worth SEEING rather
 * than a dash — hence the raw string is returned rather than swallowed.
 */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 items" / "1 item" / "Empty" — a folder's own summary line. */
export function describeCount(n: number): string {
  if (n === 0) return "Empty";
  return n === 1 ? "1 item" : `${n} items`;
}
