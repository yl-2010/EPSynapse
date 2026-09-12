"""Zero-shot BERT classifier via [CLS] embedding cosine similarity to verbalizers."""

from __future__ import annotations

import time
from typing import Any

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from ml.device import pick_device
from ml.labels import SUBJECTS, verbalizer_for

DEFAULT_MODEL_ID = "bert-base-uncased"
MAX_LENGTH = 512


class ZeroShotBertClassifier:
    """Pretrained BERT encoder. No corpus fine-tune."""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        device: torch.device | None = None,
        max_length: int = MAX_LENGTH,
    ) -> None:
        self.model_id = model_id
        self.device = device or pick_device()
        self.max_length = max_length
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModel.from_pretrained(model_id)
        self.model.to(self.device)
        self.model.eval()
        self._label_embeddings: torch.Tensor | None = None

    @torch.inference_mode()
    def _encode(self, texts: list[str]) -> torch.Tensor:
        encoded = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=self.max_length,
            return_tensors="pt",
        )
        encoded = {k: v.to(self.device) for k, v in encoded.items()}
        out = self.model(**encoded)
        cls = out.last_hidden_state[:, 0, :]
        return F.normalize(cls, p=2, dim=-1)

    def ensure_label_embeddings(self) -> torch.Tensor:
        if self._label_embeddings is None:
            templates = [verbalizer_for(s) for s in SUBJECTS]
            self._label_embeddings = self._encode(templates)
        return self._label_embeddings

    @torch.inference_mode()
    def predict(self, text: str) -> dict[str, Any]:
        started = time.perf_counter()
        label_emb = self.ensure_label_embeddings()
        note_emb = self._encode([text])
        scores = (note_emb @ label_emb.T).squeeze(0)
        probs = F.softmax(scores, dim=-1)
        pred_idx = int(torch.argmax(probs).item())
        latency_ms = int((time.perf_counter() - started) * 1000)
        prob_list = probs.detach().cpu().tolist()
        return {
            "subject": SUBJECTS[pred_idx],
            "confidence": float(prob_list[pred_idx]),
            "probs": {SUBJECTS[i]: float(p) for i, p in enumerate(prob_list)},
            "latencyMs": latency_ms,
            "protocol": "zero_shot_cls_cosine",
            "model": self.model_id,
        }

    @torch.inference_mode()
    def predict_batch(self, texts: list[str], batch_size: int = 8) -> list[dict[str, Any]]:
        label_emb = self.ensure_label_embeddings()
        results: list[dict[str, Any]] = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            started = time.perf_counter()
            note_emb = self._encode(chunk)
            scores = note_emb @ label_emb.T
            probs = F.softmax(scores, dim=-1)
            latency_ms = int((time.perf_counter() - started) * 1000)
            for row in probs:
                pred_idx = int(torch.argmax(row).item())
                prob_list = row.detach().cpu().tolist()
                results.append(
                    {
                        "subject": SUBJECTS[pred_idx],
                        "confidence": float(prob_list[pred_idx]),
                        "probs": {SUBJECTS[j]: float(p) for j, p in enumerate(prob_list)},
                        "latencyMs": latency_ms,
                        "protocol": "zero_shot_cls_cosine",
                        "model": self.model_id,
                    }
                )
        return results
