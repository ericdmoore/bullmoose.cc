#!/bin/sh
# popcorn install planner — the installer's decision half.
#
# Nothing in this file writes, installs, loads or restarts anything. It reads
# the unit file that is already on the machine (if any), works out what the
# installer *would* write, and classifies every difference. install.sh owns
# every side effect.
#
# The split is the whole point: the dangerous decisions here — "replace the
# launchd job that is currently carrying this machine's mail" — can then be
# executed and asserted on from a test (deploy/plan_test.go) without an
# installer ever touching a real LaunchAgents directory.
#
# Usage: sourced by install.sh, or run directly with the inputs below in the
# environment, in which case it prints the plan on stdout and exits:
#
#   0  safe to apply (fresh machine, or nothing about the unit changes)
#   3  an existing unit would change — refused, needs an explicit --force
#   4  blocked: applying would break the service or widen its exposure
#
# Inputs (all optional, all strings):
#   CUR_PRESENT=1        a unit file already exists on this machine
#   CUR_PROGRAM CUR_LISTEN CUR_SMTP_LISTEN CUR_TLS_CERT CUR_TLS_KEY CUR_LOG
#                        ...parsed out of that unit
#   DEF_*                the same fields from the repo template (the values a
#                        fresh machine gets)
#   WANT_*               operator overrides from the command line
#   FORCE=1              apply over an existing unit
#   ALLOW_WIDEN=1        permit a listen address that reaches further
#   ALLOW_PLAINTEXT=1    permit no-TLS on a routable address
#
# Outputs (shell variables, and `key=value` lines when run directly):
#   PLAN_PROGRAM PLAN_LISTEN PLAN_SMTP_LISTEN PLAN_TLS_CERT PLAN_TLS_KEY
#   PLAN_LOG PLAN_TLS_MODE PLAN_ACTION PLAN_CHANGES PLAN_FINDINGS
#   PLAN_BLOCKS PLAN_WARNS

# ── filesystem probe ────────────────────────────────────────────────────────
# Defined only if the caller has not already defined it, so a test can inject
# a fake filesystem. (The real tests use real temp files; this hook is here
# because the alternative — plan logic that stats things itself and cannot be
# driven — is exactly what makes installers untestable.)
if ! command -v path_exists >/dev/null 2>&1; then
	path_exists() { [ -e "$1" ]; }
fi

# ── unit-file readers ───────────────────────────────────────────────────────

# plist_get FILE PLISTBUDDY_PATH KEY — value of one key in a launchd plist.
# PlistBuddy is authoritative (it also reads binary plists); the awk path is
# the fallback for CI, which runs this on Linux. POPCORN_PLIST_PARSER=awk
# forces the fallback so both readers stay covered.
plist_get() {
	_pg_file=$1
	_pg_pb=$2
	_pg_key=$3
	[ -f "$_pg_file" ] || return 0
	if [ "${POPCORN_PLIST_PARSER:-}" != awk ] && [ -x /usr/libexec/PlistBuddy ]; then
		/usr/libexec/PlistBuddy -c "Print $_pg_pb" "$_pg_file" 2>/dev/null || true
		return 0
	fi
	# The first <string> at or after the <key> — which covers both the
	# multi-line form the repo template uses and the one-line
	# `<key>K</key><string>V</string>` form install-tailscale-macos.sh
	# writes, and (for ProgramArguments) the first element of the array.
	awk -v key="$_pg_key" '
		BEGIN { tag = "<key>" key "</key>" }
		!seen && index($0, tag) {
			seen = 1
			$0 = substr($0, index($0, tag) + length(tag))
		}
		seen && match($0, /<string>[^<]*<\/string>/) {
			v = substr($0, RSTART + 8, RLENGTH - 17)
			gsub(/&lt;/, "<", v); gsub(/&gt;/, ">", v); gsub(/&amp;/, "\\&", v)
			print v
			exit
		}
	' "$_pg_file"
}

plist_env() { plist_get "$1" ":EnvironmentVariables:$2" "$2"; }

# plist_env_keys FILE — every POPCORN_* variable the unit sets, one per line.
# The installer models five of them; anything else is somebody's deliberate
# tuning (POPCORN_DELE_MODE, POPCORN_MAX_MESSAGES, a pinned POPCORN_JMAP_BASE)
# and has to survive a rewrite, so it must first be discoverable.
plist_env_keys() {
	[ -f "$1" ] || return 0
	awk '{
		while (match($0, /<key>POPCORN_[A-Z0-9_]+<\/key>/)) {
			print substr($0, RSTART + 5, RLENGTH - 11)
			$0 = substr($0, RSTART + RLENGTH)
		}
	}' "$1"
}
plist_program() { plist_get "$1" ":ProgramArguments:0" "ProgramArguments"; }
plist_log() { plist_get "$1" ":StandardOutPath" "StandardOutPath"; }

