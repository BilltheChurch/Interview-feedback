from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(slots=True)
class NameCandidate:
    name: str
    confidence: float


class NameResolver:
    _max_name_tokens = 4
    _blocked_tokens = {
        "a",
        "am",
        "an",
        "and",
        "at",
        "be",
        "because",
        "but",
        "by",
        "currently",
        "doing",
        "for",
        "from",
        "going",
        "happy",
        "here",
        "hi",
        "hello",
        "i",
        "im",
        "in",
        "interested",
        "is",
        "it",
        "my",
        "name",
        "now",
        "of",
        "on",
        "our",
        "please",
        "really",
        "studying",
        "that",
        "the",
        "this",
        "to",
        "just",
        "uh",
        "um",
        "we",
        "with",
    }
    _patterns = [
        (re.compile(r"\bmy name is\s+([a-z][a-z\s'\-]{1,80})", re.IGNORECASE), 0.95),
        (re.compile(r"\bi\s+am\s+([a-z][a-z\s'\-]{1,80})", re.IGNORECASE), 0.90),
        (re.compile(r"\bi'm\s+([a-z][a-z\s'\-]{1,80})", re.IGNORECASE), 0.90),
        (re.compile(r"\b(?:please\s+)?call me\s+([a-z][a-z\s'\-]{1,80})", re.IGNORECASE), 0.88),
    ]

    @classmethod
    def _normalize_name(cls, raw: str) -> str | None:
        # Limit candidate span to the first phrase and reject common non-name tokens.
        clipped = re.split(r"[,.;:!?()\[\]\n\r]", raw, maxsplit=1)[0]
        cleaned = " ".join(clipped.strip().split())
        if not cleaned:
            return None

        parts: list[str] = []
        for part in cleaned.split(" "):
            token = part.strip(" '\"-").lower()
            if not token:
                continue
            if token in cls._blocked_tokens:
                if parts:
                    break
                return None
            if not re.fullmatch(r"[a-z][a-z'\-]{0,29}", token):
                if parts:
                    break
                return None
            parts.append(token)
            if len(parts) > cls._max_name_tokens:
                return None

        if not parts:
            return None

        normalized = " ".join(part.capitalize() for part in parts)
        return normalized if len(normalized) >= 2 else None

    def extract(self, text: str | None) -> list[NameCandidate]:
        if not text:
            return []

        candidates: dict[str, NameCandidate] = {}
        for pattern, confidence in self._patterns:
            for match in pattern.finditer(text):
                normalized = self._normalize_name(match.group(1))
                if not normalized:
                    continue
                existing = candidates.get(normalized)
                if existing is None or existing.confidence < confidence:
                    candidates[normalized] = NameCandidate(name=normalized, confidence=confidence)

        ordered = sorted(candidates.values(), key=lambda item: item.confidence, reverse=True)
        return ordered
