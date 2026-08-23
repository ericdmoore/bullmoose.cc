#!/bin/sh
# popcorn bootstrap — published at https://dl.bullmoose.cc/popcorn/install.sh
#
#   curl -fsSL https://dl.bullmoose.cc/popcorn/install.sh | sh
#
# THE CONSENT MODEL, stated where the consent happens:
#
#   Running this script IS consent to download the latest popcorn release for
#   this platform, verify its checksum, and PLACE the binary on this machine.
#   That much happens without asking — piping a URL to sh is that intent.
#
#   Everything beyond placing a file — writing a service unit, restarting a
#   running daemon, choosing listen addresses — is PLANNED first by the full
#   installer (deploy/install.sh, fetched alongside the binary), the plan is
#   printed, and ONE honest y/N gates applying it. Declining still leaves the
#   verified binary in place and prints the exact command to continue later.
#   The planner refuses outright — no prompt can override it — anything that
#   would widen a listen address, drop the SMTP face, or point TLS nowhere.
#
#   The no-questions variant for automation lives at fullmonty.sh: choosing
#   THAT url is the consent the prompt would have asked for. This script also
#   honours `sh -s -- --full-monty` for the same effect.
#
# Options after `sh -s --` pass through to the planner (see its --help):
# --program PATH, --listen ADDR, --force, --check, … plus this script's own:
#   --full-monty         skip the apply prompt (automation)
#   --version vX.Y.Z     install a specific release instead of latest
set -eu

BASE=${POPCORN_DL_BASE:-https://dl.bullmoose.cc/popcorn}
VERSION=${POPCORN_VERSION:-}
FULL_MONTY=0
PROGRAM=''
PASS=''

# A tiny scan: peel off the flags this bootstrap owns, remember --program so
# the decline path knows where "place the bin" means, forward the rest.
while [ $# -gt 0 ]; do
	case $1 in
	--full-monty) FULL_MONTY=1 ;;
	--version)
		[ $# -ge 2 ] || { echo "popcorn: --version needs a value" >&2; exit 2; }
		VERSION=$2
		shift
		;;
	--program)
		[ $# -ge 2 ] || { echo "popcorn: --program needs a value" >&2; exit 2; }
		PROGRAM=$2
		PASS="$PASS --program $2"
		shift
		;;
	*) PASS="$PASS $1" ;;
	esac
	shift
done

case $(uname -s) in
Darwin) OS=darwin ;;
Linux) OS=linux ;;
*)
	echo "popcorn: unsupported OS $(uname -s) — releases cover darwin and linux; build from source: packages/popcorn/deploy/install.sh" >&2
	exit 1
	;;
esac
case $(uname -m) in
arm64 | aarch64) ARCH=arm64 ;;
x86_64 | amd64) ARCH=amd64 ;;
*)
	echo "popcorn: unsupported arch $(uname -m)" >&2
	exit 1
	;;
esac

[ -n "$VERSION" ] || VERSION=$(curl -fsSL "$BASE/latest.txt")
ASSET="popcorn_${VERSION}_${OS}_${ARCH}"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/popcorn-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

echo "popcorn $VERSION ($OS/$ARCH) from $BASE"
curl -fsSL -o "$TMP/$ASSET" "$BASE/$VERSION/$ASSET"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/$VERSION/checksums.txt"

# Verify before anything is placed or run. No tool, no install: an unverified
# binary is not "probably fine", it is unverified.
if command -v sha256sum >/dev/null 2>&1; then
	(cd "$TMP" && grep " ${ASSET}\$" checksums.txt | sha256sum -c - >/dev/null)
elif command -v shasum >/dev/null 2>&1; then
	(cd "$TMP" && grep " ${ASSET}\$" checksums.txt | shasum -a 256 -c - >/dev/null)
else
	echo "popcorn: neither sha256sum nor shasum found — refusing to install unverified bytes" >&2
	exit 1
fi
echo "checksum: OK"
chmod +x "$TMP/$ASSET"

# The planner and its templates travel with the release, so the safety model
# (plan > prompt > refusal) is the version's own, not whatever this URL
# happened to serve last.
curl -fsSL "$BASE/$VERSION/deploy.tar.gz" | tar -xzf - -C "$TMP"
PLANNER="$TMP/deploy/install.sh"
[ -f "$PLANNER" ] || { echo "popcorn: release bundle is missing its installer" >&2; exit 1; }

# The plan, before any question — what would change, in the planner's words.
echo ''
# shellcheck disable=SC2086
sh "$PLANNER" --check --binary "$TMP/$ASSET" $PASS || {
	rc=$?
	# 3 = an existing unit would change and --force was not given. That is a
	# refusal with a documented override, not a failure of this bootstrap.
	[ $rc -eq 3 ] || exit $rc
}

if [ "$FULL_MONTY" -ne 1 ]; then
	printf '\napply this plan? [y/N] '
	# When piped (`curl … | sh`) stdin is the script itself, so ask the tty.
	# Probe by OPENING it, not stat'ing it: `[ -r /dev/tty ]` is true on a
	# device node that cannot actually be opened (cron, CI, a captured
	# session), and a failed read under `set -eu` would kill the script
	# BETWEEN the question and the answer.
	if [ -t 0 ]; then
		read -r answer
	elif (exec </dev/tty) 2>/dev/null; then
		read -r answer </dev/tty
	else
		answer=n
		echo '(no terminal to ask — treating as no)'
	fi
	case $answer in
	y | Y | yes | YES) ;;
	*)
		DEST=${PROGRAM:-"$HOME/bin/popcorn"}
		mkdir -p "$(dirname "$DEST")"
		cp "$TMP/$ASSET" "$DEST"
		echo ''
		echo "declined — no service was touched. The verified binary is placed:"
		echo "  $DEST"
		"$DEST" version || true
		echo "continue later with:"
		echo "  curl -fsSL $BASE/install.sh | sh -s -- --full-monty"
		exit 0
		;;
	esac
fi

echo ''
# shellcheck disable=SC2086
sh "$PLANNER" --binary "$TMP/$ASSET" $PASS
