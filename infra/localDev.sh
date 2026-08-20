#!/bin/sh
# Bring the whole platform up locally, and take ALL of it down on Ctrl-C.
#
# Why this exists: the build and the test suite are hermetic — `npm ci && npm
# test` needs no services at all. But RUNNING the thing is eight workers plus
# the webmail, and starting them by hand means eight terminals, remembered
# ports, and a stray `wrangler dev` still holding 8787 tomorrow morning.
#
# Two things this gets right that a pile of `&` does not:
#
#   1. ORDER. It mirrors DEPLOY_ORDER (.github/workflows/deploy-mail.yml,
#      infra/bootstrap.mjs): submit → bureau → jmap → oauth → agent → ingest →
#      provision → anglebrackets. bureau before jmap because jmap binds it
#      (#210); agent before ingest because ingest binds AGENT.
#   2. TEARDOWN. Every child is killed on INT/TERM/EXIT, so one Ctrl-C ends the
#      session cleanly instead of orphaning half of it.
#
# Service bindings resolve because wrangler's local dev registry lets
# concurrently-running `wrangler dev` sessions find each other — which is the
# whole reason to start them together rather than one at a time.
#
# What this canNOT give you, and no local script can:
#   • outbound mail — SES needs real credentials; the send path is covered by
#     relay fakes in the suite instead
#   • agent model calls — OPENROUTER_API_TOKEN is a real key or nothing
#   • inbound mail — real delivery arrives via Cloudflare Email Routing
# Local dev is for the JMAP/DAV/webmail surfaces. Everything else is tested.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOGS="$ROOT/.wrangler/localdev-logs"
mkdir -p "$LOGS"

# name:dir:port — order is load-bearing, see above.
SERVICES="submit:services/submit:8788
bureau:services/bureau:8789
jmap:services/jmap:8787
oauth:services/oauth:8790
agent:services/agent:8791
ingest:services/ingest:8792
provision:services/provision:8793
anglebrackets:services/anglebrackets:8794"

PORTS=$(echo "$SERVICES" | cut -d: -f3 | tr "\n" " ")
PIDS=""
# Teardown is the whole point of this script, and the naive version DOES NOT
# WORK — verified 2026-08-20, which is why this comment is long. `$!` is the npx
# PID; the process holding the port is `workerd`, two levels down (npx →
# wrangler → workerd). Killing the recorded PID orphans the servers: fifteen
# listeners survived a clean-LOOKING shutdown.
#
# The obvious fix — `kill 0`, the process group — is WORSE, and also verified:
# it signals the CALLER's group, so under `npm run dev`, a wrapper script, or CI
# (no job control) it can take the parent shell with it. Walk the tree instead:
# portable, precise, and it cannot reach anything we did not start.
kill_tree() { # pid, signal
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child" "$2"; done
  kill "-$2" "$1" 2>/dev/null || true
}
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "shutting down…"
  for p in $PIDS; do kill_tree "$p" TERM; done
  sleep 1
  for p in $PIDS; do kill_tree "$p" KILL; done
  # Final net: anything still LISTENING on a port we opened. Astro reparents to
  # PID 1 the moment its npm wrapper dies, so a tree walk can miss it — verified
  # 2026-08-20, one survivor out of fifteen. This only ever touches ports this
  # script started, so it cannot reach an unrelated server on the machine.
  for port in $PORTS 4321; do
    stray=$(lsof -tnP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
    [ -n "$stray" ] && kill -KILL "$stray" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "all stopped."
}
trap cleanup INT TERM EXIT

seed() {
  echo "seeding local D1 (bullmoose-mail-shard0)…"
  for f in packages/mailstore/sql/control-plane.sql packages/mailstore/sql/data-plane.sql; do
    (cd "$ROOT/services/jmap" && npx wrangler d1 execute bullmoose-mail-shard0 --local \
      --file "$ROOT/$f" >"$LOGS/seed.log" 2>&1) || {
        echo "  seed failed — see $LOGS/seed.log"; exit 1; }
    echo "  applied $(basename "$f")"
  done
}

wait_for() { # port, name
  i=0
  while [ $i -lt 60 ]; do
    if curl -s -o /dev/null -m 1 "http://127.0.0.1:$1/" 2>/dev/null; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  if [ "$2" = "agent" ]; then
    # Expected without Cloudflare credentials: services/agent binds Workers AI
    # ("ai": { "binding": "AI" }), which has NO local emulation — wrangler opens
    # a remote proxy session for it and fails when it cannot reach Cloudflare.
    # Everything else runs fully local. Not a bug; a binding that only exists up there.
    echo "  – needs CF credentials (Workers AI binding) — fine to skip locally"
  else
  echo "  ! $2 did not answer on :$1 within 30s — see $LOGS/$2.log"
  fi
  return 1
}

case "${1:-}" in
  --seed) seed ;;
  --help|-h)
    echo "usage: infra/localDev.sh [--seed]"
    echo "  --seed   apply the SQL schemas to the LOCAL D1 first (do this once)"
    exit 0 ;;
esac

echo "starting workers (Ctrl-C stops everything)…"
for entry in $SERVICES; do
  name=$(echo "$entry" | cut -d: -f1)
  dir=$(echo "$entry" | cut -d: -f2)
  port=$(echo "$entry" | cut -d: -f3)
  (cd "$ROOT/$dir" && exec npx wrangler dev --port "$port") >"$LOGS/$name.log" 2>&1 &
  PIDS="$PIDS $!"
  printf "  %-14s :%s" "$name" "$port"
  if wait_for "$port" "$name"; then echo "  ✓"; else echo ""; fi
done

(cd "$ROOT/webmail" && exec npm run dev) >"$LOGS/webmail.log" 2>&1 &
PIDS="$PIDS $!"
echo "  webmail        :4321"

cat <<BANNER

  ready.
    webmail    http://localhost:4321
    jmap api   http://localhost:8787/api/jmap
    session    http://localhost:8787/.well-known/jmap
    dav        http://localhost:8794/dav/
    logs       $LOGS/

  first run? stop and re-run with --seed to create the local tables.
  Ctrl-C stops everything.

BANNER

wait
