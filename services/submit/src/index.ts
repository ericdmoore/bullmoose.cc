import { Mailstore } from "@bullmoose/mailstore";
import { SesRelay, type Envelope } from "@bullmoose/outbound";

/**
 * Submit — outbound sends + delivery-event handling.
 *
 * Cloudflare cannot originate SMTP, so EmailSubmission exits through a
 * cloud relay (SES v2 via SigV4 fetch). This worker also terminates the
 * SES → SNS event webhook and maintains the suppression list in KV.
 *
 *   POST /internal/submit   (jmap worker → here, shared-secret auth)
 *   POST /webhooks/ses      (SNS HTTPS subscription)
 */

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace; // also holds suppress:{email} keys
  SES_REGION: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  INTERNAL_TOKEN: string;
}

interface SubmitBody {
  accountId: string;
  tenantId: string;
  blobId: string; // the draft's raw RFC 5322 blob
  envelope: Envelope;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/submit") {
      if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
        return json({ error: "forbidden" }, 403);
      }
      return handleSubmit((await request.json()) as SubmitBody, env);
    }

    if (request.method === "POST" && url.pathname === "/webhooks/ses") {
      return handleSesEvent(request, env);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleSubmit(body: SubmitBody, env: Env): Promise<Response> {
  // Respect the suppression list before every send.
  const suppressed: string[] = [];
  for (const rcpt of body.envelope.rcptTo) {
    if (await env.ROUTES.get(`suppress:${rcpt.toLowerCase()}`)) suppressed.push(rcpt);
  }
  if (suppressed.length > 0) {
    return json({ error: "recipients suppressed", suppressed }, 422);
  }

  const store = new Mailstore(env.DB, env.BLOBS);
  const blob = await store.getBlob(body.tenantId, body.accountId, body.blobId);
  if (!blob) return json({ error: "draft blob not found" }, 404);
  const raw = new Uint8Array(await blob.arrayBuffer());

  const relay = new SesRelay({
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region: env.SES_REGION,
  });
  const result = await relay.send(raw, body.envelope);

  // State bookkeeping (EmailSubmission row, DO commit, draft → Sent) is
  // owned by the jmap worker's EmailSubmission/set — this endpoint only
  // relays. That also keeps this worker free of a Durable Object binding,
  // which would otherwise be circular with jmap's SUBMIT service binding.
  return json({ relayMessageId: result.relayMessageId });
}

/**
 * SNS webhook: auto-confirms the subscription, then applies bounce /
 * complaint events to the KV suppression list.
 * TODO: verify the SNS message signature before trusting payloads.
 */
async function handleSesEvent(request: Request, env: Env): Promise<Response> {
  const msg = (await request.json()) as {
    Type: string;
    SubscribeURL?: string;
    Message?: string;
  };

  if (msg.Type === "SubscriptionConfirmation" && msg.SubscribeURL) {
    await fetch(msg.SubscribeURL);
    return json({ ok: true, confirmed: true });
  }

  if (msg.Type === "Notification" && msg.Message) {
    const event = JSON.parse(msg.Message) as {
      eventType?: string;
      notificationType?: string;
      bounce?: { bounceType: string; bouncedRecipients: Array<{ emailAddress: string }> };
      complaint?: { complainedRecipients: Array<{ emailAddress: string }> };
    };
    const kind = event.eventType ?? event.notificationType;

    if (kind === "Bounce" && event.bounce?.bounceType === "Permanent") {
      for (const r of event.bounce.bouncedRecipients) {
        await env.ROUTES.put(`suppress:${r.emailAddress.toLowerCase()}`, "bounce");
      }
    }
    if (kind === "Complaint" && event.complaint) {
      for (const r of event.complaint.complainedRecipients) {
        await env.ROUTES.put(`suppress:${r.emailAddress.toLowerCase()}`, "complaint");
      }
    }
  }

  return json({ ok: true });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
