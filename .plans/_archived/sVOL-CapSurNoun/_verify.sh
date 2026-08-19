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
# ⚠️ 2026-08-17 — THAT MECHANISM DID NOT WORK, and it is worth understanding why
# before trusting this file again.
#
# The design is sound and the decay signal is real, but it is only emitted when
# the script RUNS, and this script requires a live BM_TOKEN against a deployed
# account. There is no CI job for it, no fixture mode, and no record of it ever
# having been executed. So five assertions quietly went wrong and stayed wrong:
#
#   Thread/changes ABSENT      (027 landed 2026-08-14)
#   FileNode/get   ABSENT      (011 landed 2026-08-13)
#   FileNode/set   ABSENT      (   "                 )
#   MCP has NO email tool      (014 landed)
#   MCP tools/list returns 14  (was 29)
#
# "Designed to decay loudly" is a property of the assertions; being RUN is a
# property of the process, and only the first one was ever built. If you are
# adding to this file, the highest-value change is not another assertion — it is
# a way to run the ones that exist. Until then these lines are reviewed prose
# that happens to be executable, and they must be re-derived from the source by
# hand, which is what 2026-08-17 did.
# -----------------------------------------------------------------------------
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

# Every other assertion in this file proves a method *dispatches*. This one
# proves full-text search actually *works*: `text` is the condition common/004
# moved off a full-table LIKE scan onto FTS5. A pre-common/004 deployment
# answers `ok` here too (LIKE would also match), so this does NOT detect a
# missing index — what it detects is the migration hazard in docs/DEPLOY.md,
# where `emails_fts_map` exists but `emails_fts` was never rebuilt with
# `contentless_delete=1`. That database still delivers and still queries; it
# fails only on destroy — which this script never exercises, because every
# assertion here is a read-only no-op against a live deployment. Detecting
# that hazard needs a real create-then-destroy round trip, which this file
# is deliberately not in the business of doing. Verify it by hand at deploy.
check "Email/query text     accepts FTS condition" ok \
      jmap_outcome "Email/query" "{\"accountId\":$ACC,\"filter\":{\"text\":\"bullmoose\"},\"limit\":1}"

section "Mailbox — grid says CRUD on JMAP (unit 004 closed the gap)"
check "Mailbox/get          present"        ok           jmap_outcome "Mailbox/get"   "$GET_NOOP"
check "Mailbox/query        present"        ok           jmap_outcome "Mailbox/query" "$QRY_NOOP"
# ↓ WAS the headline gap; 004 landed and this flipped from unknownMethod to ok.
check "Mailbox/set          present  ← 004" ok           jmap_outcome "Mailbox/set"  "$SET_NOOP"

section "Thread — derived, read only (unit 027 closed)"
check "Thread/get           present"        ok            jmap_outcome "Thread/get"     "$GET_NOOP"
# 027 landed 2026-08-14 (services/jmap/src/methods/thread.ts:24). This line used to
# expect `unknownMethod` and was WRONG for three days without anyone noticing,
# because the script needs a live token and was never run. The three answers are
# NOT interchangeable and that distinction is the whole unit:
#   unknownMethod          → "this server does not speak RFC 8621 §3.2"
#   cannotCalculateChanges → RFC 8620 §5.2's sanctioned "I cannot compute it"  ← correct
#   an empty delta         → a lie the client cannot detect (never acceptable)
# If this ever returns `ok` with a real delta, someone built thread-state tracking
# and the grid gained a cell.
check "Thread/changes       cannotCalculateChanges ← 027" cannotCalculateChanges \
      jmap_outcome "Thread/changes" "{\"accountId\":$ACC,\"sinceState\":\"0\"}"

