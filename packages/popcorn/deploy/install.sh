#!/bin/sh
# popcorn installer — detects the platform branch, builds the common core.
#   requires: go >= 1.23 on PATH
#   usage: sh deploy/install.sh [options]     (run from packages/popcorn)
#
# This installer assumes the machine may already be running popcorn, and that
# the running configuration is more trustworthy than anything in this repo.
#
# It used to assume the opposite: it copied deploy/cc.bullmoose.popcorn.plist
# over ~/Library/LaunchAgents/ unconditionally. On the one machine popcorn was
# actually deployed to, that single `cp` would have moved POP3 from a
# tailnet-only address onto every interface, deleted the SMTP submission face
# (it is conditional on POPCORN_SMTP_LISTEN, which the template omitted), and
# repointed TLS at /usr/local/etc/popcorn/, where there are no certs — then
# printed "installed".
#
# So: the template is a starting point for a machine with no answer yet, never
# a correction to a machine that already has one. Every setting resolves
#
#     your --flag  >  what this machine already runs  >  the repo template
#
# an existing unit file is never overwritten without --force, and a plan that
# would widen a listen address, drop the SMTP face or point TLS at a path that
# does not exist is refused outright. The decisions all live in lib/plan.sh,
# which writes nothing and is exercised by deploy/plan_test.go.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PKG=$(CDPATH='' cd -- "$HERE/.." && pwd)

usage() {
	cat <<'USAGE'
popcorn installer — safe on a machine that already runs popcorn.

  sh deploy/install.sh [options]        (from packages/popcorn)

  --check, --dry-run   print the plan and exit; writes nothing, builds nothing
  --render             print the unit file that would be written; writes nothing
  --force              replace an existing unit (backed up to <unit>.bak-<ts>)
  --allow-widen        permit a listen address reachable from further away
  --allow-plaintext    permit no-TLS on a routable address
  --program PATH       install the binary here (default: ~/bin on macOS)
  --binary PATH        install THIS prebuilt binary instead of building from
                       source (the curl2shell bootstrap's door; go not needed)
  --listen ADDR        POPCORN_LISTEN
  --smtp-listen ADDR   POPCORN_SMTP_LISTEN ("off" to ask for no SMTP face)
  --tls-cert PATH      POPCORN_TLS_CERT   (with --tls-key; popcorn needs both)
  --tls-key PATH       POPCORN_TLS_KEY
  --log PATH           StandardOutPath/StandardErrorPath (macOS)

exit: 0 applied or nothing to do · 2 usage · 3 refused, an existing unit would
change (re-run with --force) · 4 blocked, the plan is unsafe
USAGE
}

MODE=apply
FORCE=0
ALLOW_WIDEN=0
ALLOW_PLAINTEXT=0
WANT_PROGRAM=''
WANT_BINARY=''
WANT_LISTEN=''
WANT_SMTP_LISTEN=''
WANT_TLS_CERT=''
WANT_TLS_KEY=''
WANT_LOG=''

need_arg() {
	[ $# -ge 2 ] || {
		printf 'popcorn: %s needs a value\n' "$1" >&2
		exit 2
	}
}

while [ $# -gt 0 ]; do
	case $1 in
	--check | --dry-run) MODE=check ;;
	--render) MODE=render ;;
	--force) FORCE=1 ;;
	--allow-widen) ALLOW_WIDEN=1 ;;
	--allow-plaintext) ALLOW_PLAINTEXT=1 ;;
	--program)
		need_arg "$@"
		WANT_PROGRAM=$2
		shift
		;;
	--binary)
		need_arg "$@"
		WANT_BINARY=$2
		shift
		;;
	--listen)
		need_arg "$@"
		WANT_LISTEN=$2
		shift
		;;
	--smtp-listen)
		need_arg "$@"
		WANT_SMTP_LISTEN=$2
		shift
		;;
	--tls-cert)
		need_arg "$@"
		WANT_TLS_CERT=$2
		shift
		;;
	--tls-key)
		need_arg "$@"
		WANT_TLS_KEY=$2
		shift
		;;
	--log)
		need_arg "$@"
		WANT_LOG=$2
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'popcorn: unknown option %s (see --help)\n' "$1" >&2
		exit 2
		;;
	esac
	shift
