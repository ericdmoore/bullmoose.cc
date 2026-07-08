# Examples

Real, runnable configs and scripts referenced by the [cookbook](../README.md)
and the agent design in
[`../architecture/agent-integration.md`](../architecture/agent-integration.md).
They split two ways: **cloud agent bindings** (JSON you pass to
`bullmoose admin agent bind --config`, run by the deployed `agent` worker) and
the **homelab agent bridge** (a box you run yourself, Pattern A).

| file | what it is |
|---|---|
| [`editor-emily.config.json`](editor-emily.config.json) | Cloud **reply** binding — persona + a model-alias menu (`cheap`/`llama` on Workers AI, `opus4.8`/`sonnet`/… via AI Gateway). Powers EditorEmily ([cookbook §2](../README.md)); see also the [agent-accounts playbook](../../README.md#agent-backed-accounts--cloud-or-homelab). |
| [`analyst-allen.config.json`](analyst-allen.config.json) | Cloud **ledger** binding — `pipeline: "ledger"`, digest targets, spend categories, chart threshold. Powers Allen the Analyst ([cookbook §3](../README.md)). |
| [`hermes-bridge.sh`](hermes-bridge.sh) | The **homelab bridge**: `bullmoose watch` → a local agent (the `hermes` CLI) → reply out via popcorn SMTP, with a sender allowlist, RFC 3834 loop guards, and a watchdog. No cloud binding — Pattern A ([cookbook §4](../README.md)). |
| [`cc.bullmoose.hermes-bridge.plist`](cc.bullmoose.hermes-bridge.plist) | macOS **launchd** agent that keeps the bridge running (`RunAtLoad` + `KeepAlive`) on the homelab box. `__TOKEN__` is a placeholder for the `bm_…` app-password. |

The two `*.config.json` files are the server-side `BindingConfig` (persona,
`defaultModel`, `modelAliases`); the local `agent serve` runtime takes a
*different* schema — see the
[agent-accounts section](../../README.md#agent-backed-accounts--cloud-or-homelab)
of the top-level README for both.
