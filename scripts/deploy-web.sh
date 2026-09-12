#!/usr/bin/env bash
# Production deploy for epsynapse.com on team jype1.
# Loads a local JYPE token if this shell only has the personal CLI login.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  for f in \
    "$HOME/.config/jype/vercel.env" \
    "$HOME/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/u217305257/files/jype-vercel.env"
  do
    if [[ -f "$f" ]]; then
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
      break
    fi
  done
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "No VERCEL_TOKEN. Need the JYPE token for team jype1." >&2
  echo "This Mac's default vercel login is a different account and cannot see that team." >&2
  exit 1
fi

exec npx vercel deploy --prod --yes --scope jype1
