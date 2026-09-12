#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${ROOT}/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing ${PYTHON}. Create the venv and pip install -r requirements-bert.txt" >&2
  exit 1
fi
export BERT_HOST="${BERT_HOST:-127.0.0.1}"
export BERT_PORT="${BERT_PORT:-3007}"
export BERT_FINETUNED_DIR="${BERT_FINETUNED_DIR:-${ROOT}/models/fine-tuned-bert}"
exec "$PYTHON" "${ROOT}/scripts/bert_serve.py"
