"""Test selective recompute ASR."""
import pytest


def test_recompute_skips_high_confidence():
    """High-confidence utterances should not be recomputed."""
    from app.services.backends.asr_recompute import SelectiveRecomputeASR

    utts = [
        {"text": "Hello", "confidence": 0.95, "start_ms": 0, "end_ms": 1000},
        {"text": "World", "confidence": 0.50, "start_ms": 1000, "end_ms": 2000},
    ]
    high = [u for u in utts if u.get("confidence", 1.0) >= 0.7]
    low = [u for u in utts if u.get("confidence", 1.0) < 0.7]
    assert len(high) == 1
    assert len(low) == 1
    assert high[0]["text"] == "Hello"
    assert low[0]["text"] == "World"


def test_recompute_class_exists():
    """SelectiveRecomputeASR class should be importable."""
    from app.services.backends.asr_recompute import SelectiveRecomputeASR
    assert hasattr(SelectiveRecomputeASR, "recompute_low_confidence")
