// s20 T2 — the verbs' JMAP doors, in one module (the lib/approvals/api.ts
// split, applied again): the injected `JmapClient` is composed, never a second
// client, and `capabilityForMethod` already routes `Watch/*` and
// `AgentInvocation/*` under the agent URN, so `using[]` is right without this
// module knowing about capabilities at all.
//
// TWO doors, deliberately different, because the verbs are:
//
//   Watch      arms a row through `Watch/set` — the CRUD s20 T1 shipped. No
//              invocation, no model, no proposal, no money. A human asking for
//              a watch is precisely what that method is for, and inventing a
//              second path to the same table would be the "one engine, two
//              doors" rule broken on its first day.
//   Answer /   create an ordinary `AgentInvocation` through the on-demand
//   Bring in   trigger (sVOL 007). The agent worker (services/agent
//              mailVerbs.ts) runs it and its OUTPUT is a proposal in the
//              ordinary queue: nothing about tier, cost, undo or the decline
//              taxonomy is special-cased for a verb.
//
// Every refusal comes back as a sentence, never a throw — an unknown method
// (a server without the verbs deployed), a missing binding, a disabled agent
// and a scope wall each say what they are. A verb that fails must fail the way
// the margin does: in place, quietly, with the mail still readable behind it.

import type { JmapClient } from "../jmap/JmapClient";
import type { RecipientVia } from "../intent/resolve";
import type { Email } from "../mail/types";
import { describeRefusal } from "../mail/triage";
import {
  askSentMessage,
  composeAskedMessage,
  isAddress,
  watchArmedMessage,
  pickVerbBinding,
  watchSpecFor,
  type AgentVerb,
} from "./contract";

/**
 * Which binding runs this verb, asked rather than assumed (#206's
 * `AgentBinding/get` retired the `extractor` convention).
 *
 * Returns a sentence instead of a binding when the account has none that can
 * run it, because the two failures read differently to a human: an account
 * with no agent at all is not the same as one whose agent you switched off,
 * and the second is a thing you can undo. Both are refusals here — the verb
 * never guesses a name and never throws.
 */
