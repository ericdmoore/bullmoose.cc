import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUARANTINE_NAME, QUARANTINE_ROLE } from "./index";

/**
 * ONE mailbox, a REGISTERED role, an honest name — held in place by a scan.
 *
 * Wave 1 invented `role: 'quarantine'`. JMAP roles are an IANA registry (RFC
 * 8621 §2), and a role outside it is not "custom", it is INVISIBLE: Apple
 * Mail, himalaya and every other standards-native client render an unknown
 * role as an ordinary folder, with no spam handling and no "Mark as Junk"
 * integration. The cost was taken by accident and it is not the kind of thing
 * a reviewer catches twice, so it is asserted here instead:
 *
 *   · the role is `junk`, which IS in the registry;
 *   · the display name is `Quarantined` — a condition, not a room;
 *   · no source file anywhere resurrects the invented role.
 *
 * The scan is comment-stripped so the design notes ABOUT the old role (there
 * are several, and they should stay) do not trip it — only code does. Two
 * files are exempt by name, each for a stated reason; an exemption you have to
 * write down is one you have to justify.
 */

const ROOT = new URL("../../../", import.meta.url);

/** Source trees a mailbox role could plausibly be spelled in. */
const TREES = ["packages", "services", "webmail/src", "infra", "conformance", "tools"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".sql", ".astro", ".go"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", "coverage", ".git"]);

/**
 * Files allowed to name the retired role, and why:
 *
 *   infra/migrations.mjs   the DDL that REMOVES it has to name it — a
 *                          migration that cannot mention what it deletes is
 *                          not a migration.
 *   createAccount.test.ts  asserts provisioning creates ZERO of them; the
 *                          literal is inside the assertion that it is gone.
 */
const EXEMPT = ["infra/migrations.mjs", "services/provision/src/createAccount.test.ts"];

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(fileURLToPath(new URL(dir, ROOT)), { withFileTypes: true });
  } catch {
    return out; // a tree that does not exist on this checkout
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".astro") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (EXTENSIONS.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

/** Strip comments — the scan tests CODE, not the prose explaining the change. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");
}

const FILES = TREES.flatMap((t) => walk(t)).filter((f) => !EXEMPT.some((e) => f.endsWith(e)));

describe("the held mailbox is the registered role, under our name", () => {
  it("is `junk` (IANA-registered) displayed `Quarantined`", () => {
    // The registry, verbatim (RFC 8621 §2 / IANA JMAP mailbox roles). Being IN
    // this list is the whole property: it is what makes a client's spam
    // handling apply to the mail we hold.
    const IANA_ROLES = [
      "inbox",
      "archive",
      "drafts",
      "junk",
      "sent",
      "trash",
      "flagged",
      "important",
    ];
    expect(IANA_ROLES).toContain(QUARANTINE_ROLE);
    expect(QUARANTINE_ROLE).toBe("junk");
    // The past participle is load-bearing: "Quarantine" is a room you are
    // expected to visit, "Quarantined" is a state the mail is in.
    expect(QUARANTINE_NAME).toBe("Quarantined");
    expect(QUARANTINE_NAME).not.toBe("Junk");
  });

  it("scans a tree that is actually populated", () => {
    // Guard against the whole file passing vacuously because a rename emptied
    // the walk.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain("services/ingest/src/index.ts");
    expect(FILES).toContain("services/agent/src/bouncerClassify.ts");
    expect(FILES).toContain("packages/mailstore/sql/data-plane.sql");
  });

  it("no source file resurrects the invented mailbox role", () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const src = code(readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8"));
      // Any QUOTED occurrence of the bare word: a role literal in SQL
      // (`role = 'quarantine'`), in an object (`role: "quarantine"`), or in an
      // ensureRoleMailbox call. The DMARC policy string `p=quarantine` is not
      // quoted on its own and does not match, which is the intent — that word
      // is a different protocol's vocabulary.
      for (const m of src.matchAll(/['"`]quarantine['"`]/gi)) {
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the chain table KEEPS its name — it is the chain, not the folder", () => {
    // The counterweight to the test above: `quarantine_events` must NOT be
    // renamed along with the mailbox. It records decisions about messages, and
    // those are the same events whatever the holding folder is called;
    // renaming it would churn history (a migration, every reader, every index)
    // for nothing. Asserted so a future tidy-up has to argue with a test.
    const ddl = readFileSync(
      fileURLToPath(new URL("packages/mailstore/sql/data-plane.sql", ROOT)),
      "utf8",
    );
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS quarantine_events/);
  });
});
