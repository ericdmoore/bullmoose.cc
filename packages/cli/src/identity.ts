import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import {
  emitIds,
  emitJson,
  emitNdjson,
  failSetError,
  note,
  notFound,
  out,
  readInput,
  usage,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";

/**
 * bullmoose identity — the send-as and signature surface (sVOL 006):
 *
 *   identity list
 *   identity show      <id-or-email>
 *   identity signature <id-or-email> [--text <file|->] [--html <file>] [--clear]
 *   identity add       <email> [--name <n>] [--reply-to <addr>] [--bcc <addr>]
 *   identity rm        <id-or-email>
 *
 * This is the half that makes `Identity/set` human-verifiable rather than
 * merely test-verifiable: set a signature here, `bullmoose send` yourself
 * mail, read it in any client, and the signature is at the bottom.
 *
 * `send` applies the signature CLIENT-SIDE (see `appendTextSignature`), which
 * is what RFC 8621 §6.1 specifies — "a signature the client SHOULD insert" —
 * and what this repo's write path forces. `services/submit` fetches the raw
 * bytes of an already-imported blob from R2 and relays them unmodified; a
 * server that injected a signature there would have to re-encode the message
 * and rewrite the stored blob, or the copy in Sent would stop matching what
 * the recipient received.
 */

export interface IdentityOpts extends IoOpts {
  account?: string;
  name?: string;
  text?: string;
  html?: string;
  clear?: boolean;
  "reply-to"?: string;
  bcc?: string[];
}

export interface JmapIdentity {
  id: string;
  email: string;
  name: string;
  replyTo: Array<{ email: string; name?: string }> | null;
  bcc: Array<{ email: string; name?: string }> | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/**
 * RFC 3676 §4.3: a line of exactly "-- " is the signature separator every
 * mail client on earth recognises, and the one that lets a reply strip the
 * signature instead of quoting it.
 */
export const SIG_SEP = "\n-- \n";

/** No signature → the body is untouched, byte for byte. */
export function appendTextSignature(body: string, signature: string): string {
  if (!signature) return body;
  return `${body.replace(/\n+$/, "")}${SIG_SEP}${signature.replace(/\n+$/, "")}\n`;
}

/**
 * RFC 8621 §6.1: htmlSignature "MUST be an HTML snippet to be inserted into
 * the <body></body> section", so it is appended as a fragment rather than
 * escaped. Falls back to the plaintext signature in a <pre> when only that is
 * set, so a text-only signature still travels on a multipart/alternative send
 * rather than appearing in one half of the message and not the other.
 */
export function appendHtmlSignature(
  html: string,
  htmlSignature: string,
  textSignature = "",
): string {
  const snippet = htmlSignature
    ? htmlSignature
    : textSignature
      ? `<pre>${escapeHtml(textSignature.replace(/\n+$/, ""))}</pre>`
      : "";
  if (!snippet) return html;
  return `${html}\n<div class="bm-signature">\n<div>-- </div>\n${snippet}\n</div>\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** id first, then exact email, then case-insensitive email. */
export function resolveIdentity(list: JmapIdentity[], selector: string): JmapIdentity {
  const wanted = selector.trim();
  const found =
    list.find((i) => i.id === wanted) ??
    list.find((i) => i.email === wanted) ??
    list.find((i) => i.email.toLowerCase() === wanted.toLowerCase());
  if (!found) {
    notFound(
      `identity ${selector} not found; available: ${list.map((i) => i.email).join(", ") || "(none)"}`,
    );
  }
  return found;
}

export function renderIdentity(i: JmapIdentity): string {
  const marks = [
    i.mayDelete ? "" : "primary",
    i.textSignature ? "sig" : "",
    i.htmlSignature ? "html-sig" : "",
    i.replyTo?.length ? `reply-to:${i.replyTo.map((a) => a.email).join(",")}` : "",
    i.bcc?.length ? `bcc:${i.bcc.map((a) => a.email).join(",")}` : "",
  ].filter(Boolean);
  const label = i.name ? `${i.name} <${i.email}>` : i.email;
  return `${i.id}\t${label}${marks.length > 0 ? `\t${marks.join(" ")}` : ""}`;
}

export async function cmdIdentity(
  db: DatabaseSync,
  positionals: string[],
  opts: IdentityOpts,
): Promise<void> {
  const [sub, arg] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccountId(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list":
    case undefined: {
      const list = await listIdentities(client, accountId);
      if (opts.ids) return emitIds(list.map((i) => i.id));
      if (opts.json) return emitNdjson(list);
      if (list.length === 0) return note("(no identities)");
      for (const i of list) out(renderIdentity(i));
      return;
    }

    case "show": {
      if (!arg) usage("bullmoose identity show <id-or-email>");
      const found = resolveIdentity(await listIdentities(client, accountId), arg);
      if (opts.ids) return emitIds([found.id]);
      if (opts.json) return emitJson(found);
      out(renderIdentity(found));
      if (found.textSignature) {
        note("");
        note("signature:");
        out(found.textSignature);
      }
      return;
    }

    case "signature": {
      if (!arg) {
        usage(
          "bullmoose identity signature <id-or-email> [--text <file|->] [--html <file>] [--clear]",
        );
      }
      const found = resolveIdentity(await listIdentities(client, accountId), arg);
      const patch = signaturePatch(opts);
      if (opts.dryRun) {
        note(`dry run: would set the signature on ${found.email}`);
        if (opts.json) emitJson({ dryRun: true, id: found.id, ...patch });
        return;
      }
      const res = await setIdentity(client, accountId, opts, { update: { [found.id]: patch } });
      if ((res.notUpdated as Record<string, unknown>)[found.id]) {
        failSetError("signature", (res.notUpdated as Record<string, unknown>)[found.id]);
      }
      return report(opts, res, { ...patch, id: found.id }, `signature set on ${found.email}`);
    }

    case "add": {
      if (!arg)
        usage("bullmoose identity add <email> [--name <n>] [--reply-to <addr>] [--bcc <addr>]");
      const spec: Record<string, unknown> = { email: arg };
      if (opts.name !== undefined) spec.name = opts.name;
      if (opts["reply-to"] !== undefined) spec.replyTo = [{ email: opts["reply-to"] }];
      if (opts.bcc !== undefined && opts.bcc.length > 0) {
        spec.bcc = opts.bcc.flatMap((v) => v.split(",")).map((v) => ({ email: v.trim() }));
      }
      if (opts.dryRun) {
        note(`dry run: would add identity ${arg}`);
        if (opts.json) emitJson({ dryRun: true, ...spec });
        return;
      }
      const res = await setIdentity(client, accountId, opts, { create: { c1: spec } });
      const made = (res.created as Record<string, { id: string }>).c1;
      if (!made) failSetError("add", (res.notCreated as Record<string, unknown>).c1);
      return report(opts, res, { id: made.id, email: arg }, `added ${arg} (${made.id})`);
    }

    case "rm": {
      if (!arg) usage("bullmoose identity rm <id-or-email>");
      const found = resolveIdentity(await listIdentities(client, accountId), arg);
      if (opts.dryRun) {
        note(`dry run: would remove ${found.email} (${found.id})`);
        if (opts.json) emitJson({ dryRun: true, id: found.id, email: found.email });
        return;
      }
      const res = await setIdentity(client, accountId, opts, { destroy: [found.id] });
      if (!(res.destroyed as string[]).includes(found.id)) {
        failSetError("rm", (res.notDestroyed as Record<string, unknown>)[found.id]);
      }
      return report(opts, res, { id: found.id, email: found.email }, `removed ${found.email}`);
    }

    default:
      usage(`unknown identity subcommand: ${sub} (list|show|signature|add|rm)`);
  }
}

/**
 * `--clear` wins, then explicit `--text`/`--html`, then stdin (arch.md §1.4:
 * a bare invocation reads a pipe, and `-` is explicit stdin). Reading stdin
 * when nothing was named is what makes `cat sig.txt | bullmoose identity
 * signature default` work.
 */
function signaturePatch(opts: IdentityOpts): Record<string, unknown> {
  if (opts.clear) return { textSignature: "", htmlSignature: "" };
  const patch: Record<string, unknown> = {};
  if (opts.html !== undefined) {
    patch.htmlSignature = readInput(opts.html, { required: true, what: "html signature" })!.text;
  }
  if (opts.text !== undefined) {
    patch.textSignature = readInput(opts.text, { required: true, what: "signature" })!.text;
  } else if (opts.html === undefined) {
    patch.textSignature = readInput(undefined, { required: true, what: "signature" })!.text;
  }
  return patch;
}

async function listIdentities(client: JmapClient, accountId: string): Promise<JmapIdentity[]> {
  const res = await client.one("Identity/get", { accountId, ids: null });
  return res.list as JmapIdentity[];
}

function setIdentity(
  client: JmapClient,
  accountId: string,
  opts: IdentityOpts,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.one("Identity/set", {
    accountId,
    ...(opts.ifState ? { ifInState: opts.ifState } : {}),
    ...body,
  });
}

/** arch.md §1.7: a write REPORTS the state it landed on, so a loop can chain. */
function report(
  opts: IdentityOpts,
  res: Record<string, unknown>,
  what: Record<string, unknown>,
  line: string,
): void {
  const state = (res.newState as string | undefined) ?? null;
  if (opts.ids) return emitIds([String(what.id)]);
  if (opts.json) return emitJson({ ...what, state });
  out(line);
  if (state) note(`state ${state}`);
}