done

. "$HERE/lib/plan.sh"

OS=$(uname -s)
ARCH=$(uname -m)
LABEL=cc.bullmoose.popcorn

# Test hook: plan or render the *other* platform's branch from this machine,
# so the systemd side can be inspected without a VPS. Refused for anything
# that writes — it can only ever produce a report.
if [ -n "${POPCORN_FAKE_OS:-}" ]; then
	case $MODE in
	check | render) OS=$POPCORN_FAKE_OS ;;
	*)
		printf 'popcorn: POPCORN_FAKE_OS is only honoured with --check/--render\n' >&2
		exit 2
		;;
	esac
fi

# ── what this machine already runs ──────────────────────────────────────────
CUR_PRESENT=0
CUR_PROGRAM=''
CUR_LISTEN=''
CUR_SMTP_LISTEN=''
CUR_TLS_CERT=''
CUR_TLS_KEY=''
CUR_LOG=''
CUR_EXTRA_ENV=''
CUR_EXTRA_KEYS=''
ENVFILE=''

case $OS in
Darwin)
	UNIT="$HOME/Library/LaunchAgents/$LABEL.plist"
	TEMPLATE="$HERE/$LABEL.plist"
	DEF_PROGRAM="$HOME/bin/popcorn"
	DEF_LISTEN='127.0.0.1:9995'
	DEF_SMTP_LISTEN='127.0.0.1:9587'
	DEF_TLS_CERT="$HOME/.popcorn/cert.pem"
	DEF_TLS_KEY="$HOME/.popcorn/key.pem"
	DEF_LOG="$HOME/.popcorn/popcorn.log"
	if [ -f "$UNIT" ]; then
		CUR_PRESENT=1
		CUR_PROGRAM=$(plist_program "$UNIT")
		CUR_LISTEN=$(plist_env "$UNIT" POPCORN_LISTEN)
		CUR_SMTP_LISTEN=$(plist_env "$UNIT" POPCORN_SMTP_LISTEN)
		CUR_TLS_CERT=$(plist_env "$UNIT" POPCORN_TLS_CERT)
		CUR_TLS_KEY=$(plist_env "$UNIT" POPCORN_TLS_KEY)
		CUR_LOG=$(plist_log "$UNIT")
		# Anything else the operator set stays set. Without this, --force
		# would render a unit from the template and quietly drop, say, a
		# POPCORN_MAX_MESSAGES someone tuned two years ago.
		for k in $(plist_env_keys "$UNIT"); do
			case $k in
			POPCORN_LISTEN | POPCORN_SMTP_LISTEN | POPCORN_TLS_CERT | POPCORN_TLS_KEY) continue ;;
			esac
			CUR_EXTRA_KEYS="${CUR_EXTRA_KEYS:+$CUR_EXTRA_KEYS }$k"
			CUR_EXTRA_ENV="$CUR_EXTRA_ENV        <key>$k</key><string>$(plist_env "$UNIT" "$k")</string>
"
		done
	fi
	;;
Linux)
	UNIT=/etc/systemd/system/popcorn.service
	ENVFILE=/etc/popcorn/env
	TEMPLATE="$HERE/popcorn.service"
	DEF_PROGRAM=/usr/local/bin/popcorn
	DEF_LISTEN='127.0.0.1:995'
	DEF_SMTP_LISTEN='127.0.0.1:587'
	DEF_TLS_CERT=/etc/popcorn/cert.pem
	DEF_TLS_KEY=/etc/popcorn/key.pem
	DEF_LOG='' # journald owns the log; there is no path here to get wrong
	if [ -f "$UNIT" ] || [ -f "$ENVFILE" ]; then
		CUR_PRESENT=1
		CUR_PROGRAM=$(systemd_exec "$UNIT")
		CUR_LISTEN=$(envfile_get "$ENVFILE" POPCORN_LISTEN)
		CUR_SMTP_LISTEN=$(envfile_get "$ENVFILE" POPCORN_SMTP_LISTEN)
		CUR_TLS_CERT=$(envfile_get "$ENVFILE" POPCORN_TLS_CERT)
		CUR_TLS_KEY=$(envfile_get "$ENVFILE" POPCORN_TLS_KEY)
	fi
	;;
