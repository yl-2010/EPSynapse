#!/usr/bin/env python3
"""Fine-tune bert-base-uncased on the frozen 8-subject notes corpus."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import accuracy_score, f1_score
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
    set_seed,
)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ml.device import pick_device  # noqa: E402
from ml.labels import ID2LABEL, LABEL2ID, SUBJECTS  # noqa: E402

PROCESSED = ROOT / "data" / "processed"
DEFAULT_OUT = ROOT / "models" / "fine-tuned-bert"
MODEL_ID = "bert-base-uncased"
MAX_LENGTH = 512
SEED = 42


def load_split(corpus: pd.DataFrame, split: str) -> pd.DataFrame:
    ids_path = PROCESSED / f"freeze_{split}_ids.txt"
    ids = set(ids_path.read_text().splitlines())
    df = corpus[corpus["id"].isin(ids)].copy()
    if df.empty:
        df = corpus[corpus["split"] == split].copy()
    df["label_id"] = df["label"].map(LABEL2ID)
    missing = df["label_id"].isna().sum()
    if missing:
        raise SystemExit(f"{missing} rows in {split} have unknown labels")
    df["label_id"] = df["label_id"].astype(int)
    return df.reset_index(drop=True)


class NotesDataset(torch.utils.data.Dataset):
    def __init__(self, texts: list[str], labels: list[int], tokenizer, max_length: int):
        self.texts = texts
        self.labels = labels
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.texts)

    def __getitem__(self, idx: int) -> dict:
        enc = self.tokenizer(
            self.texts[idx],
            truncation=True,
            max_length=self.max_length,
            padding="max_length",
            return_tensors="pt",
        )
        item = {k: v.squeeze(0) for k, v in enc.items()}
        item["labels"] = torch.tensor(self.labels[idx], dtype=torch.long)
        return item


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    preds = np.argmax(logits, axis=-1)
    return {
        "accuracy": float(accuracy_score(labels, preds)),
        "macro_f1": float(f1_score(labels, preds, average="macro")),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--train-batch-size", type=int, default=16)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--max-length", type=int, default=MAX_LENGTH)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument(
        "--max-train-samples",
        type=int,
        default=0,
        help="If >0, subsample train for a smoke run",
    )
    args = parser.parse_args()

    set_seed(args.seed)
    device = pick_device()
    print(f"device={device}")

    corpus_path = PROCESSED / "corpus.parquet"
    if not corpus_path.exists():
        raise SystemExit(f"Missing {corpus_path}; run scripts/prepare_data.py first")
    corpus = pd.read_parquet(corpus_path)

    train_df = load_split(corpus, "train")
    val_df = load_split(corpus, "val")
    if args.max_train_samples > 0:
        train_df = train_df.sample(n=min(args.max_train_samples, len(train_df)), random_state=args.seed)

    print(f"train={len(train_df)} val={len(val_df)} subjects={len(SUBJECTS)}")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID,
        num_labels=len(SUBJECTS),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
    )

    train_ds = NotesDataset(
        train_df["text"].tolist(),
        train_df["label_id"].tolist(),
        tokenizer,
        args.max_length,
    )
    val_ds = NotesDataset(
        val_df["text"].tolist(),
        val_df["label_id"].tolist(),
        tokenizer,
        args.max_length,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    use_fp16 = device.type == "cuda"

    training_args = TrainingArguments(
        output_dir=str(args.output_dir / "runs"),
        eval_strategy="epoch",
        save_strategy="epoch",
        learning_rate=args.lr,
        per_device_train_batch_size=args.train_batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        weight_decay=0.01,
        load_best_model_at_end=True,
        metric_for_best_model="macro_f1",
        greater_is_better=True,
        save_total_limit=2,
        logging_steps=50,
        seed=args.seed,
        report_to=[],
        fp16=use_fp16,
        dataloader_pin_memory=device.type == "cuda",
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
    )

    train_result = trainer.train()
    metrics = trainer.evaluate()
    trainer.save_model(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    summary = {
        "model_id": MODEL_ID,
        "output_dir": str(args.output_dir),
        "device": str(device),
        "train_samples": len(train_df),
        "val_samples": len(val_df),
        "max_length": args.max_length,
        "epochs": args.epochs,
        "lr": args.lr,
        "train_batch_size": args.train_batch_size,
        "grad_accum": args.grad_accum,
        "seed": args.seed,
        "train_runtime_s": train_result.metrics.get("train_runtime"),
        "train_loss": train_result.metrics.get("train_loss"),
        "eval": metrics,
        "subjects": SUBJECTS,
    }
    metrics_path = args.output_dir / "metrics.json"
    metrics_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    print(f"saved checkpoint → {args.output_dir}")


if __name__ == "__main__":
    main()
