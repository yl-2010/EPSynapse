#!/usr/bin/env python3
"""Evaluate zero-shot and fine-tuned BERT on the frozen test set."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, f1_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ml.fine_tuned import FineTunedBertClassifier  # noqa: E402
from ml.labels import SUBJECTS  # noqa: E402
from ml.zero_shot import ZeroShotBertClassifier  # noqa: E402

PROCESSED = ROOT / "data" / "processed"
DEFAULT_FT = ROOT / "models" / "fine-tuned-bert"
DEFAULT_OUT = PROCESSED / "bert_eval.json"
DEFAULT_PUBLIC = ROOT / "research-metrics.json"


def load_test(corpus: pd.DataFrame) -> pd.DataFrame:
    ids_path = PROCESSED / "freeze_test_ids.txt"
    ids = set(ids_path.read_text().splitlines())
    df = corpus[corpus["id"].isin(ids)].copy()
    if df.empty:
        df = corpus[corpus["split"] == "test"].copy()
    return df.reset_index(drop=True)


def summarize(y_true: list[str], y_pred: list[str], name: str, extra: dict | None = None) -> dict:
    report = classification_report(
        y_true,
        y_pred,
        labels=SUBJECTS,
        output_dict=True,
        zero_division=0,
    )
    per_class = {
        s: {
            "precision": float(report[s]["precision"]),
            "recall": float(report[s]["recall"]),
            "f1": float(report[s]["f1-score"]),
            "support": int(report[s]["support"]),
        }
        for s in SUBJECTS
    }
    out = {
        "name": name,
        "n": len(y_true),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "micro_f1": float(
            f1_score(y_true, y_pred, average="micro", labels=SUBJECTS, zero_division=0)
        ),
        "macro_f1": float(
            f1_score(y_true, y_pred, average="macro", labels=SUBJECTS, zero_division=0)
        ),
        "per_class": per_class,
    }
    if extra:
        out.update(extra)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--finetuned-dir", type=Path, default=DEFAULT_FT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--public-output", type=Path, default=DEFAULT_PUBLIC)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--skip-zero-shot", action="store_true")
    parser.add_argument("--skip-finetuned", action="store_true")
    parser.add_argument("--max-samples", type=int, default=0)
    args = parser.parse_args()

    corpus = pd.read_parquet(PROCESSED / "corpus.parquet")
    test_df = load_test(corpus)
    if args.max_samples > 0:
        test_df = test_df.head(args.max_samples)
    texts = test_df["text"].tolist()
    y_true = test_df["label"].tolist()
    print(f"frozen test n={len(test_df)}")

    results: dict = {
        "subjects": SUBJECTS,
        "test_n": len(test_df),
        "arms": {},
        "include_user_tests": False,
        "include_frozen_tests": True,
        "frozen_test_n": len(test_df),
        "user_test_n": 0,
        "source": "frozen_eval",
    }

    if not args.skip_zero_shot:
        print("evaluating zero-shot BERT…")
        zs = ZeroShotBertClassifier()
        preds = zs.predict_batch(texts, batch_size=args.batch_size)
        y_pred = [p["subject"] for p in preds]
        results["arms"]["zero_shot"] = summarize(
            y_true,
            y_pred,
            "zero_shot",
            extra={
                "protocol": "zero_shot_cls_cosine",
                "model": "bert-base-uncased",
                "label": "Zero-shot BERT",
            },
        )
        arm = results["arms"]["zero_shot"]
        print(
            f"  zero-shot accuracy={arm['accuracy']:.4f} "
            f"micro_f1={arm['micro_f1']:.4f} macro_f1={arm['macro_f1']:.4f}"
        )

    if not args.skip_finetuned:
        if not args.finetuned_dir.exists():
            raise SystemExit(f"Fine-tuned dir missing: {args.finetuned_dir}")
        print(f"evaluating fine-tuned BERT from {args.finetuned_dir}…")
        ft = FineTunedBertClassifier(args.finetuned_dir)
        preds = ft.predict_batch(texts, batch_size=args.batch_size)
        y_pred = [p["subject"] for p in preds]
        results["arms"]["fine_tuned"] = summarize(
            y_true,
            y_pred,
            "fine_tuned",
            extra={
                "protocol": "fine_tuned",
                "model_dir": str(args.finetuned_dir),
                "label": "Fine-tuned BERT",
            },
        )
        arm = results["arms"]["fine_tuned"]
        print(
            f"  fine-tuned accuracy={arm['accuracy']:.4f} "
            f"micro_f1={arm['micro_f1']:.4f} macro_f1={arm['macro_f1']:.4f}"
        )

    results["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(f"wrote {args.output}")
    if args.public_output:
        args.public_output.parent.mkdir(parents=True, exist_ok=True)
        args.public_output.write_text(json.dumps(results, indent=2) + "\n")
        print(f"wrote {args.public_output}")


if __name__ == "__main__":
    main()