# envfile_get FILE KEY — one KEY=value line from a systemd EnvironmentFile.
# Commented lines are deliberately not matched: `#POPCORN_TLS_CERT=...` is an
# unset variable, and reading it as set would fabricate TLS that isn't there.
envfile_get() {
	[ -f "$1" ] || return 0
	sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -1 | sed 's/^"//; s/"$//'
}

# systemd_exec FILE — the binary a systemd unit runs (ExecStart, argv[0]).
systemd_exec() {
	[ -f "$1" ] || return 0
	sed -n 's/^ExecStart=//p' "$1" | tail -1 | sed 's/^[+!@-]*//' | awk '{print $1}'
}

# ── listen-address reach ────────────────────────────────────────────────────

# addr_host ADDR — the host half of host:port, "" for a bare :port.
addr_host() {
	case $1 in
	\[*\]:*)
		_ah=${1%]:*}
		printf '%s' "${_ah#[}"
		;;
	*:*) printf '%s' "${1%:*}" ;;
	*) printf '' ;;
	esac
}

# addr_rank ADDR[,ADDR...] — how far the address can be reached from, as the
# maximum over a comma-separated list (POPCORN_LISTEN takes several):
#
#   0  loopback           only this machine
#   1  private / tailnet   a WireGuard mesh or a LAN
#   2  some other specific address — assume routable
#   3  wildcard            every interface, including any public one
#
# Rank is the safety order the installer enforces: a plan may lower it, never
# raise it. It is deliberately pessimistic — an address it cannot classify is
# treated as public, so an unfamiliar bind is surfaced rather than waved past.
addr_rank() {
	_ar_max=0
	_ar_list=$(printf '%s' "$1" | tr ',' ' ')
	for _ar in $_ar_list; do
		_ar_h=$(addr_host "$_ar")
		case $_ar_h in
		"" | 0.0.0.0 | :: | "*") _ar_r=3 ;;
		127.* | ::1 | localhost) _ar_r=0 ;;
		10.* | 192.168.* | 169.254.* | fd* | fe80* | \
			172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | \
			100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) _ar_r=1 ;;
		*) _ar_r=2 ;;
		esac
		[ "$_ar_r" -gt "$_ar_max" ] && _ar_max=$_ar_r
	done
	printf '%s' "$_ar_max"
}

addr_reach() {
	case $(addr_rank "$1") in
	0) printf 'loopback' ;;
	1) printf 'private/tailnet' ;;
	2) printf 'routable' ;;
	*) printf 'every interface' ;;
	esac
}

# addr_widens OLD NEW — true when NEW can be reached from further away.
addr_widens() { [ "$(addr_rank "$2")" -gt "$(addr_rank "$1")" ]; }

# ── the plan ────────────────────────────────────────────────────────────────

pick() {
	for _p in "$@"; do
		[ -n "$_p" ] && {
			printf '%s' "$_p"
			return 0
		}
	done
	printf ''
}

finding() { # SEV CODE MESSAGE
	PLAN_FINDINGS="${PLAN_FINDINGS}$1 $2 $3
"
	case $1 in
	BLOCK) PLAN_BLOCKS=$((PLAN_BLOCKS + 1)) ;;
	WARN) PLAN_WARNS=$((PLAN_WARNS + 1)) ;;
	esac
}

change() { # FIELD OLD NEW
	PLAN_CHANGES="${PLAN_CHANGES}$1 $2 -> $3
"
}