section "EmailSubmission — set+get+changes all registered (005 closed the /get hole)"
check "EmailSubmission/set     present"     ok            jmap_outcome "EmailSubmission/set" "$SET_NOOP"
# ↓ WAS the registry inconsistency — /changes reported ids no method could read.
#   005 landed and this flipped from unknownMethod to ok.
check "EmailSubmission/get     present ← 005" ok          jmap_outcome "EmailSubmission/get" "$GET_NOOP"
# NOT asserted here, deliberately: 005 shipped CONFORMANCE ONLY, so every row's
# `deliveryStatus` is null and `undoStatus` is "final". Both are honest (nothing
# correlates SES bounce/complaint events back onto a submission — _index.md fn 8)
# and neither is a grid fact this script can check without a sent message in the
# account. They are pinned by unit test instead:
# services/jmap/src/methods/submission.test.ts, "it does not claim a delivery
# status it cannot know". If that suite ever goes green while /get emits a
# per-recipient map, the follow-up unit landed — and THIS section needs a row.
#
# `EmailSubmission/changes` is likewise not asserted: `sinceState: "0"` legally
# 409s (→ cannotCalculateChanges) once the changelog window has moved past the
# floor, so the row would be flaky against a live account rather than wrong.

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
section "Files — the noun EXISTS (unit 011 / s03.B closed)"
# 011 closed 2026-08-13; the family is registered in services/jmap/src/methods/filenode.ts
# (get :72, changes :114, queryChanges :119, query :123, set :187, copy :318) and wired
# into the registry via registerFileNodeMethods (methods/index.ts). These two lines used
# to expect `unknownMethod` — the same never-run decay as Thread/changes above.
#
# ⚠️ `FileNode/get` is sent `ids: []` here on purpose, matching every other /get row.
# webmail's client warns NEVER to send an empty array in application code
# (webmail/src/lib/files/api.ts:29) because the demo store reads it as "the whole
# account" — that is a client-side hazard, not a server one. This asserts dispatch.
check "FileNode/get         present ← 011"  ok            jmap_outcome "FileNode/get" "$GET_NOOP"
check "FileNode/set         present ← 011"  ok            jmap_outcome "FileNode/set" "$SET_NOOP"

