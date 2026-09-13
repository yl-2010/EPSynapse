#!/usr/bin/env bash
# Writes ~/.cloudflared/config-epsynapse.yml for the existing jype-api tunnel.
# Prerequisites: brew install cloudflare/cloudflare/cloudflared

set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-jype-api}"
API_HOSTNAME="${API_HOSTNAME:-api.epsynapse.com}"
LOCAL_SERVICE="${LOCAL_SERVICE:-http://127.0.0.1:3006}"
CF_DIR="${HOME}/.cloudflared"
# The tunnel lives in the JYPE Cloudflare account. There is no default cert on
# purpose: pointing this at another account's cert (NoteLMs, yanylevin) would
# recreate the tunnel in the wrong place.
CONFIG_OUT="${CONFIG_OUT:-${CF_DIR}/config-epsynapse.yml}"

die() { echo "error: $*" >&2; exit 1; }

command -v cloudflared >/dev/null 2>&1 || die "cloudflared not found. Install: brew install cloudflare/cloudflare/cloudflared"
[[ -n "${TUNNEL_ORIGIN_CERT:-}" ]] || die "Set TUNNEL_ORIGIN_CERT to the JYPE-account cert.pem (cloudflared tunnel login while signed into that account)."
export TUNNEL_ORIGIN_CERT
[[ -f "${TUNNEL_ORIGIN_CERT}" ]] || die "Missing origin cert: ${TUNNEL_ORIGIN_CERT}"

get_tunnel_id_for_name() {
  cloudflared tunnel list -o json 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
raw = json.load(sys.stdin)
rows = raw if isinstance(raw, list) else raw.get('tunnels') or raw.get('result') or []
if not isinstance(rows, list):
    rows = [rows]
for row in rows:
    if not isinstance(row, dict):
        continue
    if row.get('name') == name or row.get('Name') == name:
        print(row.get('id') or row.get('ID') or '')
        break
" "${TUNNEL_NAME}"
}

TUNNEL_ID="$(get_tunnel_id_for_name || true)"
[[ -n "${TUNNEL_ID}" ]] || die "Tunnel ${TUNNEL_NAME} not found. Create with: TUNNEL_ORIGIN_CERT=${TUNNEL_ORIGIN_CERT} cloudflared tunnel create ${TUNNEL_NAME}"

CREDS="${CF_DIR}/${TUNNEL_ID}.json"
[[ -f "${CREDS}" ]] || die "Missing credentials file: ${CREDS}"

cat > "${CONFIG_OUT}" <<EOF
# EPSynapse: dedicated tunnel
# Tunnel: ${TUNNEL_NAME} (${TUNNEL_ID}) → ${LOCAL_SERVICE}

tunnel: ${TUNNEL_ID}
credentials-file: ${CREDS}

ingress:
  - hostname: ${API_HOSTNAME}
    service: ${LOCAL_SERVICE}
  - service: http_status:404
EOF

echo "Wrote ${CONFIG_OUT}"
echo "DNS CNAME api → ${TUNNEL_ID}.cfargotunnel.com"
echo "Run: cloudflared tunnel --config ${CONFIG_OUT} run"