# popcorn_plan — resolve every setting, then classify the deltas.
#
# Precedence is the safety rule that does most of the work in this file:
#
#   operator's explicit flag  >  what the machine already runs  >  template
#
# The template loses to the running config on purpose. The bug this installer
# had was the other order: it copied a template that omitted SMTP and bound
# POP3 to every interface straight over a working tailnet-only config, and
# printed "installed". A template is a starting point for a machine that has
# no answer yet, never a correction to a machine that already has one.
popcorn_plan() {
	PLAN_FINDINGS=""
	PLAN_CHANGES=""
	PLAN_BLOCKS=0
	PLAN_WARNS=0

	PLAN_PROGRAM=$(pick "${WANT_PROGRAM:-}" "${CUR_PROGRAM:-}" "${DEF_PROGRAM:-}")
	PLAN_LISTEN=$(pick "${WANT_LISTEN:-}" "${CUR_LISTEN:-}" "${DEF_LISTEN:-}")
	PLAN_LOG=$(pick "${WANT_LOG:-}" "${CUR_LOG:-}" "${DEF_LOG:-}")

	# The SMTP face exists only while POPCORN_SMTP_LISTEN is set — see the
	# `if smtpAddrs := os.Getenv(...); smtpAddrs != ""` branch in
	# cmd/popcorn/main.go. Dropping the variable does not degrade sending,
	# it deletes the service, and nothing in the log says so beyond one
	# absent line. WANT_SMTP_LISTEN=off is the only way to ask for that,
	# and it is still refused when a unit already has it.
	if [ "${WANT_SMTP_LISTEN:-}" = off ]; then
		PLAN_SMTP_LISTEN=""
	else
		PLAN_SMTP_LISTEN=$(pick "${WANT_SMTP_LISTEN:-}" "${CUR_SMTP_LISTEN:-}" "${DEF_SMTP_LISTEN:-}")
	fi

	# TLS is a pair or it is nothing: main.go enables TLS only when *both*
	# POPCORN_TLS_CERT and POPCORN_TLS_KEY are non-empty, and silently
	# serves plaintext otherwise. Resolving the two halves independently
	# could produce a cert from the running unit and a key from the
	# template, so they move together.
	if [ -n "${WANT_TLS_CERT:-}" ] || [ -n "${WANT_TLS_KEY:-}" ]; then
		PLAN_TLS_CERT=${WANT_TLS_CERT:-}
		PLAN_TLS_KEY=${WANT_TLS_KEY:-}
	elif [ -n "${CUR_TLS_CERT:-}" ] || [ -n "${CUR_TLS_KEY:-}" ]; then
		PLAN_TLS_CERT=${CUR_TLS_CERT:-}
		PLAN_TLS_KEY=${CUR_TLS_KEY:-}
	else
		PLAN_TLS_CERT=${DEF_TLS_CERT:-}
		PLAN_TLS_KEY=${DEF_TLS_KEY:-}
		# A template cert path is a guess about the machine. Only take it
		# if the files are really there; otherwise leave TLS unset, which
		# is loud further down, instead of writing a unit that cannot
		# start.
		if [ -n "$PLAN_TLS_CERT" ] && { ! path_exists "$PLAN_TLS_CERT" || ! path_exists "$PLAN_TLS_KEY"; }; then
			finding INFO tls-default-absent \
				"template cert $PLAN_TLS_CERT is not on this machine — leaving TLS unconfigured"
			PLAN_TLS_CERT=""
			PLAN_TLS_KEY=""
		fi
	fi

	if [ "${CUR_PRESENT:-}" = 1 ]; then
		[ "${CUR_PROGRAM:-}" = "$PLAN_PROGRAM" ] || change binary "${CUR_PROGRAM:-(unset)}" "$PLAN_PROGRAM"
		[ "${CUR_LISTEN:-}" = "$PLAN_LISTEN" ] || change pop3 "${CUR_LISTEN:-(unset)}" "${PLAN_LISTEN:-(unset)}"
		[ "${CUR_SMTP_LISTEN:-}" = "$PLAN_SMTP_LISTEN" ] || change smtp "${CUR_SMTP_LISTEN:-(unset)}" "${PLAN_SMTP_LISTEN:-(off)}"
		[ "${CUR_TLS_CERT:-}" = "$PLAN_TLS_CERT" ] || change tls_cert "${CUR_TLS_CERT:-(unset)}" "${PLAN_TLS_CERT:-(unset)}"
		[ "${CUR_TLS_KEY:-}" = "$PLAN_TLS_KEY" ] || change tls_key "${CUR_TLS_KEY:-(unset)}" "${PLAN_TLS_KEY:-(unset)}"
		[ "${CUR_LOG:-}" = "$PLAN_LOG" ] || change log "${CUR_LOG:-(unset)}" "${PLAN_LOG:-(unset)}"
	fi

	plan_check_widening
	plan_check_smtp
	plan_check_tls

	if [ "$PLAN_BLOCKS" -gt 0 ]; then
		PLAN_ACTION=blocked
	elif [ "${CUR_PRESENT:-}" != 1 ]; then
		PLAN_ACTION=install
	elif [ -z "$PLAN_CHANGES" ]; then
		PLAN_ACTION=current
	elif [ "${FORCE:-}" = 1 ]; then
		PLAN_ACTION=replace
	else
		PLAN_ACTION=sidecar
	fi
}

