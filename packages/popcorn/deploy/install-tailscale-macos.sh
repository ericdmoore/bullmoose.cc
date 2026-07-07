#!/bin/sh
# popcorn tailscale variant — macOS (launchd, user agent, no sudo).
#
# Binds ONLY to the node's tailscale IP: nothing listens on the LAN or
# the public internet, so no port-forward, no DDNS, no NAT surgery.
# TLS: `tailscale cert` (Let's Encrypt for <node>.<tailnet>.ts.net) when
# the tailnet has HTTPS Certificates enabled (admin console → DNS);
# otherwise runs WITHOUT app-layer TLS — acceptable ONLY here because
# every tailnet packet is already WireGuard-encrypted end-to-end.
#
# Idempotent: re-run after enabling HTTPS certs to upgrade to TLS.
# usage: sh deploy/install-tailscale-macos.sh   (from packages/popcorn)
set -eu

TS=$(command -v tailscale || echo /opt/homebrew/bin/tailscale)
[ -x "$TS" ] || { echo "tailscale CLI not found"; exit 1; }

TS_IP=$($TS ip -4 | head -1)
DNS_NAME=$($TS status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
PORT="${POPCORN_PORT:-9995}"
CONF="$HOME/.popcorn"
mkdir -p "$CONF" "$HOME/bin"

# Binary: local go build, or a prebuilt dist/ artifact for this platform.
if command -v go >/dev/null; then
  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$HOME/bin/popcorn" ./cmd/popcorn
elif [ -f "dist/popcorn-$(uname -s | tr A-Z a-z)-$(uname -m | sed s/x86_64/amd64/)" ]; then
  install -m 755 "dist/popcorn-$(uname -s | tr A-Z a-z)-$(uname -m | sed s/x86_64/amd64/)" "$HOME/bin/popcorn"
elif [ -f "$HOME/bin/popcorn" ]; then
  echo "using existing $HOME/bin/popcorn"
else
  echo "no go toolchain and no prebuilt binary — run 'make all' somewhere and copy dist/ here"
  exit 1
fi

# TLS via tailscale cert, if the tailnet allows it.
TLS_ENV=""
if $TS cert --cert-file "$CONF/cert.pem" --key-file "$CONF/key.pem" "$DNS_NAME" 2>/dev/null; then
  echo "TLS: minted cert for $DNS_NAME"
  TLS_ENV="<key>POPCORN_TLS_CERT</key><string>$CONF/cert.pem</string>
        <key>POPCORN_TLS_KEY</key><string>$CONF/key.pem</string>"
  # Weekly renewal (certs last 90 days) + service restart.
  cat > "$CONF/renew.sh" <<RENEW
#!/bin/sh
$TS cert --cert-file "$CONF/cert.pem" --key-file "$CONF/key.pem" "$DNS_NAME" && \
  launchctl kickstart -k "gui/\$(id -u)/cc.bullmoose.popcorn"
RENEW
  chmod +x "$CONF/renew.sh"
else
  echo "TLS: tailnet has HTTPS certs DISABLED — running plaintext-over-WireGuard."
  echo "     Enable at https://login.tailscale.com/admin/dns then re-run this script."
fi

PLIST="$HOME/Library/LaunchAgents/cc.bullmoose.popcorn.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>cc.bullmoose.popcorn</string>
    <key>ProgramArguments</key>
    <array><string>$HOME/bin/popcorn</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>POPCORN_LISTEN</key><string>$TS_IP:$PORT</string>
        $TLS_ENV
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$CONF/popcorn.log</string>
    <key>StandardErrorPath</key><string>$CONF/popcorn.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

if [ -f "$CONF/renew.sh" ]; then
  RPLIST="$HOME/Library/LaunchAgents/cc.bullmoose.popcorn.certrenew.plist"
  cat > "$RPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>cc.bullmoose.popcorn.certrenew</string>
    <key>ProgramArguments</key>
    <array><string>/bin/sh</string><string>$CONF/renew.sh</string></array>
    <key>StartCalendarInterval</key>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>4</integer></dict>
</dict>
</plist>
EOF
  launchctl unload "$RPLIST" 2>/dev/null || true
  launchctl load "$RPLIST"
fi

echo
echo "popcorn (tailscale variant) is up:"
echo "  server:   $DNS_NAME  (tailnet-only: $TS_IP)"
echo "  port:     $PORT"
echo "  TLS:      $([ -n "$TLS_ENV" ] && echo "ts.net cert (auto-renews weekly)" || echo "none — WireGuard only")"
echo "  logs:     $CONF/popcorn.log"
