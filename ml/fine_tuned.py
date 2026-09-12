"""Fine-tuned BERT sequence-classification helpers."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from ml.device import pick_device
from ml.labels import ID2LABEL, SUBJECTS

MAX_LENGTH = 512


class FineTunedBertClassifier:
    def __init__(
        self,
        model_dir: str | Path,
        device: torch.device | None = None,
        max_length: int = MAX_LENGTH,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.device = device or pick_device()
        self.max_length = max_length
        if not self.model_dir.exists():
            raise FileNotFoundError(f"Fine-tuned checkpoint not found: {self.model_dir}")
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_dir)
        self.model = AutoModelForSequenceClassification.from_pretrained(self.model_dir)
        self.model.to(self.device)
        self.model.eval()

    @torch.inference_mode()
    def predict(self, text: str) -> dict[str, Any]:
        started = time.perf_counter()
        encoded = self.tokenizer(
            text,
            truncation=True,
            max_length=self.max_length,
            return_tensors="pt",
        )
        encoded = {k: v.to(self.device) for k, v in encoded.items()}
        logits = self.model(**encoded).logits.squeeze(0)
        probs = F.softmax(logits, dim=-1)
        pred_idx = int(torch.argmax(probs).item())
        latency_ms = int((time.perf_counter() - started) * 1000)
        prob_list = probs.detach().cpu().tolist()
        id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        subject = id2label.get(pred_idx, ID2LABEL.get(pred_idx, SUBJECTS[pred_idx]))
        probs_map = {
            id2label.get(i, ID2LABEL.get(i, SUBJECTS[i])): float(p)
            for i, p in enumerate(prob_list)
        }
        return {
            "subject": subject,
            "confidence": float(prob_list[pred_idx]),
            "probs": probs_map,
            "latencyMs": latency_ms,
            "protocol": "fine_tuned",
            "model": str(self.model_dir),
        }

    @torch.inference_mode()
    def predict_batch(self, texts: list[str], batch_size: int = 8) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            started = time.perf_counter()
            encoded = self.tokenizer(
                chunk,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt",
            )
            encoded = {k: v.to(self.device) for k, v in encoded.items()}
            logits = self.model(**encoded).logits
            probs = F.softmax(logits, dim=-1)
            latency_ms = int((time.perf_counter() - started) * 1000)
            for row in probs:
                pred_idx = int(torch.argmax(row).item())
                prob_list = row.detach().cpu().tolist()
                subject = id2label.get(pred_idx, ID2LABEL.get(pred_idx, SUBJECTS[pred_idx]))
                probs_map = {
                    id2label.get(j, ID2LABEL.get(j, SUBJECTS[j])): float(p)
                    for j, p in enumerate(prob_list)
                }
                results.append(
                    {
                        "subject": subject,
                        "confidence": float(prob_list[pred_idx]),
                        "probs": probs_map,
                        "latencyMs": latency_ms,
                        "protocol": "fine_tuned",
                        "model": str(self.model_dir),
                    }
                )
        return results