async function resolveVerbBinding(
  client: JmapClient,
  accountId: string,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  let response;
  try {
    [response] = await client.request([["AgentBinding/get", { accountId, ids: null }, "b0"]]);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const list = (response?.[1] as { list?: { id: string; name: string; enabled: boolean }[] } | undefined)?.list ?? [];
  const picked = pickVerbBinding(list);
  if (picked) return { ok: true, id: picked.id };
  return {
    ok: false,
    message:
      list.length === 0
        ? "No agent is set up on this mailbox yet, so there is nothing to ask."
        : "Every agent on this mailbox is switched off. Turn one back on and I can help.",
  };
}

export type VerbOutcome =
  | { ok: true; message: string }
  | {
      ok: false;
      /** A sentence a person can act on (the triage `describeRefusal` shape). */
      message: string;
      /** True when the session lacks the scope — the caller greys the verbs
       *  rather than inviting the same refusal again. */
      forbidden: boolean;
    };

const refused = (message: string, forbidden = false): VerbOutcome => ({ ok: false, message, forbidden });

/**
 * Arm "watch this message": no reply from the counterparty within the default
 * window → the sweep drafts a follow-up into your approvals. Reversible by
 * construction (an armed watch egresses nothing) and self-closing (a reply
 * that lands first expires it clean).
 */
export async function armWatch(
  client: JmapClient,
  accountId: string,
  email: Pick<Email, "id" | "threadId" | "from" | "to">,
  now: number = Date.now(),
): Promise<VerbOutcome> {
  const spec = watchSpecFor(email, now);
  if (!spec) return refused("This message carries no address to wait on, so there is nothing to watch.");

  let response;
  try {
    [response] = await client.request([["Watch/set", { accountId, create: { w: spec } }, "s0"]]);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if (!response) return refused("no response from the server");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    // `annotate` is the server's gate on Watch/set — the lightest mail-write
    // verb, because arming a watch enrolls the account in future cron work.
    const refusal = describeRefusal(detail, ["annotate"]);
    return refused(unknownMethodSentence(detail) ?? refusal.message, refusal.type === "forbidden");
  }

  const result = response[1] as {
    created?: Record<string, unknown>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  };
  if (result.created && "w" in result.created) return { ok: true, message: watchArmedMessage(spec) };
  const err = result.notCreated?.w;
  return refused(err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`);
}

export interface AskSpec {
  verb: AgentVerb;
  /** `bring-in` only — the address of the person to bring in. */
  person?: string;
  /** An optional one-line steer from the human. */
  note?: string;
}

/**
 * Ask the agent, in place, about this message. Creates a pending invocation
 * carrying the verb in its `params`; a runtime claims it over the changelog
 * and its answer arrives as a proposal.
 *
 * The ask is NOT the answer, and the sentence returned says so — the draft
 * appears in approvals when it is written, not now. Pretending otherwise
 * would be the one dishonest thing this surface could do.
 */
export async function askAgent(
  client: JmapClient,
  accountId: string,
  email: Pick<Email, "id" | "threadId">,
  spec: AskSpec,
): Promise<VerbOutcome> {
  if (spec.verb === "bring-in" && !(spec.person && isAddress(spec.person))) {
    // Client-side, before any round trip: a bring-in with no address cannot
    // produce an addressable draft, and the server would only tell us so
    // later. There is no name→address lookup here on purpose — guessing which
    // "Sergio" you meant is exactly the kind of confident wrongness the
    // approvals queue exists to catch, and it is cheaper to ask.
    return refused("Who should I bring in? An email address, please — I would rather ask than guess.");
  }

  const binding = await resolveVerbBinding(client, accountId);
  if (!binding.ok) return refused(binding.message);

  let response;
  try {
    [response] = await client.request([
      [
        "AgentInvocation/set",
        {
          accountId,
          create: {
            v: {
              bindingId: binding.id,
              emailId: email.id,
              threadId: email.threadId,
              note: spec.note ?? undefined,
              params: {
                verb: spec.verb,
                ...(spec.person ? { person: spec.person.trim() } : {}),
                ...(spec.note ? { note: spec.note.trim() } : {}),
              },
            },
          },
        },
        "s0",
      ],
    ]);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if (!response) return refused("no response from the server");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    // `draft` gates AgentInvocation/set: creating one causes an agent to draft.
    const refusal = describeRefusal(detail, ["draft"]);
    return refused(unknownMethodSentence(detail) ?? refusal.message, refusal.type === "forbidden");
  }

  const result = response[1] as {
    created?: Record<string, unknown>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  };
  if (result.created && "v" in result.created) {
    return { ok: true, message: askSentMessage(spec.verb, spec.person) };
  }
  const err = result.notCreated?.v;
  return refused(notCreatedSentence(err));
}

/** An intent, ready to send: what the human wants to happen, to an address
 *  they have already looked at. */
export interface ComposeAsk {
  /** The resolved recipient. An ADDRESS — this door never carries a name. */
  to: string;
  /** What the human typed into "what do you want to happen?", verbatim. */
  intent: string;
  tone?: string;
  constraints?: string[];
  /** How `to` was arrived at, so the approval row can repeat it. */
  recipientVia?: RecipientVia;
  /** The most recent message between you, when the lookup found one. Context
   *  for the draft, never a parent: a compose does not thread (the apply case
   *  in `services/jmap` enforces that, not this). */
  anchorEmailId?: string;
}

/**
 * The composer's intent mode (s20 T3) — the third door into the SAME machinery
 * the message-view verbs use: an ordinary `AgentInvocation`, run by
 * `services/agent mailVerbs.ts`, whose output is an ordinary tier-1 proposal
 * that applies into your own Drafts.
 *
 * Two refusals happen here, before any round trip, and both are the same rule
 * `bring-in` states: **this door never sends a name.** A recipient that is not
 * an address means the resolution was ambiguous or empty, and the answer to
 * that is to ask the human, not to spend money guessing. The composer will not
 * even offer the button in that state; this is the belt.
 */
export async function askCompose(client: JmapClient, accountId: string, ask: ComposeAsk): Promise<VerbOutcome> {
  const to = ask.to.trim();
  if (!isAddress(to)) {
    return refused("Which address should this go to? I would rather ask than guess.");
  }
  const intent = ask.intent.trim();
  if (!intent) return refused("Tell me what you want to happen, and I will draft it.");

  const binding = await resolveVerbBinding(client, accountId);
  if (!binding.ok) return refused(binding.message);

  let response;
  try {
    [response] = await client.request([
      [
        "AgentInvocation/set",
        {
          accountId,
          create: {
            v: {
              bindingId: binding.id,
              // Only when the lookup found one. `AgentInvocation/set` create
              // requires an emailId for every verb EXCEPT this one, precisely
              // because a new message usually has no source (services/jmap
              // agent.ts, `NO_EMAIL_VERBS`).
              ...(ask.anchorEmailId ? { emailId: ask.anchorEmailId } : {}),
              note: intent.slice(0, 300),
              params: {
                verb: "compose",
                person: to,
                intent,
                ...(ask.tone ? { tone: ask.tone } : {}),
                ...(ask.constraints && ask.constraints.length > 0 ? { constraints: ask.constraints } : {}),
                ...(ask.recipientVia ? { recipientVia: ask.recipientVia } : {}),
              },
            },
          },
        },
        "s0",
      ],
    ]);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if (!response) return refused("no response from the server");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    const refusal = describeRefusal(detail, ["draft"]);
    return refused(unknownMethodSentence(detail) ?? refusal.message, refusal.type === "forbidden");
  }

  const result = response[1] as {
    created?: Record<string, unknown>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  };
  if (result.created && "v" in result.created) return { ok: true, message: composeAskedMessage(to) };
  return refused(notCreatedSentence(result.notCreated?.v));
}

/**
 * A server that does not know the method at all — an older deployment, or the
 * demo without the door wired. `unknownMethod` through `describeRefusal` would
 * read "The server refused: unknownMethod", which tells a person nothing.
 */
function unknownMethodSentence(detail: { type?: string }): string | null {
  return detail.type === "unknownMethod" ? "This mailbox's server does not offer agent verbs yet." : null;
}

/**
 * The three refusals a verb create actually meets, each said as itself. The
 * server's own sentences are good ones — the kill-switch refusal even names
 * the CLI verb that undoes it — so they are passed through rather than
 * paraphrased softer; only the bare `notFound` needs translating, because
 * "no such binding" is the server's truth and "no agent is set up" is the
 * human's.
 */
function notCreatedSentence(err: { type?: string; description?: string } | undefined): string {
  if (err?.type === "notFound") {
    // The roster read already picked a live binding, so a notFound here means
    // it went away between the two calls — rare, and honestly a race, not a
    // missing setup.
    return "That agent is no longer available on this mailbox.";
  }
  return err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`;
}
