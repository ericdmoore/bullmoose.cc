#!/bin/sh
# popcorn installer — detects the platform branch, builds the common core.
#   requires: go >= 1.23 on PATH
#   usage: sh deploy/install.sh          (run from packages/popcorn)
set -eu

OS=$(uname -s)
ARCH=$(uname -m)
echo "popcorn install: $OS/$ARCH"

command -v go >/dev/null || { echo "go toolchain required (https://go.dev/dl)"; exit 1; }

# Common core — one static binary regardless of platform.
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o popcorn ./cmd/popcorn

case "$OS" in
  Darwin)
    sudo install -m 755 popcorn /usr/local/bin/popcorn
    mkdir -p ~/Library/LaunchAgents
    cp deploy/cc.bullmoose.popcorn.plist ~/Library/LaunchAgents/
    launchctl unload ~/Library/LaunchAgents/cc.bullmoose.popcorn.plist 2>/dev/null || true
    launchctl load ~/Library/LaunchAgents/cc.bullmoose.popcorn.plist
    echo "installed: launchd agent cc.bullmoose.popcorn (port 9995 by default)"
    echo "edit ~/Library/LaunchAgents/cc.bullmoose.popcorn.plist for TLS cert paths"
    ;;
  Linux)
    sudo install -m 755 popcorn /usr/local/bin/popcorn
    sudo mkdir -p /etc/popcorn
    [ -f /etc/popcorn/env ] || printf 'POPCORN_LISTEN=:995\n#POPCORN_TLS_CERT=/etc/popcorn/cert.pem\n#POPCORN_TLS_KEY=/etc/popcorn/key.pem\n' | sudo tee /etc/popcorn/env >/dev/null
    sudo cp deploy/popcorn.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now popcorn
    echo "installed: systemd service 'popcorn' (config: /etc/popcorn/env)"
    ;;
  *)
    echo "unsupported OS: $OS — use deploy/Dockerfile"
    exit 1
    ;;
esac
