#!/usr/bin/env bash
# =============================================================================
# _verify.sh — the executable form of the grid in _index.md
#
# `_context.md` §7 admits that nothing in this volume was ever RUN. This script
# is the answer to that: every claim in the §1 grid becomes an assertion.
#
# It asserts BOTH directions, and the second is the important one:
#
#   present cells → the method runs
#   ABSENT cells  → the method is still absent
#
# Asserting the absences is what keeps the grid honest. When someone lands
# `Mailbox/set`, the "expected unknownMethod" assertion FAILS — and that failure
# is the signal to update `_index.md`. A red line here is not necessarily a bug;
# read the label.
#
# -----------------------------------------------------------------------------
# Usage
#   BM_TOKEN=bm_... BM_ACCOUNT=acc_... ./_verify.sh
#   ./_verify.sh calendar              # only labels containing "calendar"
#   ./_verify.sh --list                # print every assertion, run nothing
#
# Env
#   BM_BASE      JMAP worker            default http://127.0.0.1:8787
#   BM_DAV       anglebrackets worker   default http://127.0.0.1:8788
#   BM_MCP       agent worker           default http://127.0.0.1:8789
#   BM_TOKEN     bearer (required)
#   BM_ACCOUNT   account id (required)
#   BM_RO_TOKEN  a token scoped `read` ONLY (optional; enables the gate suite)
#   BM_INTERNAL  x-internal-token for the MCP worker (optional)
#
# Exit code = number of failed assertions (0 = grid matches reality).
# Requires: bash 3.2+, curl, jq.
# =============================================================================

set -uo pipefail   # deliberately NOT -e: a failed assertion must not abort the run

BM_BASE="${BM_BASE:-http://127.0.0.1:8787}"
BM_DAV="${BM_DAV:-http://127.0.0.1:8788}"
BM_MCP="${BM_MCP:-http://127.0.0.1:8789}"
BM_TOKEN="${BM_TOKEN:-}"
BM_ACCOUNT="${BM_ACCOUNT:-}"
BM_RO_TOKEN="${BM_RO_TOKEN:-}"
BM_INTERNAL="${BM_INTERNAL:-}"

ONLY=""; LIST_ONLY=0
case "${1:-}" in
  --list) LIST_ONLY=1 ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  "") ;;
  *) ONLY="$1" ;;
esac

PASS=0; FAIL=0; SKIP=0
FAILED_LABELS=()

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; Z=$'\033[0m'
else G=""; R=""; Y=""; D=""; Z=""; fi

# --- the assertion primitive ------------------------------------------------
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ -n "$ONLY" ]; then case "$label" in *"$ONLY"*) ;; *) SKIP=$((SKIP+1)); return ;; esac; fi
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS+1)); printf '  %sPASS%s  %s\n' "$G" "$Z" "$label"
  else
    FAIL=$((FAIL+1)); FAILED_LABELS+=("$label")
    printf '  %sFAIL%s  %s\n' "$R" "$Z" "$label"
    printf '        expecting string value "%s"\n' "$expected"
    printf '        and we actually got   "%s"\n' "$actual"
  fi
}

announce() { # label-only mode for --list
  if [ -n "$ONLY" ]; then case "$1" in *"$ONLY"*) ;; *) return ;; esac; fi
  printf '  %s\n' "${D}-> ${Z}$1"
}

section() { printf '\n%s── %s%s\n' "$Y" "$1" "$Z"; }

# --- transport helpers ------------------------------------------------------
USING='["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail","urn:ietf:params:jmap:contacts","urn:ietf:params:jmap:calendars"]'