# ---------------------------------------------------------------------------
# The agent console's read interface (unit 023 / s03.E). Not JMAP methods —
# plain GET routes on the jmap worker, so this asserts HTTP status.
#
# One line, not four: `handleConsole` gates the whole family before it routes
# (console.ts:288-307), so if the family is unreachable this fails, and if it is
# reachable the remaining three differ only in their path parsing. It returns
# `{"agents":[]}` with a 200 for a caller who owns no agent bindings, so this is
# safe against any account.
#
# ⚠️ BM_TOKEN must be a HUMAN session token. An agent-marked token gets a
# deliberate 403 here (console.ts:298) — that is the s10 boundary working, not a
# regression. Mint with `bullmoose token create`, not from an agent binding.
# ---------------------------------------------------------------------------
section "Agent console read routes (unit 023)"
check "GET /console/agents  served ← 023"   200  http_status GET "$BM_BASE/console/agents"

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
check "Identity/set         present ← 006"   ok            jmap_outcome "Identity/set"  "$SET_NOOP"
check "Identity/changes     present ← 006"   ok            jmap_outcome "Identity/changes" "{\"accountId\":$ACC,\"sinceState\":\"0\"}"

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
# MCP — the noun column was EMPTY until 013. 014 and 015 have since landed too,
# so this section's assertions were re-derived from the source on 2026-08-17.
# =============================================================================
section "MCP tool surface"
# MCP.2 negotiates PER REQUEST: the MCP-Protocol-Version header must be present
# AND equal `_meta` protocolVersion, and `_meta` clientCapabilities is required
# (services/agent/src/mcp.ts). `params: {}` — what an earlier draft of this file
# sent — is a 400 every time, so these assertions could only ever have reported
# a transport error. §7's "nothing here was ever run" in one line of evidence.
MCP_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
mcp_post() {   # $1 = params object body (without the surrounding braces), $2 = token
  curl -sS -m 20 -X POST "$BM_MCP/mcp" \
    -H "Authorization: Bearer ${2:-$BM_TOKEN}" -H 'Content-Type: application/json' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    ${BM_INTERNAL:+-H "x-internal-token: $BM_INTERNAL"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{$1,$MCP_META}}" 2>/dev/null
}
mcp_list() {
  curl -sS -m 20 -X POST "$BM_MCP/mcp" \
    -H "Authorization: Bearer $BM_TOKEN" -H 'Content-Type: application/json' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    ${BM_INTERNAL:+-H "x-internal-token: $BM_INTERNAL"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$MCP_META}}" 2>/dev/null
}
mcp_tools() {
  local body; body="$(mcp_list)" || { echo "TRANSPORT-ERROR"; return; }
  printf '%s' "$body" | jq -r '(.result.tools // []) | length' 2>/dev/null || echo "UNPARSEABLE"
}
mcp_noun_tools() {
  printf '%s' "$(mcp_list)" | jq -r '
    (.result.tools // []) | map(select(.name | test("^(calendar|contacts)_"))) | length' \
    2>/dev/null || echo "UNPARSEABLE"
}
mcp_has_email_tool() {   # 014 — landed; email_* tools are PRESENT
  printf '%s' "$(mcp_list)" | jq -r '
    if ((.result.tools // []) | map(select(.name | test("^email_"))) | length) > 0
    then "present" else "none" end' 2>/dev/null || echo "UNPARSEABLE"
}
# TOOLS = ANALYTICS + NOUN + EMAIL + INTROSPECT (services/agent/src/mcp.ts:401-406):
#    4  analytics   spend_by_month, spend_by_vendor, top_senders, message_volume
#   10  013 nouns   mcpNouns.ts — calendar_* ×5, contacts_* ×5
#    8  014 email   emailTools.ts — EMAIL_TOOLS = READ_TOOLS + TRIAGE_TOOLS
#    7  015 intro   introspectTools.ts — INTROSPECT_TOOLS
#   --
#   29
#
# ⚠️ This exact-count row is the most fragile assertion in the file, and it has
# already decayed once: it said 14 (the pre-014 total) while the surface carried
# 29. It is kept exact rather than `>=` because the count IS the grid fact — but
# if you land a tool, THIS is the line that fails, and updating it is the job.
# Same failure mode the summary block at the foot of this file warns about.
#
# `tools/list` is unfiltered for a plain human token; it narrows only inside an
# invocation envelope (mcp.ts:689-695), which this script never enters.
check "MCP tools/list returns 29 tools"          29 mcp_tools
check "MCP HAS 10 calendar/contact tools ← 013"  10 mcp_noun_tools
check "MCP HAS email tools ← 014"           present mcp_has_email_tool
# MCP.2 removed `initialize` entirely (s01 T2).
check "MCP initialize removed (s01)" "-32601" \
      bash -c 'curl -sS -m 20 -X POST "'"$BM_MCP"'/mcp" \
        -H "Authorization: Bearer '"$BM_TOKEN"'" -H "Content-Type: application/json" \
        -H "MCP-Protocol-Version: 2026-07-28" \
        '"${BM_INTERNAL:+-H \"x-internal-token: $BM_INTERNAL\"}"' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}" 2>/dev/null \
        | jq -r ".error.code // \"no-error\""'

# The MCP half of the scope-gate suite. It lives here rather than up in the
# "Scope gates" section only because mcp_post is defined below that section;
# it is the same regression test, on the surface where an AGENT rather than a
# human holds the scope. 013 done-when #3.
if [ -n "$BM_RO_TOKEN" ] || [ "$LIST_ONLY" = 1 ]; then
  mcp_ro_create() {
    printf '%s' "$(mcp_post "\"name\":\"calendar_create_event\",\"arguments\":{\"accountId\":\"$BM_ACCOUNT\",\"title\":\"verify-probe\",\"start\":\"2030-01-01T09:00:00\"}" "$BM_RO_TOKEN")" \
      | jq -r '.error.code // "no-error"' 2>/dev/null || echo "UNPARSEABLE"
  }
  mcp_ro_list() {
    printf '%s' "$(mcp_post "\"name\":\"calendar_list\",\"arguments\":{\"accountId\":\"$BM_ACCOUNT\"}" "$BM_RO_TOKEN")" \
      | jq -r 'if .result then "ok" else (.error.code|tostring) end' 2>/dev/null || echo "UNPARSEABLE"
  }
  # A read token must be refused the WRITE and allowed the READ. If the first
  # returns anything but -32004, the per-tool gate 001 added is not biting.
  check "read-token refused calendar_create_event ← 013" "-32004" mcp_ro_create
  check "read-token CAN calendar_list ← 013"             ok       mcp_ro_list
fi

# =============================================================================
# Summary
# =============================================================================
if [ "$LIST_ONLY" = 1 ]; then
  # Print the count rather than documenting it anywhere. A hardcoded number in
  # prose drifts every time a unit lands — readme.md said "44 assertions" while
  # this script had 47, and was already wrong by two before that.
  printf '\n%s%d assertions. (--list: nothing was executed)%s\n' \
    "$D" "$(grep -cE '^[[:space:]]*check ' "$0")" "$Z"; exit 0
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