*)
	printf 'popcorn: unsupported OS %s — use deploy/Dockerfile\n' "$OS" >&2
	exit 1
	;;
esac

popcorn_plan

# ── render ──────────────────────────────────────────────────────────────────
# A token whose value is empty is deleted rather than blanked: an empty
# <string> means "unset" to popcorn, but reads as "configured" to a human
# skimming the plist.
sed_token() { # TOKEN VALUE -> a sed expression
	if [ -n "$2" ]; then printf 's|%s|%s|g' "$1" "$2"; else printf '/%s/d' "$1"; fi
}

render_unit() {
	case $OS in
	Darwin)
		sed \
			-e '/<!-- template-only:/,/-->/d' \
			-e "$(sed_token __POPCORN_PROGRAM__ "$PLAN_PROGRAM")" \
			-e "$(sed_token __POPCORN_LISTEN__ "$PLAN_LISTEN")" \
			-e "$(sed_token __POPCORN_SMTP_LISTEN__ "$PLAN_SMTP_LISTEN")" \
			-e "$(sed_token __POPCORN_TLS_CERT__ "$PLAN_TLS_CERT")" \
			-e "$(sed_token __POPCORN_TLS_KEY__ "$PLAN_TLS_KEY")" \
			-e "$(sed_token __POPCORN_LOG__ "$PLAN_LOG")" \
			"$TEMPLATE" |
			# The extras arrive through the environment, not -v: awk -v
			# cannot carry a multi-line value (BSD awk rejects it outright).
			POPCORN_RENDER_EXTRA_ENV="$CUR_EXTRA_ENV" awk '
				/<key>EnvironmentVariables<\/key>/ { inenv = 1 }
				inenv && !done && /<\/dict>/ {
					printf "%s", ENVIRON["POPCORN_RENDER_EXTRA_ENV"]
					done = 1
				}
				{ print }
			'
		;;
	Linux)
		# The unit itself carries no addresses — /etc/popcorn/env does — so
		# the only thing to substitute is the binary this machine uses.
		sed "s|^ExecStart=.*|ExecStart=$PLAN_PROGRAM|" "$TEMPLATE"
		;;
	esac
}

render_envfile() { # Linux only
	printf '# popcorn — written once by deploy/install.sh. Edit freely: the\n'
	printf '# installer never rewrites this file in place.\n'
	printf 'POPCORN_LISTEN=%s\n' "$PLAN_LISTEN"
	if [ -n "$PLAN_SMTP_LISTEN" ]; then
		printf 'POPCORN_SMTP_LISTEN=%s\n' "$PLAN_SMTP_LISTEN"
	fi
	if [ -n "$PLAN_TLS_CERT" ]; then
		printf 'POPCORN_TLS_CERT=%s\nPOPCORN_TLS_KEY=%s\n' "$PLAN_TLS_CERT" "$PLAN_TLS_KEY"
	else
		printf '#POPCORN_TLS_CERT=%s\n#POPCORN_TLS_KEY=%s\n' "$DEF_TLS_CERT" "$DEF_TLS_KEY"
	fi
	printf '# Widen POPCORN_LISTEN to :995 only once TLS is real: popcorn speaks\n'
	printf '# implicit TLS and has no STARTTLS, so with no certs it is plaintext.\n'
}

if [ "$MODE" = render ]; then
	render_unit
	if [ "$OS" = Linux ]; then
		printf '\n# ---- %s ----\n' "$ENVFILE"
		render_envfile
	fi
	exit 0
fi

# ── report ──────────────────────────────────────────────────────────────────
note() { # CUR PLAN -> new / keep / CHANGE from …
	if [ "$CUR_PRESENT" != 1 ]; then
		printf 'new'
	elif [ "$1" = "$2" ]; then
		printf 'keep'
	else
		printf 'CHANGE from %s' "${1:-(unset)}"
	fi
}

row() { printf '  %-12s %-38s %s\n' "$1" "${2:-(unset)}" "$3"; }

