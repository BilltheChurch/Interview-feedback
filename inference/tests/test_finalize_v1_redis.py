"""Test Redis merge-only finalize helpers."""

from app.routes.incremental_v1 import (
    _build_transcript,
    _compute_stats,
    _merge_checkpoints,
    _merge_redis_profiles,
    _remap_utterances,
)


class FakeSettings:
    incremental_finalize_merge_threshold = 0.55


def _make_profile(spk_id: str, centroid: list[float], speech_ms: int = 5000, name: str | None = None):
    return {
        "speaker_id": spk_id,
        "centroid": centroid,
        "total_speech_ms": speech_ms,
        "first_seen_increment": 0,
        "display_name": name,
    }


def test_merge_profiles_identical_centroids():
    """Two profiles with very similar centroids should merge."""
    c = [0.1] * 192
    profiles = {
        "spk_00": _make_profile("spk_00", c, 3000, "Alice"),
        "spk_01": _make_profile("spk_01", [x + 0.001 for x in c], 2000, None),
    }
    merged, merge_map = _merge_redis_profiles(profiles, FakeSettings())
    assert len(merged) == 1
    kept = list(merged.values())[0]
    assert kept["display_name"] == "Alice"
    assert kept["total_speech_ms"] == 5000


def test_merge_profiles_different_centroids():
    """Two profiles with orthogonal centroids should NOT merge."""
    profiles = {
        "spk_00": _make_profile("spk_00", [1.0] + [0.0] * 191, 3000),
        "spk_01": _make_profile("spk_01", [0.0] + [1.0] + [0.0] * 190, 2000),
    }
    merged, merge_map = _merge_redis_profiles(profiles, FakeSettings())
    assert len(merged) == 2


def test_remap_utterances():
    """Utterances should have speaker IDs remapped to merged profile."""
    merge_map = {"spk_00": "spk_00", "spk_01": "spk_00"}
    profiles = {"spk_00": _make_profile("spk_00", [0.1] * 192, name="Alice")}
    utts = [
        {"speaker": "spk_00", "text": "Hello", "start_ms": 0, "end_ms": 1000},
        {"speaker": "spk_01", "text": "World", "start_ms": 1000, "end_ms": 2000},
    ]
    remapped = _remap_utterances(utts, profiles, merge_map)
    assert all(u["speaker"] == "spk_00" for u in remapped)


def test_build_transcript_sorted():
    """Transcript should be sorted by start_ms."""
    utts = [
        {"speaker": "spk_00", "text": "B", "start_ms": 2000, "end_ms": 3000},
        {"speaker": "spk_00", "text": "A", "start_ms": 0, "end_ms": 1000},
    ]
    transcript = _build_transcript(utts)
    assert transcript[0]["text"] == "A"
    assert transcript[1]["text"] == "B"


def test_compute_stats():
    """Stats should count talk_time and turns per speaker."""
    utts = [
        {"speaker": "spk_00", "text": "Hi", "start_ms": 0, "end_ms": 3000},
        {"speaker": "spk_00", "text": "Again", "start_ms": 5000, "end_ms": 7000},
        {"speaker": "spk_01", "text": "Hey", "start_ms": 3000, "end_ms": 5000},
    ]
    stats = _compute_stats(utts, 10000)
    stats_map = {s["speaker_key"]: s for s in stats}
    assert stats_map["spk_00"]["turns"] == 2
    assert stats_map["spk_00"]["talk_time_ms"] == 5000
    assert stats_map["spk_01"]["turns"] == 1


def test_merge_checkpoints():
    """Checkpoint summaries should be concatenated."""
    chkpts = [
        {"summary": "Alice spoke about X."},
        {"summary": "Bob discussed Y."},
    ]
    merged = _merge_checkpoints(chkpts)
    assert "Alice" in merged
    assert "Bob" in merged
