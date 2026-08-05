import { AwsClient } from "aws4fetch";

/**
 * OutboundRelay — the pluggable seam for outbound SMTP. Cloudflare cannot
 * send mail, so every send exits through a cloud relay. SES is the
 * default; Postmark/Resend adapters can be added per tenant without
 * touching JMAP code.
 */

export interface Envelope {
  /** SMTP MAIL FROM (return-path). Must be on a verified sending domain. */
  mailFrom: string;
  rcptTo: string[];
}

export interface SendResult {
  relayMessageId: string;
}

export interface OutboundRelay {
  send(rawMessage: Uint8Array, envelope: Envelope): Promise<SendResult>;
}

/**
 * AWS SES v2 adapter. Uses SigV4-signed fetch (aws4fetch) with a
 * least-privilege IAM key (ses:SendRawEmail only) held as Worker secrets —
 * Workers can't assume STS roles natively.
 */
export class SesRelay implements OutboundRelay {
  private aws: AwsClient;
  private endpoint: string;

  constructor(opts: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    /** SES configuration set for per-domain/tenant reputation isolation. */
    configurationSet?: string;
  }) {
    this.aws = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: "ses",
    });
    this.endpoint = `https://email.${opts.region}.amazonaws.com/v2/email/outbound-emails`;
    this.configurationSet = opts.configurationSet;
  }

  private configurationSet?: string;

  async send(rawMessage: Uint8Array, envelope: Envelope): Promise<SendResult> {
    const body = {
      FromEmailAddress: envelope.mailFrom,
      Destination: { ToAddresses: envelope.rcptTo },
      Content: { Raw: { Data: base64(rawMessage) } },
      ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
    };

    const res = await this.aws.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`SES send failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { MessageId: string };
    return { relayMessageId: data.MessageId };
  }
}

/**
 * Cloudflare Email Service relay (beta) — makes an all-Cloudflare
 * deployment possible and gives day-one outbound without waiting on SES
 * production access (3k sends/mo included on Workers Paid).
 *
 * EXPERIMENTAL, with a known fidelity caveat: the REST API takes
 * structured payloads, not raw RFC 5322 — so the stored message is
 * decomposed (postal-mime) and threading headers (Message-ID,
 * In-Reply-To, References) are re-attached via custom headers.
 * Attachments are NOT yet mapped (structured attachment support exists
 * in the API but is unimplemented here). SES SendRawEmail remains the
 * full-fidelity default; prefer it once available. A raw-fidelity CF
 * path would be their SMTP endpoint via cloudflare:sockets — future.
 */
export class CloudflareRelay implements OutboundRelay {
  constructor(
    private opts: { accountId: string; apiToken: string },
  ) {}

  async send(rawMessage: Uint8Array, envelope: Envelope): Promise<SendResult> {
    const { default: PostalMime } = await import("postal-mime");
    const buf = rawMessage.buffer.slice(
      rawMessage.byteOffset,
      rawMessage.byteOffset + rawMessage.byteLength,
    ) as ArrayBuffer;
    const parsed = await PostalMime.parse(buf);

    const headers: Record<string, string> = {};
    if (parsed.messageId) headers["Message-ID"] = parsed.messageId;
    if (parsed.inReplyTo) headers["In-Reply-To"] = parsed.inReplyTo;
    const references = parsed.headers?.find((h) => h.key === "references")?.value;
    if (references) headers["References"] = references;

    const body = {
      from: envelope.mailFrom,
      to: envelope.rcptTo,
      subject: parsed.subject ?? "",
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      ...(parsed.html !== undefined ? { html: parsed.html } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`Cloudflare Email send failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      success: boolean;
      result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] };
      errors?: Array<{ message: string }>;
    };
    if (!data.success) {
      throw new Error(`Cloudflare Email send failed: ${data.errors?.[0]?.message ?? "unknown"}`);
    }
    const bounced = data.result?.permanent_bounces ?? [];
    if (bounced.length > 0) {
      console.warn(`CloudflareRelay: permanent bounces for ${bounced.join(", ")}`);
    }
    return {
      relayMessageId: `cf-${(data.result?.delivered?.length ?? 0)}d-${(data.result?.queued?.length ?? 0)}q-${crypto.randomUUID()}`,
    };
  }
}

/**
 * Dev/test relay: accepts everything, sends nothing. Selected in the
 * submit worker with RELAY=mock so the full EmailSubmission path can be
 * exercised locally (SES cannot run against wrangler dev).
 */
export class MockRelay implements OutboundRelay {
  async send(_rawMessage: Uint8Array, envelope: Envelope): Promise<SendResult> {
    console.log(`MockRelay: would send to ${envelope.rcptTo.join(", ")}`);
    return { relayMessageId: `mock-${crypto.randomUUID()}` };
  }
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
