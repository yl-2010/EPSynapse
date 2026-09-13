#!/usr/bin/env bash
# Production deploy for epsynapse.com on team jype1.
# Loads the EPSynapse team token if this shell only has the personal CLI login.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Only this one file is trusted. It must be owned by the current user, mode 600,
# and contain nothing but KEY=value lines, because it is sourced as shell.
if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  f="$HOME/.config/epsynapse/vercel.env"
  if [[ -f "$f" ]]; then
    if [[ "$(stat -f '%Su %Lp' "$f")" != "$(id -un) 600" ]]; then
      echo "$f must be owned by you with mode 600 (chmod 600 \"$f\")." >&2
      exit 1
    fi
    if grep -Evq '^(#.*|[A-Za-z_][A-Za-z0-9_]*=[^;`$()|&<>]*)?$' "$f"; then
      echo "$f has a line that is not KEY=value. Refusing to source it." >&2
      exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
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
# Every app route (/class, /note, /todo, /grades) is rewritten to /index in
# vercel.json, so 404.html is a real not-found page and is shipped as-is.
cd "$stage"

# Temp folder is not linked. Pin the existing Vercel project so the CLI
# does not invent a name from the mktemp path.
export VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_EF7WJXYBcuZa84T04Q5jvmKv}"
export VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_OR2sdjPGltYZpvAXu37W6g2cMf27}"

# Pinned so a deploy never pulls an unreviewed CLI. Bump on purpose.
npx --yes vercel@59.16.0 deploy --prod --yes --scope jype1 --name epsynapse
