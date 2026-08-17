/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Identity } from "../lib/mail/types";
import {
  deleteVerdict,
  identityFieldNote,
  identityPatch,
  identityToForm,
  isSynthetic,
  loadIdentitySettings,
  saveIdentity,
  type IdentityForm,
} from "../lib/settings/identity";
import {
  VACATION_NO_OPTIMISTIC_GUARD,
  VACATION_PLAIN_TEXT_ONLY,
  loadVacation,
  saveVacation,
  vacationPatch,
  vacationStatus,
  vacationToForm,
  type VacationForm,
  type VacationResponse,
} from "../lib/settings/vacation";

/**
 * `/settings` — sVOL `024`, s07 T2. The two `HumanSettings` datatypes
 * (`config.yml:51-53`): `Identity` and `VacationResponse`.
 *
 * Deliberately thin. Every rule this screen enforces — what round-trips, what
 * the server swallows, what a window that has already closed means — lives in
 * `lib/settings/*.ts` with unit tests, because vitest runs `environment: "node"`
 * with no jsdom and a component is therefore not directly testable here. What is
 * left in this file is state plumbing and markup; if a decision appears in it,
 * it is in the wrong file.
 */
export default function SettingsPanel({ client: injected }: { client?: JmapClient }) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [mode, setMode] = useState<ClientMode>("live");
  const [accountId, setAccountId] = useState("");
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [identity, setIdentity] = useState<Identity | undefined>(undefined);
  const [others, setOthers] = useState<Identity[]>([]);
  /** The account state string, for `ifInState` on the identity write. */
  const [state, setState] = useState<string>("");
  const [idForm, setIdForm] = useState<IdentityForm | undefined>(undefined);
  const [idBusy, setIdBusy] = useState(false);
  const [idProblems, setIdProblems] = useState<string[]>([]);
  const [idNote, setIdNote] = useState<string | undefined>(undefined);

  const [vacation, setVacation] = useState<VacationResponse | undefined>(undefined);
  const [vacForm, setVacForm] = useState<VacationForm | undefined>(undefined);
  const [vacBusy, setVacBusy] = useState(false);
  const [vacProblems, setVacProblems] = useState<string[]>([]);
  const [vacWarnings, setVacWarnings] = useState<string[]>([]);
  const [vacNote, setVacNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let active = injected;
        if (!active) {
          const resolved = resolveClient();
          // Same door as every other section (AppShell.tsx): there is no client
          // on the unauthenticated branch, so there is nothing to render even
          // by accident.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          active = resolved.client;
          if (!cancelled) setMode(resolved.mode);
        }
        const account = await active.primaryAccountId();
        // One round trip each rather than one batch: the two datatypes have
        // nothing to back-reference from each other, and a failure in one must
        // not blank the other — a server without the vacationresponse
        // capability should still let someone set a signature.
        const [ids, vac] = await Promise.all([
          loadIdentitySettings(active, account),
          loadVacation(active, account).catch(() => undefined),
        ]);
        if (cancelled) return;
        setClient(active);
        setAccountId(account);
        const [primary, ...rest] = ids.identities;
        setIdentity(primary);
        setOthers(rest);
        setState(ids.state);
        if (primary) setIdForm(identityToForm(primary));
        if (vac) {
          setVacation(vac);
          setVacForm(vacationToForm(vac));
        }
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setFatal(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  async function submitIdentity(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!client || !identity || !idForm) return;
    const { patch, problems } = identityPatch(identity, idForm);
    setIdProblems(problems);
    setIdNote(undefined);
    if (problems.length > 0) return;

    setIdBusy(true);
    const outcome = await saveIdentity(client, accountId, identity.id, patch, {
      // `Identity/set` compares this and refuses the whole call on a mismatch
      // (identity.ts:207-210) — the guard `VacationResponse/set` does not have.
      ...(state ? { ifInState: state } : {}),
    });
    setIdBusy(false);

    if (!outcome.ok) {
      setIdProblems([outcome.message]);
      return;
    }
    if (outcome.noop) {
      setIdNote("Nothing had changed.");
      return;
    }
    // Re-read rather than patch local state: the write materialises the
    // synthesized default into a real row, which changes `id` semantics and
    // `mayDelete`, and the state string has moved.
    const fresh = await loadIdentitySettings(client, accountId);
    const [primary, ...rest] = fresh.identities;
    setIdentity(primary);
    setOthers(rest);
    setState(fresh.state);
    if (primary) setIdForm(identityToForm(primary));
    setIdNote("Saved.");
  }

  async function submitVacation(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!client || !vacation || !vacForm) return;
    const { patch, problems, warnings } = vacationPatch(vacation, vacForm);
    setVacProblems(problems);
    setVacWarnings(warnings);
    setVacNote(undefined);
    if (problems.length > 0) return;

    setVacBusy(true);
    const outcome = await saveVacation(client, accountId, patch);
    setVacBusy(false);

    if (!outcome.ok) {
      setVacProblems([outcome.message]);
      return;
    }
    if (outcome.noop) {
      setVacNote("Nothing had changed.");
      return;
    }
    const fresh = await loadVacation(client, accountId);
    setVacation(fresh);
    setVacForm(vacationToForm(fresh));
    setVacNote("Saved.");
  }

  if (fatal) {
    return (
      <main class="settings">
        <p class="settings-error" role="alert">
          {fatal}
        </p>
      </main>
    );
  }
  if (loading) {
    return (
      <main class="settings">
        <p class="settings-muted">Loading settings…</p>
      </main>
    );
  }

  const emailNote = identityFieldNote("email");
  const canDelete = identity ? deleteVerdict(identity) : undefined;
  const status = vacation ? vacationStatus(vacation) : undefined;

  return (
    <main class="settings">
      {mode === "demo" ? (
        <p class="settings-banner">Sample data. Changes here are kept in this browser tab and reach no server.</p>
      ) : null}

      {/* ── identity ────────────────────────────────────────────────── */}
      <section class="settings-section" aria-labelledby="s-identity">
        <h2 id="s-identity" class="settings-h">
          Identity
        </h2>

        {!identity ? (
          <p class="settings-muted">This account has no sending identity.</p>
        ) : (
          <form class="settings-form" onSubmit={submitIdentity} novalidate>
            <label class="settings-label" for="i-email">
              Sending address
            </label>
            {/* Read-only rather than disabled-and-editable-looking: the server
                refuses a patch that names `email` at all (identity.ts:478-483),
                so accepting input would be collecting a change we must throw
                away — the exact failure this screen was warned about. */}
            <input id="i-email" class="settings-input" type="text" value={identity.email} readonly />
            <p class="settings-help">{emailNote?.note}</p>

            {isSynthetic(identity) ? (
              <p class="settings-help settings-warn">
                This identity has not been written yet — it is the default the server derives from your login when the
                identity table is empty. Saving anything below creates the real row, keeping this address.
              </p>
            ) : null}

            <label class="settings-label" for="i-name">
              Display name
            </label>
            <input
              id="i-name"
              class="settings-input"
              type="text"
              value={idForm?.name ?? ""}
              onInput={(e) => patchForm({ name: (e.target as HTMLInputElement).value })}
            />

            <label class="settings-label" for="i-replyto">
              Reply-To
            </label>
            <input
              id="i-replyto"
              class="settings-input"
              type="text"
              placeholder="Dana Scully &lt;dana@example.com&gt;, ops@example.com"
              value={idForm?.replyTo ?? ""}
              onInput={(e) => patchForm({ replyTo: (e.target as HTMLInputElement).value })}
            />
            <p class="settings-help">Where replies should go instead of the sending address.</p>

            <label class="settings-label" for="i-bcc">
              Always Bcc
            </label>
            <input
              id="i-bcc"
              class="settings-input"
              type="text"
              value={idForm?.bcc ?? ""}
              onInput={(e) => patchForm({ bcc: (e.target as HTMLInputElement).value })}
            />

            <label class="settings-label" for="i-textsig">
              Signature
            </label>
            <textarea
              id="i-textsig"
              class="settings-textarea"
              rows={4}
              value={idForm?.textSignature ?? ""}
              onInput={(e) => patchForm({ textSignature: (e.target as HTMLTextAreaElement).value })}
            />
            <p class="settings-help">
              Inserted when you compose from this address (RFC 8621 §6.1 — a hint to the client, not something the
              server appends).
            </p>

            <label class="settings-label" for="i-htmlsig">
              HTML signature
            </label>
            <textarea
              id="i-htmlsig"
              class="settings-textarea"
              rows={3}
              spellcheck={false}
              value={idForm?.htmlSignature ?? ""}
              onInput={(e) => patchForm({ htmlSignature: (e.target as HTMLTextAreaElement).value })}
            />
            {/* Worth stating, because the out-of-office body below looks like
                the same kind of field and is NOT stored. This one is. */}
            <p class="settings-help">Raw HTML, stored as typed. Optional.</p>

            {idProblems.length > 0 ? (
              <ul class="settings-problems" role="alert">
                {idProblems.map((p) => (
                  <li>{p}</li>
                ))}
              </ul>
            ) : null}
            {idNote ? <p class="settings-ok">{idNote}</p> : null}

            <div class="settings-actions">
              <button type="submit" class="settings-submit" disabled={idBusy}>
                {idBusy ? "Saving…" : "Save identity"}
              </button>
              {/* No delete button when the server would refuse one. Rendering
                  it and collecting the refusal teaches people the product is
                  broken (identity.ts:305-312 / migrations.mjs:143-148). */}
              {canDelete?.allowed ? (
                <span class="settings-help">This identity can be removed.</span>
              ) : (
                <span class="settings-help">{canDelete?.reason}</span>
              )}
            </div>
          </form>
        )}

        {others.length > 0 ? (
          <p class="settings-help">
            {others.length} other sending {others.length === 1 ? "address" : "addresses"} on this account:{" "}
            {others.map((o) => o.email).join(", ")}. Editing additional identities is not on this screen yet —{" "}
            <code>bullmoose identity</code> covers them.
          </p>
        ) : null}
      </section>

      {/* ── out of office ───────────────────────────────────────────── */}
      <section class="settings-section" aria-labelledby="s-vacation">
        <h2 id="s-vacation" class="settings-h">
          Out of office
        </h2>

        {!vacForm || !vacation ? (
          <p class="settings-muted">
            This server does not serve <code>VacationResponse</code>.
          </p>
        ) : (
          <form class="settings-form" onSubmit={submitVacation} novalidate>
            {/* What delivery will do to the next message, not what the checkbox
                says — an enabled responder whose window closed sends nothing
                (ingest/src/index.ts:360-361). */}
            <p class={`settings-status settings-status-${status?.activity}`}>{status?.summary}</p>

            <label class="settings-check">
              <input
                type="checkbox"
                checked={vacForm.isEnabled}
                onChange={(e) => patchVacation({ isEnabled: (e.target as HTMLInputElement).checked })}
              />
              Send an automatic reply
            </label>

            <label class="settings-label" for="v-subject">
              Subject
            </label>
            <input
              id="v-subject"
              class="settings-input"
              type="text"
              value={vacForm.subject}
              onInput={(e) => patchVacation({ subject: (e.target as HTMLInputElement).value })}
            />

            <label class="settings-label" for="v-body">
              Message
            </label>
            <textarea
              id="v-body"
              class="settings-textarea"
              rows={6}
              value={vacForm.textBody}
              aria-describedby="v-body-help"
              onInput={(e) => patchVacation({ textBody: (e.target as HTMLTextAreaElement).value })}
            />
            {/* The one thing s07 T2 was explicitly told not to get wrong. */}
            <p id="v-body-help" class="settings-help">
              {VACATION_PLAIN_TEXT_ONLY}
            </p>

            <div class="settings-row">
              <div>
                <label class="settings-label" for="v-from">
                  Start
                </label>
                <input
                  id="v-from"
                  class="settings-input"
                  type="datetime-local"
                  value={vacForm.fromDate}
                  onInput={(e) => patchVacation({ fromDate: (e.target as HTMLInputElement).value })}
                />
              </div>
              <div>
                <label class="settings-label" for="v-to">
                  End
                </label>
                <input
                  id="v-to"
                  class="settings-input"
                  type="datetime-local"
                  value={vacForm.toDate}
                  onInput={(e) => patchVacation({ toDate: (e.target as HTMLInputElement).value })}
                />
              </div>
            </div>
            <p class="settings-help">Leave either blank for no bound. Times are local.</p>

            {vacProblems.length > 0 ? (
              <ul class="settings-problems" role="alert">
                {vacProblems.map((p) => (
                  <li>{p}</li>
                ))}
              </ul>
            ) : null}
            {vacWarnings.length > 0 ? (
              <ul class="settings-warnings">
                {vacWarnings.map((w) => (
                  <li>{w}</li>
                ))}
              </ul>
            ) : null}
            {vacNote ? <p class="settings-ok">{vacNote}</p> : null}

            <div class="settings-actions">
              <button type="submit" class="settings-submit" disabled={vacBusy}>
                {vacBusy ? "Saving…" : "Save out of office"}
              </button>
            </div>

            {/* Honesty note, the pattern AppShell.tsx:577-579 already uses for
                search scope: say what the surface cannot do rather than let
                someone infer a guarantee that is not there. */}
            <p class="settings-help settings-warn">{VACATION_NO_OPTIMISTIC_GUARD}</p>
          </form>
        )}
      </section>
    </main>
  );

  function patchForm(part: Partial<IdentityForm>): void {
    setIdForm((prev) => (prev ? { ...prev, ...part } : prev));
    setIdNote(undefined);
    setIdProblems([]);
  }

  function patchVacation(part: Partial<VacationForm>): void {
    setVacForm((prev) => (prev ? { ...prev, ...part } : prev));
    setVacNote(undefined);
    setVacProblems([]);
    setVacWarnings([]);
  }
}
