from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(slots=True)
class NameCandidate:
    name: str
    confidence: float


class NameResolver:
    _patterns = [
        (re.compile(r"\bmy name is\s+([a-z][a-z\s'\-]{1,50})\b", re.IGNORECASE), 0.95),
        (re.compile(r"\bi\s+am\s+([a-z][a-z\s'\-]{1,50})\b", re.IGNORECASE), 0.90),
        (re.compile(r"\bi'm\s+([a-z][a-z\s'\-]{1,50})\b", re.IGNORECASE), 0.90),
    ]

    @staticmethod
    def _normalize_name(raw: str) -> str:
        cleaned = " ".join(raw.strip().split())
        parts = [part for part in cleaned.split(" ") if part]
        return " ".join(part.capitalize() for part in parts)

    def extract(self, text: str | None) -> list[NameCandidate]:
        if not text:
            return []

        candidates: dict[str, NameCandidate] = {}
        for pattern, confidence in self._patterns:
            for match in pattern.finditer(text):
                normalized = self._normalize_name(match.group(1))
                if len(normalized) < 2:
                    continue
                existing = candidates.get(normalized)
                if existing is None or existing.confidence < confidence:
                    candidates[normalized] = NameCandidate(name=normalized, confidence=confidence)

        ordered = sorted(candidates.values(), key=lambda item: item.confidence, reverse=True)
        return ordered