printf '\npopcorn install plan — %s/%s\n' "$OS" "$ARCH"
if [ "$CUR_PRESENT" = 1 ]; then
	row unit "$UNIT" 'exists — this machine is already configured'
else
	row unit "$UNIT" 'not present — fresh install'
fi
row binary "$PLAN_PROGRAM" "$(note "$CUR_PROGRAM" "$PLAN_PROGRAM")"
row POP3 "$PLAN_LISTEN" "$(addr_reach "$PLAN_LISTEN") · $(note "$CUR_LISTEN" "$PLAN_LISTEN")"
if [ -n "$PLAN_SMTP_LISTEN" ]; then
	row SMTP "$PLAN_SMTP_LISTEN" "$(addr_reach "$PLAN_SMTP_LISTEN") · $(note "$CUR_SMTP_LISTEN" "$PLAN_SMTP_LISTEN")"
else
	row SMTP '(off)' "no submission face · $(note "$CUR_SMTP_LISTEN" '')"
fi
row tls-cert "$PLAN_TLS_CERT" "$(note "$CUR_TLS_CERT" "$PLAN_TLS_CERT")"
row tls-key "$PLAN_TLS_KEY" "$(note "$CUR_TLS_KEY" "$PLAN_TLS_KEY")"
row tls-mode "$PLAN_TLS_MODE" ''
if [ -n "$PLAN_LOG" ]; then
	row log "$PLAN_LOG" "$(note "$CUR_LOG" "$PLAN_LOG")"
fi
if [ "$OS" = Linux ]; then
	row config "$ENVFILE" 'holds the POPCORN_* settings'
fi
if [ -n "$CUR_EXTRA_KEYS" ]; then
	row carried "$CUR_EXTRA_KEYS" 'set on this machine, copied over as they are'
fi

if [ -n "$PLAN_FINDINGS" ]; then
	printf '\n'
	printf '%s' "$PLAN_FINDINGS" | while IFS= read -r line; do
		if [ -n "$line" ]; then printf '  %s\n' "$line"; fi
	done
fi

if [ -n "$PLAN_CHANGES" ]; then
	printf '\nwould change:\n'
	printf '%s' "$PLAN_CHANGES" | while IFS= read -r line; do
		if [ -n "$line" ]; then printf '  %s\n' "$line"; fi
	done
fi

printf '\n'
case $PLAN_ACTION in
install) printf 'action: install the binary, write %s, start the service\n' "$UNIT" ;;
current) printf 'action: the unit already matches the plan — refresh the binary, leave %s untouched\n' "$UNIT" ;;
replace) printf 'action: --force — back up and replace %s\n' "$UNIT" ;;
sidecar) printf 'action: REFUSE — %s exists and the plan would change it\n' "$UNIT" ;;
blocked) printf 'action: BLOCKED — see above; nothing will be written\n' ;;
esac

if [ "$MODE" = check ]; then
	printf '(--check: nothing was written)\n'
	case $PLAN_ACTION in
	blocked) exit 4 ;;
	sidecar) exit 3 ;;
	esac
	exit 0
fi

if [ "$PLAN_ACTION" = blocked ]; then
	exit 4
fi

# ── refusal: render beside the original, change nothing else ────────────────
# The sidecar deliberately does NOT end in .plist (or .service): launchd loads
# every *.plist in ~/Library/LaunchAgents at login, so a "harmless" copy with
# that extension would quietly become a second live job.
write_sidecar() { # RENDERER TARGET
	_side="$2.new"
	if ! "$1" >"$_side" 2>/dev/null; then
		_side="${TMPDIR:-/tmp}/$(basename "$2").new"
		"$1" >"$_side"
	fi
	printf '  %s\n' "$_side"
}

if [ "$PLAN_ACTION" = sidecar ]; then
	printf '\nnothing was installed. The unit this would have written is in:\n'
	write_sidecar render_unit "$UNIT"
	if [ "$OS" = Linux ] && [ ! -f "$ENVFILE" ]; then
		write_sidecar render_envfile "$ENVFILE"
	fi
	printf '\nreview:   diff -u %s %s.new\n' "$UNIT" "$UNIT"
	printf 'accept:   sh deploy/install.sh --force    (backs the old one up first)\n'
	printf 'keep mine: rm %s.new\n' "$UNIT"
	exit 3