# jmap_outcome <method> <args-json> [token]
#   → "ok" if the handler ran, else the JMAP error `type` (e.g. unknownMethod,
#     forbidden, invalidArguments). Shape per packages/jmap-core/src/dispatch.ts:41.
jmap_outcome() {
  local method="$1" args="$2" token="${3:-$BM_TOKEN}" body
  body="$(curl -sS -m 20 -X POST "$BM_BASE/api/jmap" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"using\":$USING,\"methodCalls\":[[\"$method\",$args,\"c0\"]]}" 2>/dev/null)" || {
      echo "TRANSPORT-ERROR"; return; }
  printf '%s' "$body" | jq -r '
    if .methodResponses == null then "NO-METHODRESPONSES"
    else (.methodResponses[0] // []) as $r
      | if ($r[0] // "") == "error" then ($r[1].type // "error-untyped") else "ok" end
    end' 2>/dev/null || echo "UNPARSEABLE"
}

http_status() { # http_status <method> <url> [extra curl args...]
  local m="$1" u="$2"; shift 2
  curl -sS -m 20 -o /dev/null -w '%{http_code}' -X "$m" "$u" \
    -H "Authorization: Bearer $BM_TOKEN" "$@" 2>/dev/null || echo "000"
}

# check <label> <expected> <command...>
check() {
  local label="$1" expected="$2"; shift 2
  if [ "$LIST_ONLY" = 1 ]; then announce "$label  ${D}[expect: $expected]${Z}"; return; fi
  assert_eq "$label" "$expected" "$("$@")"
}

ACC=""   # set after preflight

# =============================================================================
# Preflight
# =============================================================================
if [ "$LIST_ONLY" = 0 ]; then
  command -v jq  >/dev/null || { echo "${R}jq is required${Z}"; exit 127; }
  command -v curl >/dev/null || { echo "${R}curl is required${Z}"; exit 127; }
  if [ -z "$BM_TOKEN" ] || [ -z "$BM_ACCOUNT" ]; then
    echo "${R}BM_TOKEN and BM_ACCOUNT are required.${Z}"
    echo "  bullmoose token create --name verify --scopes mail"
    echo "  bullmoose accounts        # for the id"
    exit 2
  fi
  printf '%sbullmoose sVOL grid verification%s\n' "$Y" "$Z"
  printf '%sjmap=%s dav=%s mcp=%s account=%s%s\n' "$D" "$BM_BASE" "$BM_DAV" "$BM_MCP" "$BM_ACCOUNT" "$Z"
fi
ACC="\"$BM_ACCOUNT\""

GET_NOOP="{\"accountId\":$ACC,\"ids\":[]}"
SET_NOOP="{\"accountId\":$ACC}"
QRY_NOOP="{\"accountId\":$ACC,\"limit\":1}"

# =============================================================================
# Grid — Mail
# =============================================================================
section "Email — grid says CRUD on JMAP"
check "Email/get            present"        ok jmap_outcome "Email/get"    "$GET_NOOP"
check "Email/query          present"        ok jmap_outcome "Email/query"  "$QRY_NOOP"
check "Email/set            present"        ok jmap_outcome "Email/set"    "$SET_NOOP"
check "Email/import         present"        ok jmap_outcome "Email/import" "$SET_NOOP"
check "Email/queryChanges   throws (026)"   cannotCalculateChanges \
      jmap_outcome "Email/queryChanges" "{\"accountId\":$ACC,\"sinceQueryState\":\"0\"}"

section "Mailbox — grid says CRUD on JMAP (unit 004 closed the gap)"
check "Mailbox/get          present"        ok           jmap_outcome "Mailbox/get"   "$GET_NOOP"
check "Mailbox/query        present"        ok           jmap_outcome "Mailbox/query" "$QRY_NOOP"
# ↓ WAS the headline gap; 004 landed and this flipped from unknownMethod to ok.
check "Mailbox/set          present  ← 004" ok           jmap_outcome "Mailbox/set"  "$SET_NOOP"

section "Thread — derived, read only (unit 027)"
check "Thread/get           present"        ok            jmap_outcome "Thread/get"     "$GET_NOOP"
check "Thread/changes       ABSENT  ← 027"  unknownMethod jmap_outcome "Thread/changes" "{\"accountId\":$ACC,\"sinceState\":\"0\"}"

section "EmailSubmission — set+changes registered, /get missing (unit 005)"
check "EmailSubmission/set     present"     ok            jmap_outcome "EmailSubmission/set" "$SET_NOOP"
check "EmailSubmission/get     ABSENT ← 005" unknownMethod jmap_outcome "EmailSubmission/get" "$GET_NOOP"

# =============================================================================
# Grid — Contacts / Calendar  (capability COMPLETE; only projections missing)
# =============================================================================
section "Contacts — grid says full CRUD on JMAP"
check "AddressBook/get      present"        ok            jmap_outcome "AddressBook/get"   "$GET_NOOP"
check "AddressBook/set      present"        ok            jmap_outcome "AddressBook/set"   "$SET_NOOP"
check "AddressBook/query    ABSENT ← 012"   unknownMethod jmap_outcome "AddressBook/query" "$QRY_NOOP"
check "ContactCard/get      present"        ok            jmap_outcome "ContactCard/get"   "$GET_NOOP"
check "ContactCard/set      present"        ok            jmap_outcome "ContactCard/set"   "$SET_NOOP"
check "ContactCard/query    present"        ok            jmap_outcome "ContactCard/query" "$QRY_NOOP"

section "Calendar — grid says full CRUD on JMAP"
check "Calendar/get         present"        ok            jmap_outcome "Calendar/get"          "$GET_NOOP"
check "Calendar/set         present"        ok            jmap_outcome "Calendar/set"          "$SET_NOOP"
check "Calendar/query       ABSENT ← 012"   unknownMethod jmap_outcome "Calendar/query"        "$QRY_NOOP"
check "CalendarEvent/get    present"        ok            jmap_outcome "CalendarEvent/get"     "$GET_NOOP"
check "CalendarEvent/set    present"        ok            jmap_outcome "CalendarEvent/set"     "$SET_NOOP"
check "CalendarEvent/query  present"        ok            jmap_outcome "CalendarEvent/query"   "$QRY_NOOP"
check "CalendarEvent/getOccurrences present" ok           jmap_outcome "CalendarEvent/getOccurrences" \
      "{\"accountId\":$ACC,\"after\":0,\"before\":99999999999999}"

# =============================================================================
# Grid — everything else
# =============================================================================
section "Files — the noun does not exist (unit 011 / s03.B)"
check "FileNode/get         ABSENT ← 011"   unknownMethod jmap_outcome "FileNode/get" "$GET_NOOP"
check "FileNode/set         ABSENT ← 011"   unknownMethod jmap_outcome "FileNode/set" "$SET_NOOP"

# -----------------------------------------------------------------------------
# Blob + share lifecycle — unit 010. Not JMAP methods: plain routes on the jmap
# worker, so these assert HTTP status rather than a method outcome.
#
# The revoke round-trip below is the ONLY assertion in this file that both
# writes and then proves a NEGATIVE, and it is the unit's whole point: mint a
# link, fetch it (200), revoke it, fetch the SAME url again (403). A test that
# stopped at "revoke returned 200" would pass against a revoke that did
# nothing, which is exactly the failure this replaces. It is self-cleaning —
# the link it mints is the link it kills.
# -----------------------------------------------------------------------------
section "Blob + share lifecycle (unit 010)"
check "GET /api/blobs      present ← 010"  200  http_status GET  "$BM_BASE/api/blobs/$BM_ACCOUNT"
check "GET /api/shares     present ← 010"  200  http_status GET  "$BM_BASE/api/shares/$BM_ACCOUNT"
check "DELETE /api/blobs   404 unknown blob" 404 http_status DELETE "$BM_BASE/api/blobs/$BM_ACCOUNT/b_definitely_not_a_blob"
check "revoke unknown id   404 not 200"    404  http_status POST "$BM_BASE/api/shares/$BM_ACCOUNT/sh_nonexistent/revoke"

# share_revoke_roundtrip → "200/403" when the kill switch works.
# Any other pair is a real failure; read both halves.
share_revoke_roundtrip() {
  local blob sid url before after
  blob="$(curl -sS -m 20 -X POST "$BM_BASE/api/upload/$BM_ACCOUNT" \
    -H "Authorization: Bearer $BM_TOKEN" -H 'Content-Type: text/plain' \
    --data-binary "sVOL 010 verify $(date +%s)" 2>/dev/null | jq -r '.blobId // empty')"
  [ -n "$blob" ] || { echo "UPLOAD-FAILED"; return; }

  local mint
  mint="$(curl -sS -m 20 -X POST "$BM_BASE/api/share/$BM_ACCOUNT/$blob" \
    -H "Authorization: Bearer $BM_TOKEN" -H 'Content-Type: application/json' \
    -d '{"name":"verify.txt","ttlSeconds":60}' 2>/dev/null)"
  url="$(printf '%s' "$mint" | jq -r '.url // empty')"
  sid="$(printf '%s' "$mint" | jq -r '.shareId // empty')"
  # No shareId in the response = the pre-010 stateless minter is still deployed.
  [ -n "$url" ] && [ -n "$sid" ] || { echo "MINT-FAILED-OR-STATELESS"; return; }

  # The public fetch carries NO Authorization header — a recipient's view.
  before="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  curl -sS -m 20 -o /dev/null -X POST "$BM_BASE/api/shares/$BM_ACCOUNT/$sid/revoke" \
    -H "Authorization: Bearer $BM_TOKEN" 2>/dev/null
  # KV is eventually consistent; give propagation a moment before concluding.
  sleep 2
  after="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  echo "$before/$after"
}
check "share revoke KILLS the link ← 010" "200/403" share_revoke_roundtrip

section "Agents / HumanSettings"
check "AgentInvocation/get  present"        ok            jmap_outcome "AgentInvocation/get" "$GET_NOOP"
check "VacationResponse/get present"        ok            jmap_outcome "VacationResponse/get" "$GET_NOOP"
check "Identity/get         present"        ok            jmap_outcome "Identity/get"  "$GET_NOOP"
check "Identity/set         ABSENT ← 006"   unknownMethod jmap_outcome "Identity/set"  "$SET_NOOP"
check "Identity/changes     ABSENT ← 006"   unknownMethod jmap_outcome "Identity/changes" "{\"accountId\":$ACC,\"sinceState\":\"0\"}"

# =============================================================================
# Scope gates — this suite is a live regression test for common/001 (P1)
# =============================================================================
if [ -n "$BM_RO_TOKEN" ] || [ "$LIST_ONLY" = 1 ]; then
  section "Scope gates (needs BM_RO_TOKEN = a token scoped 'read' ONLY)"
  # `read` must NOT satisfy a write. If these return "ok", the gate is open.
  check "read-token cannot CalendarEvent/set" forbidden \
        jmap_outcome "CalendarEvent/set" "$SET_NOOP" "$BM_RO_TOKEN"
  check "read-token cannot ContactCard/set"   forbidden \
        jmap_outcome "ContactCard/set"   "$SET_NOOP" "$BM_RO_TOKEN"
  check "read-token CAN Email/get"            ok \
        jmap_outcome "Email/get"         "$GET_NOOP" "$BM_RO_TOKEN"
else
  section "Scope gates — SKIPPED (set BM_RO_TOKEN to enable)"
  printf '  %sThis suite is the live regression test for common/001 (P1):%s\n' "$D" "$Z"
  printf '  %s"mail" is treated as a universal scope, so a mail-scoped token%s\n' "$D" "$Z"
  printf '  %salready satisfies calendar/contacts/vault/send/delete.%s\n' "$D" "$Z"
fi

# =============================================================================
# DAV — read-write for RESOURCES **and** COLLECTIONS since unit 009
# =============================================================================
section "AngleBracket (CalDAV/CardDAV)"
check "DAV principal PROPFIND reachable" 207 \
      http_status PROPFIND "$BM_DAV/dav/principals/$BM_ACCOUNT/" -H 'Depth: 0'
check "OPTIONS advertises MKCALENDAR ← 009" ok \
      bash -c 'curl -sS -m 20 -D - -o /dev/null -X OPTIONS "'"$BM_DAV"'/dav/" 2>/dev/null \
        | grep -qi "^allow:.*MKCALENDAR" && echo ok || echo missing'
# 009 landed: MKCALENDAR creates the collection AT the client-chosen URI.
# The only WRITING assertions in this file, so they are self-cleaning: the
# leftover-probe DELETE is folded INSIDE the check command, not run at file
# scope, or `--list` would mutate the account it claims only to describe.
check "MKCALENDAR creates ← 009" 201 \
      bash -c 'p="'"$BM_DAV"'/dav/calendars/'"$BM_ACCOUNT"'/verify-probe/";
        a="Authorization: Bearer '"$BM_TOKEN"'";
        curl -sS -m 20 -o /dev/null -X DELETE "$p" -H "$a" 2>/dev/null;
        curl -sS -m 20 -o /dev/null -w "%{http_code}" -X MKCALENDAR "$p" -H "$a" 2>/dev/null'
check "collection DELETE removes it ← 009" 204 \
      http_status DELETE "$BM_DAV/dav/calendars/$BM_ACCOUNT/verify-probe/"

# =============================================================================
# MCP — the column is EMPTY of noun CRUD (units 013/014/015)
# =============================================================================
section "MCP tool surface"
mcp_tools() {
  local body
  body="$(curl -sS -m 20 -X POST "$BM_MCP/mcp" \
    -H "Authorization: Bearer $BM_TOKEN" -H 'Content-Type: application/json' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    ${BM_INTERNAL:+-H "x-internal-token: $BM_INTERNAL"} \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)" || {
      echo "TRANSPORT-ERROR"; return; }
  printf '%s' "$body" | jq -r '(.result.tools // []) | length' 2>/dev/null || echo "UNPARSEABLE"
}
mcp_has_calendar_tool() {
  local body
  body="$(curl -sS -m 20 -X POST "$BM_MCP/mcp" \
    -H "Authorization: Bearer $BM_TOKEN" -H 'Content-Type: application/json' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    ${BM_INTERNAL:+-H "x-internal-token: $BM_INTERNAL"} \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)"
  printf '%s' "$body" | jq -r '
    if ((.result.tools // []) | map(select(.name | test("calendar|contact"))) | length) > 0
    then "present" else "none" end' 2>/dev/null || echo "UNPARSEABLE"
}
# 4 read-only analytics tools today: spend_by_month, spend_by_vendor,
# top_senders, message_volume (services/agent/src/mcp.ts:55).
check "MCP tools/list returns 4 tools"      4    mcp_tools
check "MCP has NO calendar/contact tool ← 013" none mcp_has_calendar_tool
# MCP.2 removed `initialize` entirely (s01 T2).
check "MCP initialize removed (s01)" "-32601" \
      bash -c 'curl -sS -m 20 -X POST "'"$BM_MCP"'/mcp" \
        -H "Authorization: Bearer '"$BM_TOKEN"'" -H "Content-Type: application/json" \
        -H "MCP-Protocol-Version: 2026-07-28" \
        '"${BM_INTERNAL:+-H \"x-internal-token: $BM_INTERNAL\"}"' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}" 2>/dev/null \
        | jq -r ".error.code // \"no-error\""'

# =============================================================================
# Summary
# =============================================================================
if [ "$LIST_ONLY" = 1 ]; then
  printf '\n%s(--list: nothing was executed)%s\n' "$D" "$Z"; exit 0
fi

printf '\n%s─────────────────────────────%s\n' "$Y" "$Z"
printf '  %spassed%s %d   %sfailed%s %d   %sskipped%s %d\n' \
  "$G" "$Z" "$PASS" "$R" "$Z" "$FAIL" "$D" "$Z" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
  printf '\n%sFailures:%s\n' "$R" "$Z"
  for l in "${FAILED_LABELS[@]}"; do printf '  · %s\n' "$l"; done
  cat <<'EOF'

Before filing a bug, read the labels. A failure on an "ABSENT ← NNN" line means
that capability now EXISTS — the grid in _index.md is stale and unit NNN should
be marked ✅. That is the intended way this script decays.
EOF
fi
exit "$FAIL"
