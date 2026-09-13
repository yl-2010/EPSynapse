#!/bin/bash
# Copy EPSynapse LaunchAgents into ~/Library/LaunchAgents and enable them
# so Express + the tunnel start at login. Same pattern as the other APIs
# on this Mac. Do not kickstart; this must not bounce a live process.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

mkdir -p "$DEST"

for label in com.jype.server com.jype.cloudflared; do
  cp "${SRC}/${label}.plist" "${DEST}/${label}.plist"
  launchctl enable "${DOMAIN}/${label}"
  if launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; then
    echo "${label}: enabled (already loaded)"
  else
    launchctl bootstrap "${DOMAIN}" "${DEST}/${label}.plist"
    echo "${label}: bootstrapped and enabled"
  fi
done

echo "EPSynapse starts at login. A reboot needs no extra commands."