plan_check_widening() {
	[ "${CUR_PRESENT:-}" = 1 ] || return 0
	for _w in "pop3 ${CUR_LISTEN:-} $PLAN_LISTEN" "smtp ${CUR_SMTP_LISTEN:-} $PLAN_SMTP_LISTEN"; do
		# shellcheck disable=SC2086
		set -- $_w
		[ $# -eq 3 ] || continue
		[ -n "$2" ] || continue
		addr_widens "$2" "$3" || continue
		if [ "${ALLOW_WIDEN:-}" = 1 ]; then
			finding WARN "widen-$1" \
				"--allow-widen: $1 moves from $2 ($(addr_reach "$2")) to $3 ($(addr_reach "$3"))"
		else
			finding BLOCK "widen-$1" \
				"$1 would move from $2 ($(addr_reach "$2")) to $3 ($(addr_reach "$3")) — refusing to expose it further; pass --allow-widen if that is genuinely the intent"
		fi
	done
}

plan_check_smtp() {
	if [ "${CUR_PRESENT:-}" = 1 ] && [ -n "${CUR_SMTP_LISTEN:-}" ] && [ -z "$PLAN_SMTP_LISTEN" ]; then
		finding BLOCK drop-smtp \
			"this machine serves SMTP submission on ${CUR_SMTP_LISTEN} and the plan has no POPCORN_SMTP_LISTEN — that removes outgoing mail, not just a setting; edit the unit by hand if you mean it"
	fi
}

plan_check_tls() {
	# Braces matter: && and || are left-associative and equal-precedence in
	# sh, so the ungrouped form of this test quietly means something else.
	if [ -n "$PLAN_TLS_CERT$PLAN_TLS_KEY" ] &&
		{ [ -z "$PLAN_TLS_CERT" ] || [ -z "$PLAN_TLS_KEY" ]; }; then
		# main.go: `if certPath != "" && keyPath != ""`. Half a pair is not
		# a half-secure server, it is a plaintext one that looks configured.
		finding BLOCK tls-half \
			"only one of POPCORN_TLS_CERT/POPCORN_TLS_KEY is set — popcorn ignores a lone half and serves PLAINTEXT"
		PLAN_TLS_MODE=half
		return 0
	fi

	if [ -n "$PLAN_TLS_CERT" ]; then
		_missing=""
		path_exists "$PLAN_TLS_CERT" || _missing="$PLAN_TLS_CERT"
		path_exists "$PLAN_TLS_KEY" || _missing="${_missing:+$_missing }$PLAN_TLS_KEY"
		if [ -n "$_missing" ]; then
			# tls.LoadX509KeyPair -> log.Fatalf("tls: %v") in main.go, so
			# this is not a downgrade to plaintext: the process exits
			# before it listens, and the service manager restarts it
			# forever (launchd KeepAlive, systemd Restart=on-failure).
			finding BLOCK tls-missing \
				"TLS path does not exist: $_missing — popcorn exits at startup (log.Fatalf in cmd/popcorn/main.go) and the service manager will crash-loop it"
			PLAN_TLS_MODE=broken
			return 0
		fi
		PLAN_TLS_MODE=tls
		return 0
	fi

	PLAN_TLS_MODE=plaintext
	_reach=$(addr_rank "$PLAN_LISTEN")
	if [ -n "$PLAN_SMTP_LISTEN" ] && [ "$(addr_rank "$PLAN_SMTP_LISTEN")" -gt "$_reach" ]; then
		_reach=$(addr_rank "$PLAN_SMTP_LISTEN")
	fi
	if [ "$_reach" -ge 2 ] && [ "${ALLOW_PLAINTEXT:-}" != 1 ]; then
		finding BLOCK plaintext-public \
			"no TLS on a $(addr_reach "$PLAN_LISTEN") address — app-password tokens would cross the wire in clear text; configure certs, bind somewhere private, or pass --allow-plaintext"
	elif [ "$_reach" -ge 2 ]; then
		finding WARN plaintext-public \
			"--allow-plaintext: tokens travel in clear text on a $(addr_reach "$PLAN_LISTEN") address"
	else
		finding WARN plaintext-private \
			"no TLS: app-password tokens cross the wire in clear text — tolerable only because the bind is $(addr_reach "$PLAN_LISTEN"), where the hop is either local or already WireGuard-encrypted"
	fi
}

# ── standalone mode ─────────────────────────────────────────────────────────
case "${0##*/}" in
plan.sh)
	popcorn_plan
	printf 'program=%s\n' "$PLAN_PROGRAM"
	printf 'listen=%s\n' "$PLAN_LISTEN"
	printf 'smtp_listen=%s\n' "$PLAN_SMTP_LISTEN"
	printf 'tls_cert=%s\n' "$PLAN_TLS_CERT"
	printf 'tls_key=%s\n' "$PLAN_TLS_KEY"
	printf 'log=%s\n' "$PLAN_LOG"
	printf 'tls_mode=%s\n' "$PLAN_TLS_MODE"
	printf 'action=%s\n' "$PLAN_ACTION"
	printf '%s' "$PLAN_CHANGES" | while IFS= read -r _l; do
		[ -n "$_l" ] && printf 'change=%s\n' "$_l"
	done
	printf '%s' "$PLAN_FINDINGS" | while IFS= read -r _l; do
		[ -n "$_l" ] && printf 'finding=%s\n' "$_l"
	done
	case $PLAN_ACTION in
	blocked) exit 4 ;;
	sidecar) exit 3 ;;
	*) exit 0 ;;
	esac
	;;
esac
