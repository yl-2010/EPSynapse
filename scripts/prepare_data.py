#!/usr/bin/env python3
"""Build the unified 8-class corpus for BERT fine-tuning and frozen offline testing.

Reads data/raw/ (from download_data.py) and writes:
  data/processed/corpus.parquet
  data/processed/corpus.csv
  data/processed/freeze_{train,val,test}_ids.txt
  data/processed/stats.json
  data/processed/label_map.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import pandas as pd
from datasets import load_from_disk

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
HF_DIR = RAW / "hf"
OPENSTAX_DIR = RAW / "openstax"
PROCESSED = ROOT / "data" / "processed"

SUBJECTS = [
    "Mathematics",
    "Physics",
    "Chemistry",
    "Biology",
    "Computer Science",
    "History",
    "Literature",
    "Economics",
]

SEED = 42
MIN_TOKENS = 20
MAX_TOKENS = 512
# Target per-subject sizes (mid of plan ranges)
TRAIN_PER = 2000
VAL_PER = 250
TEST_PER = 250
# Prefer ~50/50 short vs prose in each split when available
SHORT_FRAC = 0.5

MMLU_TO_SUBJECT = {
    # Mathematics
    "elementary_mathematics": "Mathematics",
    "high_school_mathematics": "Mathematics",
    "college_mathematics": "Mathematics",
    "abstract_algebra": "Mathematics",
    "high_school_statistics": "Mathematics",
    # Physics
    "high_school_physics": "Physics",
    "college_physics": "Physics",
    "conceptual_physics": "Physics",
    "astronomy": "Physics",
    # Chemistry
    "high_school_chemistry": "Chemistry",
    "college_chemistry": "Chemistry",
    # Biology
    "high_school_biology": "Biology",
    "college_biology": "Biology",
    "anatomy": "Biology",
    "virology": "Biology",
    "medical_genetics": "Biology",
    # Computer Science
    "high_school_computer_science": "Computer Science",
    "college_computer_science": "Computer Science",
    "computer_security": "Computer Science",
    "machine_learning": "Computer Science",
    # History
    "high_school_us_history": "History",
    "high_school_world_history": "History",
    "high_school_european_history": "History",
    "prehistory": "History",
    # Economics
    "high_school_microeconomics": "Economics",
    "high_school_macroeconomics": "Economics",
    "econometrics": "Economics",
    "management": "Economics",
    "marketing": "Economics",
    "professional_accounting": "Economics",
}

SETFIT_TO_SUBJECT = {
    "Maths": "Mathematics",
    "Physics": "Physics",
    "Chemistry": "Chemistry",
    "Biology": "Biology",
}

COGBENCH_TO_SUBJECT = {
    "mathematics": "Mathematics",
    "physics": "Physics",
    "astronomy": "Physics",
    "chemistry": "Chemistry",
    "biology": "Biology",
    "computer_science": "Computer Science",
    "history": "History",
    "economics": "Economics",
    "business": "Economics",
    # psychology / philosophy / general intentionally omitted
}

# TextbookChapters: (level1, level2) → subject
TEXTBOOK_LEVEL1 = {
    "math": "Mathematics",
    "stats": "Mathematics",
    "phys": "Physics",
    "chem": "Chemistry",
    "bio": "Biology",
}

TEXTBOOK_LEVEL2 = {
    ("eng", "Computer_Science"): "Computer Science",
    ("human", "Literature_and_Literacy"): "Literature",
    ("human", "Composition"): "Literature",
    ("human", "Languages"): "Literature",
    ("human", "History"): "History",
    ("socialsci", "Economics"): "Economics",
    ("socialsci", "Political_Science_and_Civics"): "History",
    ("biz", "Finance"): "Economics",
    ("biz", "Accounting"): "Economics",
    ("biz", "Economics"): "Economics",
}

WIKI_SECOND_TO_SUBJECT = {
    "Mathematics": "Mathematics",
    "Physics": "Physics",
    "Chemistry": "Chemistry",
    "Biology": "Biology",
    "Computer science": "Computer Science",
    "History": "History",
    "Languages and literature": "Literature",
    "Economics": "Economics",
    "Business": "Economics",
    "Space science": "Physics",
}


def tokenize(text: str) -> list[str]:
    return re.findall(r"\S+", text or "")


def truncate_tokens(text: str, max_tokens: int = MAX_TOKENS) -> str:
    toks = tokenize(text)
    if len(toks) <= max_tokens:
        return " ".join(toks)
    return " ".join(toks[:max_tokens])


def chunk_text(text: str, max_tokens: int = MAX_TOKENS, min_tokens: int = MIN_TOKENS) -> list[str]:
    toks = tokenize(text)
    if len(toks) < min_tokens:
        return []
    chunks = []
    step = max_tokens  # non-overlapping
    for i in range(0, len(toks), step):
        piece = toks[i : i + max_tokens]
        if len(piece) >= min_tokens:
            chunks.append(" ".join(piece))
    return chunks


def make_id(source: str, key: str) -> str:
    h = hashlib.sha1(f"{source}::{key}".encode("utf-8")).hexdigest()[:16]
    return f"{source}:{h}"


def add_row(rows: list, *, text: str, label: str, source: str, key: str, style: str) -> None:
    text = truncate_tokens(text.strip())
    n = len(tokenize(text))
    if n < MIN_TOKENS or label not in SUBJECTS:
        return
    rows.append(
        {
            "id": make_id(source, key),
            "text": text,
            "label": label,
            "source": source,
            "style": style,  # short | prose
        }
    )


def load_mmlu(rows: list) -> None:
    path = HF_DIR / "cais_mmlu"
    ds = load_from_disk(str(path))
    for split in ds:
        for i, ex in enumerate(ds[split]):
            subject = ex.get("subject")
            label = MMLU_TO_SUBJECT.get(subject)
            if not label:
                continue
            q = ex.get("question") or ""
            choices = ex.get("choices") or []
            if choices:
                choice_txt = " ".join(f"({chr(65+j)}) {c}" for j, c in enumerate(choices))
                text = f"{q}\n{choice_txt}"
            else:
                text = q
            add_row(rows, text=text, label=label, source="mmlu", key=f"{split}:{subject}:{i}", style="short")


def load_setfit(rows: list) -> None:
    path = HF_DIR / "setfit_student_question_categories"
    ds = load_from_disk(str(path))
    for split in ds:
        for i, ex in enumerate(ds[split]):
            label = SETFIT_TO_SUBJECT.get(ex.get("label_text"))
            if not label:
                continue
            add_row(
                rows,
                text=ex.get("text") or "",
                label=label,
                source="setfit",
                key=f"{split}:{i}",
                style="short",
            )


def load_cogbench(rows: list) -> None:
    path = HF_DIR / "cogbench"
    ds = load_from_disk(str(path))
    for split in ds:
        for ex in ds[split]:
            label = COGBENCH_TO_SUBJECT.get(ex.get("subject"))
            if not label:
                continue
            qid = ex.get("question_id") or ""
            add_row(
                rows,
                text=ex.get("question_text") or "",
                label=label,
                source="cogbench",
                key=f"{split}:{qid}",
                style="short",
            )


def load_textbook_chapters(rows: list) -> None:
    path = HF_DIR / "textbook_chapters"
    ds = load_from_disk(str(path))
    data = ds["train"] if hasattr(ds, "keys") and "train" in ds else ds
    for i, ex in enumerate(data):
        p = ex.get("path") or ""
        parts = p.replace("%3A", ":").split("/")
        if len(parts) < 3:
            continue
        level1, level2 = parts[1], parts[2]
        label = TEXTBOOK_LEVEL2.get((level1, level2)) or TEXTBOOK_LEVEL1.get(level1)
        if not label:
            continue
        chapter = ex.get("chapter") or ""
        for j, chunk in enumerate(chunk_text(chapter)):
            add_row(
                rows,
                text=chunk,
                label=label,
                source="textbook_chapters",
                key=f"{i}:{j}:{p}",
                style="prose",
            )


def load_wiki(rows: list) -> None:
    path = HF_DIR / "wiki_academic_subjects"
    ds = load_from_disk(str(path))
    for split in ds:
        for i, ex in enumerate(ds[split]):
            labels = ex.get("label") or []
            if len(labels) < 2:
                continue
            label = WIKI_SECOND_TO_SUBJECT.get(labels[1])
            if not label:
                continue
            tokens = ex.get("token") or []
            text = " ".join(tokens)
            for j, chunk in enumerate(chunk_text(text)):
                add_row(
                    rows,
                    text=chunk,
                    label=label,
                    source="wiki_academic",
                    key=f"{split}:{i}:{j}",
                    style="prose",
                )


def load_openstax(rows: list) -> None:
    if not OPENSTAX_DIR.exists():
        return
    for path in sorted(OPENSTAX_DIR.glob("*.jsonl")):
        with path.open(encoding="utf-8") as f:
            for line_i, line in enumerate(f):
                row = json.loads(line)
                label = row.get("label")
                text = row.get("text") or ""
                book = row.get("book_slug") or path.stem
                page = row.get("page_slug") or str(line_i)
                # Skip review/key-term pages that are list-heavy
                if any(x in page for x in ("key-terms", "chapter-review", "answer-key", "index")):
                    continue
                for j, chunk in enumerate(chunk_text(text)):
                    add_row(
                        rows,
                        text=chunk,
                        label=label,
                        source="openstax",
                        key=f"{book}:{page}:{j}",
                        style="prose",
                    )


def dedupe(df: pd.DataFrame) -> pd.DataFrame:
    """Drop exact duplicate ids and near-identical texts within a label."""
    df = df.drop_duplicates(subset=["id"])
    df = df.drop_duplicates(subset=["label", "text"])
    return df.reset_index(drop=True)


def stratified_sample(
    pool: pd.DataFrame,
    n: int,
    seed: int,
) -> pd.DataFrame:
    if len(pool) <= n:
        return pool.copy()
    # Balance short/prose when possible
    short = pool[pool["style"] == "short"]
    prose = pool[pool["style"] == "prose"]
    n_short = min(len(short), int(round(n * SHORT_FRAC)))
    n_prose = min(len(prose), n - n_short)
    # If one style is short, fill from the other
    if n_short + n_prose < n:
        deficit = n - (n_short + n_prose)
        if len(short) > n_short:
            n_short = min(len(short), n_short + deficit)
            deficit = n - (n_short + n_prose)
        if deficit > 0 and len(prose) > n_prose:
            n_prose = min(len(prose), n_prose + deficit)

    parts = []
    if n_short:
        parts.append(short.sample(n=n_short, random_state=seed))
    if n_prose:
        parts.append(prose.sample(n=n_prose, random_state=seed + 1))
    if not parts:
        return pool.sample(n=min(n, len(pool)), random_state=seed)
    out = pd.concat(parts, ignore_index=True)
    if len(out) > n:
        out = out.sample(n=n, random_state=seed + 2)
    return out


def assign_splits(df: pd.DataFrame) -> pd.DataFrame:
    """Per-label: sample up to train/val/test targets with frozen ids."""
    assigned = []
    shortages = {}

    for label in SUBJECTS:
        sub = df[df["label"] == label].copy()
        need = TRAIN_PER + VAL_PER + TEST_PER
        if len(sub) < VAL_PER + TEST_PER + 100:
            shortages[label] = len(sub)
        # First carve test (prefer including prose for note-like slice)
        test_pool = sub
        # Ensure at least ~40% prose in test when available
        prose = sub[sub["style"] == "prose"]
        short = sub[sub["style"] == "short"]
        n_test_prose = min(len(prose), max(int(TEST_PER * 0.4), 1) if len(prose) else 0)
        n_test_short = min(len(short), TEST_PER - n_test_prose)
        if n_test_short + n_test_prose < TEST_PER:
            # fill
            rem = TEST_PER - n_test_short - n_test_prose
            if len(short) > n_test_short:
                take = min(len(short) - n_test_short, rem)
                n_test_short += take
                rem -= take
            if rem > 0 and len(prose) > n_test_prose:
                n_test_prose += min(len(prose) - n_test_prose, rem)

        test_parts = []
        if n_test_prose:
            test_parts.append(prose.sample(n=n_test_prose, random_state=SEED))
        if n_test_short:
            test_parts.append(short.sample(n=n_test_short, random_state=SEED + 3))
        test_df = pd.concat(test_parts, ignore_index=True) if test_parts else sub.sample(
            n=min(TEST_PER, len(sub)), random_state=SEED
        )
        test_ids = set(test_df["id"])
        remain = sub[~sub["id"].isin(test_ids)]

        val_df = stratified_sample(remain, VAL_PER, SEED + 5)
        val_ids = set(val_df["id"])
        remain2 = remain[~remain["id"].isin(val_ids)]
        train_df = stratified_sample(remain2, TRAIN_PER, SEED + 7)

        for split_name, part in (("test", test_df), ("val", val_df), ("train", train_df)):
            part = part.copy()
            part["split"] = split_name
            assigned.append(part)

        print(
            f"  {label:18} pool={len(sub):6d}  "
            f"train={len(train_df):4d} val={len(val_df):4d} test={len(test_df):4d}  "
            f"short/prose train="
            f"{(train_df['style']=='short').sum()}/{(train_df['style']=='prose').sum()}"
        )

    out = pd.concat(assigned, ignore_index=True)
    # Final safety: unique ids across splits
    out = out.drop_duplicates(subset=["id"], keep="first")
    return out, shortages


def write_outputs(df: pd.DataFrame, shortages: dict) -> None:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    cols = ["id", "text", "label", "split", "source", "style"]
    df = df[cols].sort_values(["split", "label", "id"]).reset_index(drop=True)

    parquet_path = PROCESSED / "corpus.parquet"
    csv_path = PROCESSED / "corpus.csv"
    df.to_parquet(parquet_path, index=False)
    df.to_csv(csv_path, index=False)

    for split in ("train", "val", "test"):
        ids = df.loc[df["split"] == split, "id"].tolist()
        (PROCESSED / f"freeze_{split}_ids.txt").write_text("\n".join(ids) + "\n", encoding="utf-8")

    # Primary freeze file called out in the plan
    test_ids = df.loc[df["split"] == "test", "id"].tolist()
    (PROCESSED / "freeze_test_ids.txt").write_text("\n".join(test_ids) + "\n", encoding="utf-8")

    stats = {
        "seed": SEED,
        "min_tokens": MIN_TOKENS,
        "max_tokens": MAX_TOKENS,
        "targets": {"train_per_subject": TRAIN_PER, "val_per_subject": VAL_PER, "test_per_subject": TEST_PER},
        "total_rows": int(len(df)),
        "by_split": df["split"].value_counts().to_dict(),
        "by_label_split": {
            label: df.loc[df["label"] == label, "split"].value_counts().to_dict() for label in SUBJECTS
        },
        "by_source": df["source"].value_counts().to_dict(),
        "by_style": df["style"].value_counts().to_dict(),
        "shortages": shortages,
    }
    (PROCESSED / "stats.json").write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    (PROCESSED / "label_map.json").write_text(
        json.dumps(
            {
                "subjects": SUBJECTS,
                "mmlu": MMLU_TO_SUBJECT,
                "setfit": SETFIT_TO_SUBJECT,
                "cogbench": COGBENCH_TO_SUBJECT,
                "textbook_level1": TEXTBOOK_LEVEL1,
                "textbook_level2": {f"{a}/{b}": v for (a, b), v in TEXTBOOK_LEVEL2.items()},
                "wiki_second": WIKI_SECOND_TO_SUBJECT,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nWrote {parquet_path} ({len(df)} rows)")
    print(f"Wrote {csv_path}")
    print(f"Wrote freeze id lists + stats.json")


def verify_minimums(df: pd.DataFrame) -> None:
    """Fail loudly if a subject is too short for a meaningful frozen test."""
    errors = []
    for label in SUBJECTS:
        sub = df[df["label"] == label]
        n_test = (sub["split"] == "test").sum()
        n_train = (sub["split"] == "train").sum()
        if n_test < 100:
            errors.append(f"{label}: test={n_test} (<100)")
        if n_train < 500:
            errors.append(f"{label}: train={n_train} (<500)")
    if errors:
        raise SystemExit("Corpus below minimums:\n  - " + "\n  - ".join(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-verify", action="store_true", help="Do not fail on short subjects")
    args = parser.parse_args()

    required = [
        HF_DIR / "cais_mmlu",
        HF_DIR / "setfit_student_question_categories",
        HF_DIR / "cogbench",
        HF_DIR / "textbook_chapters",
        HF_DIR / "wiki_academic_subjects",
    ]
    missing = [str(p) for p in required if not p.exists()]
    if missing:
        print("Missing raw sources. Run scripts/download_data.py first:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        return 1

    print("Loading and mapping sources...")
    rows: list[dict] = []
    load_mmlu(rows)
    print(f"  after mmlu: {len(rows)}")
    load_setfit(rows)
    print(f"  after setfit: {len(rows)}")
    load_cogbench(rows)
    print(f"  after cogbench: {len(rows)}")
    load_textbook_chapters(rows)
    print(f"  after textbook_chapters: {len(rows)}")
    load_wiki(rows)
    print(f"  after wiki: {len(rows)}")
    load_openstax(rows)
    print(f"  after openstax: {len(rows)}")

    df = pd.DataFrame(rows)
    df = dedupe(df)
    print(f"After dedupe: {len(df)}")
    print("Pool by label:")
    print(df["label"].value_counts().reindex(SUBJECTS).fillna(0).astype(int).to_string())

    print("\nAssigning frozen splits...")
    df, shortages = assign_splits(df)
    write_outputs(df, shortages)

    if shortages:
        print("\nWARNING: limited pool for:", shortages)
    if not args.skip_verify:
        verify_minimums(df)
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
