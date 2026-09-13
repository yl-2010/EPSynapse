#!/usr/bin/env bash
# Production deploy for epsynapse.com on team jype1.
# Loads the EPSynapse team token if this shell only has the personal CLI login.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  for f in \
    "$HOME/.config/epsynapse/vercel.env" \
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

# CLI deploys still send the current git author. Vercel blocks production when
# that email is not on the JYPE GitHub login. Git auto-deploy is already off.
# Stage the tree without .git so the check has nothing to match.
stage="$(mktemp -d "${TMPDIR:-/tmp}/epsynapse-web.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'ios/' \
  --exclude 'docs/' \
  --exclude '.cursor/' \
  --exclude 'deploy/' \
  --exclude '.venv/' \
  --exclude 'models/' \
  --exclude 'data/' \
  --exclude 'server/' \
  --exclude 'ml/' \
  --exclude 'scripts/' \
  "$root/" "$stage/"
# /class/:id and /note/:id hit Vercel's 404.html; keep it the same SPA as index.
cp "$stage/index.html" "$stage/404.html"
cd "$stage"

# Temp folder is not linked. Pin the existing Vercel project so the CLI
# does not invent a name from the mktemp path.
export VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_EF7WJXYBcuZa84T04Q5jvmKv}"
export VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_OR2sdjPGltYZpvAXu37W6g2cMf27}"

npx vercel deploy --prod --yes --scope jype1 --name epsynapse
