// Settings → Devices (s37 T2) — the machines, visible from the app.
//
// Self-contained like SettingsAgentsSection: resolves its own reads off the
// shared client, and its failures never blank the rest of the panel. The
// rendering rules are s37's decisions, phrased once here:
//
//   "last seen", never "connected" — a minted token is not a running CLI.
//   "as of ‹when›", never "installed" — a model list is a snapshot.
//   Reconcile warnings FIRST — they are the point; the list is the context.
//   An old server or a never-reported device renders honest absence, not
//   an empty confident table.

import { useEffect, useState } from "preact/hooks";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { AgentConsoleClient } from "../lib/console/ConsoleClient";
import type { ConsoleBinding } from "../lib/console/types";
import { resolveConsole } from "../lib/app/console";
import { agoLabel } from "../lib/activity/feed";
import {
  latestReportAt,
  loadDevices,
  reconcileLocalModels,
  type DeviceRow,
  type LocalModelGap,
} from "../lib/settings/devices";

interface Props {
  client: JmapClient | undefined;
  /** Injectable for tests, like SettingsAgentsSection's. */
  reads?: AgentConsoleClient;
}

export default function SettingsDevicesSection({ client, reads: injectedReads }: Props) {
  const [devices, setDevices] = useState<DeviceRow[] | null | undefined>(undefined);
  const [gaps, setGaps] = useState<LocalModelGap[]>([]);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const accountId = await client.primaryAccountId();
        const rows = await loadDevices(client, accountId);
        if (cancelled) return;
        setDevices(rows);
        if (rows && rows.length > 0) {
          // The dossier is the OTHER half of the join; a console that refuses
          // (grant-reached session, older server) just means no reconcile —
          // the device list stands on its own.
          try {
            const reads = injectedReads ?? resolveConsole().reads;
            const dossier = await reads.agentDossier(accountId);
            if (!cancelled) {
              setGaps(reconcileLocalModels((dossier.bindings ?? []) as ConsoleBinding[], rows));
            }
          } catch {
            /* reconcile is an enrichment; the device list is the read */
          }
        }
      } catch (err) {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const now = Date.now();
  const asOf = devices && devices.length > 0 ? latestReportAt(devices) : null;

  return (
    <section class="settings-section" aria-labelledby="s-devices">
      <h2 id="s-devices" class="settings-h">
        Devices
      </h2>
      <p class="settings-help">
        Every CLI install signed into this account — one per box, by tradition. A device appears here when its token is
        minted and describes itself when <code>bullmoose local</code> runs or its agent daemon starts.
      </p>

      {failed ? <p class="settings-warn">devices unavailable: {failed}</p> : null}

      {devices === null ? (
        <p class="settings-help">
          This server does not accept device reports yet — the inventory appears after its next deploy.
        </p>
      ) : null}

      {gaps.length > 0 ? (
        <ul class="settings-warn" data-testid="device-gaps">
          {gaps.map((g) => (
            <li key={`${g.bindingName}-${g.model}`}>
              <strong>{g.bindingName}</strong> references <code>@local/{g.model}</code> — no registered box reports
              serving it
              {asOf !== null ? ` (last report ${agoLabel(asOf, now)})` : ""}.
            </li>
          ))}
        </ul>
      ) : null}

      {devices && devices.length === 0 ? (
        <p class="settings-help">No devices yet — install the CLI and log in to register one.</p>
      ) : null}

      {devices && devices.length > 0 ? (
        <ul class="settings-devices">
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.name}</strong>
              {" · "}
              {d.lastUsedAt !== null ? `last seen ${agoLabel(d.lastUsedAt, now)}` : "never seen"}
              {d.reportedAt !== null ? (
                <span>
                  {" · "}
                  {d.host ?? "no host saved"}
                  {" · "}
                  {(d.models ?? []).length} model{(d.models ?? []).length === 1 ? "" : "s"} as of{" "}
                  {agoLabel(d.reportedAt, now)}
                </span>
              ) : (
                <span> · never reported</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
