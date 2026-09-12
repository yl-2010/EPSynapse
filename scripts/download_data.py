#!/usr/bin/env python3
"""Download all proxy sources needed for fine-tuning and frozen offline testing.

Saves Hugging Face datasets under data/raw/hf/ and OpenStax chapter text under
data/raw/openstax/. Idempotent: skips sources that already exist unless --force.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from datasets import load_dataset
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
HF_DIR = RAW / "hf"
OPENSTAX_DIR = RAW / "openstax"

HF_SOURCES = [
    {
        "name": "cais_mmlu",
        "path": "cais/mmlu",
        "load_kwargs": {"name": "all"},
        "splits": None,  # all splits
    },
    {
        "name": "setfit_student_question_categories",
        "path": "SetFit/student-question-categories",
        "load_kwargs": {},
        "splits": None,
    },
    {
        "name": "cogbench",
        "path": "mouryat9/CogBench",
        "load_kwargs": {"verification_mode": "no_checks"},
        "splits": None,
    },
    {
        "name": "textbook_chapters",
        "path": "princeton-nlp/TextbookChapters",
        "load_kwargs": {},
        "splits": ["train"],
    },
    {
        "name": "wiki_academic_subjects",
        "path": "meliascosta/wiki_academic_subjects",
        "load_kwargs": {},
        "splits": None,
    },
]

# Curated live OpenStax books covering the 8 subjects (prose).
OPENSTAX_BOOKS = [
    ("college-algebra-2e", "Mathematics"),
    ("calculus-volume-1", "Mathematics"),
    ("college-physics-2e", "Physics"),
    ("astronomy-2e", "Physics"),
    ("chemistry-2e", "Chemistry"),
    ("biology-2e", "Biology"),
    ("introduction-computer-science", "Computer Science"),
    ("us-history", "History"),
    ("world-history-volume-1", "History"),
    ("writing-guide", "Literature"),
    ("principles-economics-3e", "Economics"),
    ("principles-microeconomics-3e", "Economics"),
]

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": "epsynapse-bert-data-prep/1.0 (educational research)",
        "Accept": "text/html,application/json",
    }
)


def ensure_dirs() -> None:
    HF_DIR.mkdir(parents=True, exist_ok=True)
    OPENSTAX_DIR.mkdir(parents=True, exist_ok=True)


def download_hf_source(spec: dict, force: bool) -> dict:
    out = HF_DIR / spec["name"]
    if out.exists() and any(out.iterdir()) and not force:
        # Count rows from disk
        from datasets import load_from_disk

        ds = load_from_disk(str(out))
        counts = {k: len(ds[k]) for k in ds} if hasattr(ds, "keys") else {"train": len(ds)}
        print(f"[skip] {spec['name']} already at {out} ({counts})")
        return {"name": spec["name"], "path": str(out), "counts": counts, "skipped": True}

    print(f"[download] Hugging Face: {spec['path']} -> {out}")
    kwargs = dict(spec["load_kwargs"])
    if spec["splits"]:
        parts = {}
        for split in spec["splits"]:
            parts[split] = load_dataset(spec["path"], split=split, **kwargs)
        from datasets import DatasetDict

        ds = DatasetDict(parts)
    else:
        ds = load_dataset(spec["path"], **kwargs)

    if out.exists() and force:
        import shutil

        shutil.rmtree(out)
    ds.save_to_disk(str(out))

    if hasattr(ds, "keys"):
        counts = {k: len(ds[k]) for k in ds}
    else:
        counts = {"data": len(ds)}
    print(f"  saved {counts}")
    return {"name": spec["name"], "path": str(out), "counts": counts, "skipped": False}


def _strip_html_title(title: str) -> str:
    return BeautifulSoup(title or "", "lxml").get_text(" ", strip=True)


def fetch_openstax_tree(slug: str) -> dict:
    """Load book TOC from the REX preloaded state on the preface/intro page."""
    candidates = [
        f"https://openstax.org/books/{slug}/pages/preface",
        f"https://openstax.org/books/{slug}/pages/1-introduction",
        f"https://openstax.org/books/{slug}/pages/introduction",
    ]
    last_err = None
    for url in candidates:
        try:
            r = SESSION.get(url, timeout=90)
            if r.status_code == 404:
                continue
            r.raise_for_status()
            idx = r.text.find("window.__PRELOADED_STATE__")
            if idx < 0:
                last_err = RuntimeError(f"no preloaded state on {url}")
                continue
            start = r.text.find("{", idx)
            state, _ = json.JSONDecoder().raw_decode(r.text, start)
            tree = state.get("content", {}).get("book", {}).get("tree")
            if not tree:
                last_err = RuntimeError(f"no book.tree on {url}")
                continue
            return tree
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.5)
    raise RuntimeError(f"Could not load OpenStax TOC for {slug}: {last_err}")


def iter_leaf_pages(tree: dict):
    def walk(node):
        if not isinstance(node, dict):
            return
        kids = node.get("contents")
        slug = node.get("slug")
        if slug and not kids:
            yield {
                "slug": slug,
                "title": _strip_html_title(node.get("title") or ""),
                "id": node.get("id"),
            }
        for c in kids or []:
            yield from walk(c)

    yield from walk(tree)


def fetch_openstax_page_text(book_slug: str, page_slug: str) -> str:
    url = f"https://openstax.org/books/{book_slug}/pages/{page_slug}"
    r = SESSION.get(url, timeout=90)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")
    main = soup.select_one("[data-type='page']") or soup.select_one("div.page-content") or soup.select_one("main")
    if not main:
        return ""
    # Drop nav / UI chrome if nested
    for bad in main.select("nav, script, style, noscript"):
        bad.decompose()
    text = main.get_text("\n", strip=True)
    # Normalize whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def download_openstax_book(book_slug: str, label: str, force: bool, max_pages: int | None) -> dict:
    out_path = OPENSTAX_DIR / f"{book_slug}.jsonl"
    meta_path = OPENSTAX_DIR / f"{book_slug}.meta.json"
    if out_path.exists() and not force:
        n = sum(1 for _ in out_path.open())
        print(f"[skip] openstax/{book_slug} ({n} pages)")
        return {"slug": book_slug, "label": label, "pages": n, "skipped": True}

    print(f"[download] OpenStax: {book_slug} ({label})")
    tree = fetch_openstax_tree(book_slug)
    pages = list(iter_leaf_pages(tree))
    # Keep numbered section pages (e.g. 1-1-the-science-of-biology); drop review/index matter.
    section_re = re.compile(r"^\d+-\d+-")
    pages = [p for p in pages if section_re.match(p["slug"] or "")]
    if max_pages is not None:
        pages = pages[:max_pages]

    rows = []
    for page in tqdm(pages, desc=book_slug, leave=False):
        slug = page["slug"]
        try:
            text = fetch_openstax_page_text(book_slug, slug)
        except Exception as e:  # noqa: BLE001
            print(f"  warn: failed {book_slug}/{slug}: {e}", file=sys.stderr)
            time.sleep(1.0)
            continue
        if len(text.split()) < 40:
            continue
        rows.append(
            {
                "book_slug": book_slug,
                "page_slug": slug,
                "title": page["title"],
                "label": label,
                "text": text,
                "source": "openstax",
            }
        )
        time.sleep(0.05)  # be polite

    with out_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    meta_path.write_text(
        json.dumps(
            {"book_slug": book_slug, "label": label, "pages_saved": len(rows), "toc_leaves": len(pages)},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"  saved {len(rows)} pages -> {out_path}")
    return {"slug": book_slug, "label": label, "pages": len(rows), "skipped": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Re-download even if present")
    parser.add_argument(
        "--skip-openstax",
        action="store_true",
        help="Only download Hugging Face sources",
    )
    parser.add_argument(
        "--openstax-max-pages",
        type=int,
        default=None,
        help="Optional cap on pages per OpenStax book (debug)",
    )
    args = parser.parse_args()

    ensure_dirs()
    summary = {"hf": [], "openstax": []}

    for spec in HF_SOURCES:
        summary["hf"].append(download_hf_source(spec, force=args.force))

    # Also pin a snapshot pointer for reproducibility metadata
    pin_path = HF_DIR / "hf_sources.json"
    pin_path.write_text(json.dumps([{"name": s["name"], "path": s["path"]} for s in HF_SOURCES], indent=2) + "\n")

    if not args.skip_openstax:
        for slug, label in OPENSTAX_BOOKS:
            try:
                summary["openstax"].append(
                    download_openstax_book(slug, label, force=args.force, max_pages=args.openstax_max_pages)
                )
            except Exception as e:  # noqa: BLE001
                print(f"[error] OpenStax {slug}: {e}", file=sys.stderr)
                summary["openstax"].append({"slug": slug, "label": label, "error": str(e)})

    out_summary = RAW / "download_summary.json"
    out_summary.write_text(json.dumps(summary, indent=2) + "\n")
    print("\n=== Download summary ===")
    print(json.dumps(summary, indent=2))
    print(f"Wrote {out_summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
