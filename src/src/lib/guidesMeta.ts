// Web-facing metadata for each playbook (keyed by its file slug). The
// playbooks themselves stay frontmatter-free so GitHub renders them plainly.
export type GuideMeta = { title: string; tag: string; blurb: string; order: number };

export const GUIDES: Record<string, GuideMeta> = {
  "apple-mail-and-calendar": {
    title: "Apple Mail + Calendar",
    tag: "macOS · iOS",
    blurb: "Mail via the POP3/SMTP shim, Calendar & Contacts via public CalDAV/CardDAV.",
    order: 1,
  },
  "jmap-client": {
    title: "A JMAP client (Mailtemi)",
    tag: "iOS · Android · desktop",
    blurb: "Full-fidelity mail — folders, threads, push — in a modern JMAP client, or the CLI.",
    order: 2,
  },
  "family-sharing": {
    title: "Family sharing",
    tag: "household",
    blurb: "A second account, a shared address book, and per-device revocable app-passwords.",
    order: 3,
  },
};

export const guideMeta = (id: string): GuideMeta =>
  GUIDES[id] ?? { title: id, tag: "connection guide", blurb: "", order: 99 };