fi

# ── apply ───────────────────────────────────────────────────────────────────
command -v go >/dev/null || {
	printf 'popcorn: go toolchain required to build (https://go.dev/dl)\n' >&2
	exit 1
}

priv() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

install_to() { # SRC DEST — sudo only when the destination actually needs it
	_dir=$(dirname "$2")
	if [ -w "$_dir" ] || { [ ! -d "$_dir" ] && [ -w "$(dirname "$_dir")" ]; }; then
		mkdir -p "$_dir"
		install -m 755 "$1" "$2"
	else
		priv mkdir -p "$_dir"
		priv install -m 755 "$1" "$2"
	fi
}

write_unit() { # PATH
	if [ -f "$1" ]; then
		_bak="$1.bak-$(date +%Y%m%d%H%M%S)"
		if [ -w "$(dirname "$1")" ]; then cp "$1" "$_bak"; else priv cp "$1" "$_bak"; fi
		printf 'backed up: %s\n' "$_bak"
	fi
	if [ -w "$(dirname "$1")" ]; then
		render_unit >"$1"
	else
		render_unit | priv tee "$1" >/dev/null
	fi
	printf 'unit: %s\n' "$1"
}

if [ -n "$WANT_BINARY" ]; then
	# A prebuilt binary (the release pipeline's, checksum-verified by the
	# bootstrap that handed it to us). Refuse a path that is not a file —
	# installing nothing "successfully" is the worst outcome an installer has.
	[ -f "$WANT_BINARY" ] || {
		printf 'popcorn: --binary %s is not a file\n' "$WANT_BINARY" >&2
		exit 2
	}
	printf '\nusing prebuilt binary…\n'
	install_to "$WANT_BINARY" "$PLAN_PROGRAM"
else
	printf '\nbuilding…\n'
	(cd "$PKG" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/popcorn ./cmd/popcorn)
	install_to "$PKG/dist/popcorn" "$PLAN_PROGRAM"
fi
printf 'binary: %s\n' "$PLAN_PROGRAM"

case $OS in
Darwin)
	# launchd refuses to spawn the job if it cannot open StandardOutPath, so
	# the directory has to exist before the plist points at it. An existing
	# unit may name somewhere only root can create.
	if [ -n "$PLAN_LOG" ]; then
		mkdir -p "$(dirname "$PLAN_LOG")" 2>/dev/null || priv mkdir -p "$(dirname "$PLAN_LOG")"
	fi
	if [ "$PLAN_ACTION" = current ]; then
		# The unit is already right; only the binary moved. Restart in place
		# so the existing plist — its log paths, its companion cert-renewal
		# job, any key this installer does not model — survives untouched.
		if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
			launchctl kickstart -k "gui/$(id -u)/$LABEL"
			printf 'restarted: %s (unit unchanged)\n' "$LABEL"
		else
			launchctl load "$UNIT"
			printf 'loaded: %s (unit unchanged)\n' "$LABEL"
		fi
	else
		mkdir -p "$HOME/Library/LaunchAgents"
		write_unit "$UNIT"
		launchctl unload "$UNIT" 2>/dev/null || true
		launchctl load "$UNIT"
		printf 'loaded: %s\n' "$LABEL"
	fi
	;;
Linux)
	priv mkdir -p /etc/popcorn
	if [ -f "$ENVFILE" ]; then
		printf 'config: %s left exactly as it is\n' "$ENVFILE"
	else
		render_envfile | priv tee "$ENVFILE" >/dev/null
		printf 'config: %s written\n' "$ENVFILE"
	fi
	if [ "$PLAN_ACTION" != current ]; then write_unit "$UNIT"; fi
	priv systemctl daemon-reload
	priv systemctl enable popcorn
	priv systemctl restart popcorn
	printf 'service: popcorn (systemctl status popcorn)\n'
	;;
esac

printf '\npopcorn is up: POP3 %s' "$PLAN_LISTEN"
if [ -n "$PLAN_SMTP_LISTEN" ]; then printf ', SMTP %s' "$PLAN_SMTP_LISTEN"; fi
printf ', TLS %s.\n' "$PLAN_TLS_MODE"
