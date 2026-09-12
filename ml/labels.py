"""Shared 8-subject taxonomy (must match server/subjects.js)."""

from __future__ import annotations

SUBJECTS: list[str] = [
    "Mathematics",
    "Physics",
    "Chemistry",
    "Biology",
    "Computer Science",
    "History",
    "Literature",
    "Economics",
]

LABEL2ID: dict[str, int] = {s: i for i, s in enumerate(SUBJECTS)}
ID2LABEL: dict[int, str] = {i: s for i, s in enumerate(SUBJECTS)}

VERBALIZER_TEMPLATE = "This student note is about {subject}."


def verbalizer_for(subject: str) -> str:
    return VERBALIZER_TEMPLATE.format(subject=subject)
