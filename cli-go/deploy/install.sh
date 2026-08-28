#!/bin/sh
# bullmoose CLI installer — published at https://dl.bullmoose.cc/cli/install.sh
#
#   curl -fsSL https://dl.bullmoose.cc/cli/install.sh | sh
#
# WHY THIS IS SHORTER THAN POPCORN'S BOOTSTRAP
#
#   popcorn's installer plans, prints, and asks one honest y/N — because it
#   writes a service unit, picks listen addresses and restarts a daemon, and
#   none of that is implied by piping a URL to sh.
#
#   This places ONE FILE and changes nothing else. No service, no config, no
#   network listener, no daemon. Running this IS the consent for that, so
#   there is no question worth asking — a prompt here would be theatre, and
#   theatre teaches people to say y without reading.
#
#   What it will NOT do without being asked: edit your shell profile. If the
#   install directory is not on PATH it prints the line to add and leaves the
#   editing to you. A tool that silently rewrites ~/.zshrc during an install
#   has done something you did not ask for.
#
# THE VERIFY IS NOT OPTIONAL. If neither sha256sum nor shasum exists, this
# refuses rather than installing unverified bytes. "Probably fine" is not a
# state a downloaded binary can be in.
#
# Options after `sh -s --`:
#   --version vX.Y.Z   install a specific release instead of latest
#   --bin-dir DIR      where to place it (default: $HOME/bin)
# Environment: BULLMOOSE_DL_BASE, BULLMOOSE_VERSION, BULLMOOSE_BIN_DIR
set -eu

BASE=${BULLMOOSE_DL_BASE:-https://dl.bullmoose.cc/cli}
VERSION=${BULLMOOSE_VERSION:-}
BIN_DIR=${BULLMOOSE_BIN_DIR:-$HOME/bin}

while [ $# -gt 0 ]; do
	case $1 in
	--version)
		[ $# -ge 2 ] || { echo "bullmoose: --version needs a value" >&2; exit 2; }
		VERSION=$2
		shift
		;;
	--bin-dir)
		[ $# -ge 2 ] || { echo "bullmoose: --bin-dir needs a value" >&2; exit 2; }
		BIN_DIR=$2
		shift
		;;
	-h | --help)
		echo "usage: curl -fsSL $BASE/install.sh | sh -s -- [--version vX.Y.Z] [--bin-dir DIR]"
		exit 0
		;;
	*)
		echo "bullmoose: unknown option $1" >&2
		exit 2
		;;
	esac
	shift
done

case $(uname -s) in
Darwin) OS=darwin ;;
Linux) OS=linux ;;
*)
	# Windows releases exist (bullmoose_<v>_windows_amd64.exe) but a
	# curl-pipe-sh flow is not how anyone installs on Windows, so say where
	# the file is rather than pretending this script can finish the job.
	echo "bullmoose: no curl|sh install for $(uname -s)." >&2
	echo "  Windows builds are published at $BASE/<version>/bullmoose_<version>_windows_amd64.exe" >&2
	echo "  (current version: $BASE/latest.txt)" >&2
	exit 1
	;;
esac
case $(uname -m) in
arm64 | aarch64) ARCH=arm64 ;;
x86_64 | amd64) ARCH=amd64 ;;
*)
	echo "bullmoose: unsupported architecture $(uname -m) — releases cover arm64 and amd64" >&2
	exit 1
	;;
esac

command -v curl >/dev/null 2>&1 || { echo "bullmoose: curl is required" >&2; exit 1; }

if [ -z "$VERSION" ]; then
	VERSION=$(curl -fsSL "$BASE/latest.txt") || {
		echo "bullmoose: could not read $BASE/latest.txt" >&2
		exit 1
	}
fi
# `latest.txt` is written with no trailing newline, but a hand-passed
# --version or a re-published pointer could carry one, and a stray \r from a
# Windows editor would build a URL that 404s with no hint why.
VERSION=$(printf '%s' "$VERSION" | tr -d ' \t\r\n')
case $VERSION in
v*) ;;
*) VERSION="v$VERSION" ;;
esac

ASSET="bullmoose_${VERSION}_${OS}_${ARCH}"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/bullmoose-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

echo "bullmoose $VERSION ($OS/$ARCH) from $BASE"
curl -fsSL -o "$TMP/$ASSET" "$BASE/$VERSION/$ASSET" || {
	echo "bullmoose: $VERSION has no build for $OS/$ARCH ($BASE/$VERSION/$ASSET)" >&2
	exit 1
}
curl -fsSL -o "$TMP/checksums.txt" "$BASE/$VERSION/checksums.txt"

# Verify BEFORE anything is placed. The grep is anchored to the asset name so
# a checksums file listing five platforms verifies the one we fetched, and an
# empty match is a failure rather than a vacuous pass.
LINE=$(grep " ${ASSET}\$" "$TMP/checksums.txt" || true)
[ -n "$LINE" ] || {
	echo "bullmoose: $ASSET is not listed in checksums.txt — refusing to install unverified bytes" >&2
	exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
	(cd "$TMP" && printf '%s\n' "$LINE" | sha256sum -c - >/dev/null)
elif command -v shasum >/dev/null 2>&1; then
	(cd "$TMP" && printf '%s\n' "$LINE" | shasum -a 256 -c - >/dev/null)
else
	echo "bullmoose: neither sha256sum nor shasum found — refusing to install unverified bytes" >&2
	exit 1
fi
echo "checksum: OK"

DEST="$BIN_DIR/bullmoose"
PREVIOUS=''
if [ -x "$DEST" ]; then
	# Say what is being replaced. An installer that silently overwrites a
	# working binary is indistinguishable from one that did nothing.
	PREVIOUS=$("$DEST" version 2>/dev/null | head -1 || true)
fi

mkdir -p "$BIN_DIR"
chmod +x "$TMP/$ASSET"
# Move into place via a temp name in the SAME directory, so an interrupted
# install cannot leave a half-written binary at the path people run.
cp "$TMP/$ASSET" "$DEST.new"
mv "$DEST.new" "$DEST"

# macOS quarantine: curl does not usually set this, but a proxy, a wrapper,
# or a re-download through a browser can — and the failure it produces
# ("cannot be opened because the developer cannot be verified") reads like a
# broken binary. Clearing it is a no-op when it was never set.
if [ "$OS" = darwin ] && command -v xattr >/dev/null 2>&1; then
	xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

[ -n "$PREVIOUS" ] && echo "replaced: $PREVIOUS"
echo "installed: $DEST"
"$DEST" version || {
	echo "bullmoose: the installed binary did not run — the download may be for the wrong platform" >&2
	exit 1
}

# PATH advice, not PATH surgery.
case ":${PATH}:" in
*":$BIN_DIR:"*) ;;
*)
	echo ''
	echo "$BIN_DIR is not on your PATH. Add it:"
	echo "  export PATH=\"$BIN_DIR:\$PATH\""
	;;
esac

cat <<'NEXT'

Next: point it at a domain on your Cloudflare account.

  export CLOUDFLARE_API_TOKEN=…                  # scopes: docs/install-cloud.md
  bullmoose cloud plan    --zone example.com     # read-only — see everything first
  bullmoose cloud install --zone example.com     # the same plan, one yes, then apply

`cloud plan` prints every resource by name, refusals first, and creates
nothing. There is no build step and no toolchain to install.
NEXT
