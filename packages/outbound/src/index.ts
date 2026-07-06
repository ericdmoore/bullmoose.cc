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

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
