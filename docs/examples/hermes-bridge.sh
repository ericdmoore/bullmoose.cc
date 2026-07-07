#!/bin/sh
# hermes-bridge — makes hermes@bullmoose.cc a front door to the local
# hermes agent, using Cloudflare infra instead of Gmail.
#
#   bullmoose watch (JMAP push)  →  new mail to hermes@bullmoose.cc
#     → full body via `bullmoose read`
#     → the real hermes agent (`hermes -z`, per-sender session memory)
#     → reply out through the kettlecorn SMTP bridge (popcorn on :9587)
#
# A 45s watchdog fires a "hermes may be down" note if the agent hasn't
# produced a reply in time (cancelled the instant hermes returns).
#
# Loop safety: only inbox `created` events, never self, allowlist of
# human senders, skip anything already carrying Auto-Submitted.
set -eu

export BULLMOOSE_HOME="$HOME/.hermes-bullmoose"
BM="$HOME/bin/bullmoose"
HERMES="${HERMES_BIN:-$HOME/.local/bin/hermes}"
SELF="hermes@bullmoose.cc"
TSIP=$(/opt/homebrew/bin/tailscale ip -4 2>/dev/null | head -1)
SMTP="smtp://${TSIP:-127.0.0.1}:9587"
STATE="$HOME/.hermes-bullmoose/state"
LOG="$HOME/.hermes-bullmoose/bridge.log"
WATCHDOG_SECS=45

ALLOW="eric@bullmoose.cc eric@moore.coffee eric.d.moore@gmail.com"
: "${HERMES_SMTP_TOKEN:?set HERMES_SMTP_TOKEN to a bm_ token for hermes@}"
mkdir -p "$STATE"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >> "$LOG"; }
allowed() { for a in $ALLOW; do [ "$1" = "$a" ] && return 0; done; return 1; }

# send <to> <subject> <auto-flag> <body>
send() {
  _to="$1"; _sub="$2"; _auto="$3"; _body="$4"
  printf 'From: Hermes <%s>\r\nTo: %s\r\nSubject: %s\r\n%s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$SELF" "$_to" "$_sub" "$_auto" "$_body" \
    | curl -s --url "$SMTP" --mail-from "$SELF" --mail-rcpt "$_to" \
        --user "$SELF:$HERMES_SMTP_TOKEN" --upload-file - >>"$LOG" 2>&1
}

# watchdog <id> <to> <subject> — background; fires unless $STATE/<id>.done appears.
watchdog() {
  ( sleep "$WATCHDOG_SECS"
    [ -f "$STATE/$1.done" ] && exit 0
    log "watchdog FIRED for $1"
    send "$2" "$3" "Auto-Submitted: auto-replied" \
      "Hermes may be down right now — it has been more than 30s since it should have responded. Your message is received; I'll answer when it recovers."
  ) &
}

"$BM" watch --account "$SELF" --json 2>>"$LOG" | while IFS= read -r line; do
  case "$line" in *'"event":"created"'*) : ;; *) continue ;; esac
  echo "$line" | grep -q '"mailboxes":"[^"]*inbox' || continue
  id=$(echo "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  [ -n "$id" ] || continue

  raw=$("$BM" read "$id" --raw 2>>"$LOG" | tr -d '\r' || true)
  from=$(printf '%s\n' "$raw" | sed -n 's/^From:.*<\([^>]*\)>.*/\1/p; s/^From: *\([^[:space:]]*@[^[:space:]]*\)[[:space:]]*$/\1/p' | head -1 | tr 'A-Z' 'a-z')
  subject=$(printf '%s\n' "$raw" | sed -n 's/^Subject: *//p' | head -1)

  if [ "$from" = "$SELF" ]; then log "skip self $id"; continue; fi
  if printf '%s\n' "$raw" | grep -qi '^Auto-Submitted: *[^n]'; then log "skip auto-submitted $id"; continue; fi
  if ! allowed "$from"; then log "skip non-allowed '$from' ($id)"; continue; fi

  resub="Re: $subject"; case "$subject" in Re:*|re:*) resub="$subject" ;; esac
  rm -f "$STATE/$id.done"
  watchdog "$id" "$from" "$resub"

  body=$(printf '%s\n' "$raw" | awk 'seen{print} /^[[:space:]]*$/{seen=1}')
  log "invoking hermes for $from re: $subject ($id)"
  session="bullmoose-$(printf '%s' "$from" | tr -c 'a-z0-9' '-')"
  prompt=$(printf 'Email from %s\nSubject: %s\n\n%s' "$from" "$subject" "$body")
  reply=$("$HERMES" -z "$prompt" --continue "$session" 2>>"$LOG" || true)

  # hermes returned → cancel the watchdog, then deliver.
  touch "$STATE/$id.done"
  [ -n "$reply" ] || reply="(hermes produced no output)"
  if send "$from" "$resub" "Auto-Submitted: auto-replied" "$reply"; then
    log "replied to $from ($id)"
  else
    log "SMTP send FAILED for $id"
  fi
done
