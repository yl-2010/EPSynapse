#!/usr/bin/env python3
"""Local HTTP service for zero-shot + fine-tuned BERT (127.0.0.1 only)."""

from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ml.fine_tuned import FineTunedBertClassifier  # noqa: E402
from ml.zero_shot import ZeroShotBertClassifier  # noqa: E402

HOST = os.environ.get("BERT_HOST", "127.0.0.1")
PORT = int(os.environ.get("BERT_PORT", "3007"))
FINETUNED_DIR = Path(
    os.environ.get("BERT_FINETUNED_DIR", str(ROOT / "models" / "fine-tuned-bert"))
)

zero_shot: ZeroShotBertClassifier | None = None
fine_tuned: FineTunedBertClassifier | None = None
fine_tuned_error: str | None = None


def load_models() -> None:
    global zero_shot, fine_tuned, fine_tuned_error
    print("loading zero-shot bert-base-uncased…", flush=True)
    zero_shot = ZeroShotBertClassifier()
    print("zero-shot ready", flush=True)
    if FINETUNED_DIR.exists() and (FINETUNED_DIR / "config.json").exists():
        try:
            print(f"loading fine-tuned from {FINETUNED_DIR}…", flush=True)
            fine_tuned = FineTunedBertClassifier(FINETUNED_DIR)
            fine_tuned_error = None
            print("fine-tuned ready", flush=True)
        except Exception as exc:  # noqa: BLE001
            fine_tuned = None
            fine_tuned_error = str(exc)
            print(f"fine-tuned load failed: {exc}", flush=True)
    else:
        fine_tuned = None
        fine_tuned_error = f"checkpoint missing at {FINETUNED_DIR}"
        print(fine_tuned_error, flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "zeroShotLoaded": zero_shot is not None,
                    "fineTunedLoaded": fine_tuned is not None,
                    "fineTunedError": fine_tuned_error,
                    "finetunedDir": str(FINETUNED_DIR),
                    "host": HOST,
                    "port": PORT,
                },
            )
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/classify":
            self._send(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, {"ok": False, "error": "invalid JSON"})
            return
        text = data.get("text") or data.get("rawText") or ""
        if not isinstance(text, str) or not text.strip():
            self._send(400, {"ok": False, "error": "text required"})
            return
        if zero_shot is None:
            self._send(503, {"ok": False, "error": "zero-shot model not loaded"})
            return
        try:
            zs = zero_shot.predict(text.strip())
            ft = None
            if fine_tuned is not None:
                ft = fine_tuned.predict(text.strip())
            self._send(
                200,
                {
                    "ok": True,
                    "votes": {
                        "zeroShotBert": zs,
                        "fineTunedBert": ft,
                    },
                    "fineTunedError": fine_tuned_error if ft is None else None,
                },
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(exc)})


def main() -> None:
    load_models()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"BERT service listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
