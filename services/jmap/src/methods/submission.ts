import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges } from "@bullmoose/account-do";
import type { EmailAddress, Mailstore } from "@bullmoose/mailstore";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";
import { applyEmailPatch } from "./email";

/**
 * EmailSubmission/set (RFC 8621 §7.5). Sends exit through the submit
 * worker (service binding) which relays via SES — Cloudflare cannot
 * originate SMTP. Supports create + onSuccessUpdateEmail (the standard
 * "move draft to Sent, clear $draft" dance).
 */
export function registerSubmissionMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("EmailSubmission/set", emailSubmissionSet);
  registry.register("EmailSubmission/changes", async (args, ctx) =>
    proxyChanges(ctx, args, "EmailSubmission"),
  );
}

interface CreateSpec {
  emailId?: string;
  identityId?: string;
  envelope?: { mailFrom?: { email?: string }; rcptTo?: Array<{ email?: string }> } | null;
}

async function emailSubmissionSet(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args);
  const store = storeFor(ctx);
  const oldState = await accountState(ctx, access.accountId);

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const createdIds: string[] = [];
  /** creation-ref (#cid) → { submissionId, emailId } for onSuccess handling. */
  const byRef = new Map<string, { submissionId: string; emailId: string }>();

  const create = (args.create as Record<string, CreateSpec> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(create)) {
    try {
      const result = await submitOne(ctx, store, access, spec);
      created[cid] = { id: result.submissionId, undoStatus: "final", sendAt: result.sendAt };
      createdIds.push(result.submissionId);
      byRef.set(cid, result);
    } catch (err) {
      notCreated[cid] =
        err instanceof MethodError
          ? setError(err.type === "invalidArguments" ? "invalidProperties" : err.type, err.description)
          : setError("serverFail", String(err));
    }
  }

  // onSuccessUpdateEmail: keys are "#cid" creation refs (or submission ids);
  // values are Email PatchObjects applied to the submission's email.
  const mailboxesTouched = new Set<string>();
  const emailsUpdated: string[] = [];
  const onSuccess =
    (args.onSuccessUpdateEmail as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [key, patch] of Object.entries(onSuccess)) {
    const ref = key.startsWith("#") ? byRef.get(key.slice(1)) : undefined;
    if (!ref) continue; // send failed or unknown ref — nothing to update
    try {
      await applyEmailPatch(store, access.accountId, ref.emailId, patch, mailboxesTouched);
      emailsUpdated.push(ref.emailId);
    } catch (err) {
      console.error(`onSuccessUpdateEmail failed for ${ref.emailId}:`, err);
    }
  }

  let newState = oldState;
  if (createdIds.length > 0 || emailsUpdated.length > 0) {
    const entries = [];
    if (createdIds.length > 0) {
      entries.push({ collection: "EmailSubmission", created: createdIds });
    }
    if (emailsUpdated.length > 0) entries.push({ collection: "Email", updated: emailsUpdated });
    if (mailboxesTouched.size > 0) {
      entries.push({ collection: "Mailbox", updated: [...mailboxesTouched] });
    }
    ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, entries));
  }

  return {
    accountId: access.accountId,
    oldState,
    newState,
    created,
    notCreated,
    updated: {},
    notUpdated: {},
    destroyed: [],
    notDestroyed: {},
  };
}

async function submitOne(
  ctx: RequestContext,
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  spec: CreateSpec,
): Promise<{ submissionId: string; emailId: string; sendAt: string }> {
  if (!spec.emailId || !spec.identityId) {
    throw new MethodError("invalidArguments", "emailId and identityId are required");
  }

  const email = await store.getEmailRow(access.accountId, spec.emailId);
  if (!email) throw new MethodError("invalidArguments", `email ${spec.emailId} not found`);

  // Identity must belong to this account (synthesized default included).
  const identities = await store.getIdentities(access.accountId);
  const identity =
    identities.find((i) => i.id === spec.identityId) ??
    (spec.identityId === "identity_default"
      ? { id: "identity_default", email: ctx.principal.username, name: "" }
      : null);
  if (!identity) {
    throw new MethodError("invalidArguments", `identity ${spec.identityId} not found`);
  }

  // Envelope: explicit, or derived from the message (to + cc + bcc).
  const mailFrom = spec.envelope?.mailFrom?.email ?? identity.email;
  const rcptTo =
    spec.envelope?.rcptTo
      ?.map((r) => r.email)
      .filter((e): e is string => typeof e === "string") ??
    dedupe([...email.to, ...email.cc, ...email.bcc].map((a: EmailAddress) => a.email));
  if (rcptTo.length === 0) {
    throw new MethodError("invalidArguments", "no recipients");
  }

  const res = await ctx.env.SUBMIT.fetch("https://submit.internal/internal/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": ctx.env.INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      accountId: access.accountId,
      tenantId: access.tenantId,
      blobId: email.blobId,
      envelope: { mailFrom, rcptTo },
    }),
  });
  if (res.status === 422) {
    throw new MethodError("forbidden", "recipient(s) on suppression list");
  }
  if (!res.ok) {
    throw new MethodError("serverFail", `relay returned ${res.status}: ${await res.text()}`);
  }
  const { relayMessageId } = (await res.json()) as { relayMessageId: string };

  const submissionId = `es_${crypto.randomUUID()}`;
  const sendAtMs = Date.now();
  await store.insertSubmission(access.accountId, {
    id: submissionId,
    emailId: spec.emailId,
    identityId: identity.id,
    envelope: { mailFrom, rcptTo },
    undoStatus: "final",
    relayMessageId,
    sendAt: sendAtMs,
  });

  return {
    submissionId,
    emailId: spec.emailId,
    sendAt: new Date(sendAtMs).toISOString(),
  };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((e) => e.toLowerCase()))];
}
