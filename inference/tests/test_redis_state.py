"""Tests for Redis session state manager.

Uses fakeredis for unit testing (no real Redis needed).
"""
import json
import pytest

try:
    import fakeredis
    HAS_FAKEREDIS = True
except ImportError:
    HAS_FAKEREDIS = False

pytestmark = pytest.mark.skipif(not HAS_FAKEREDIS, reason="fakeredis not installed")

from app.services.redis_state import RedisSessionState


@pytest.fixture
def redis_state():
    r = fakeredis.FakeRedis(decode_responses=True)
    return RedisSessionState(r, ttl_s=7200)


def test_set_and_get_meta(redis_state):
    redis_state.set_meta("sess-1", {"status": "recording", "increments_done": 0})
    meta = redis_state.get_meta("sess-1")
    assert meta["status"] == "recording"
    assert meta["increments_done"] == "0"  # Redis stores as string


def test_update_speaker_profile(redis_state):
    profile = {"centroid": [0.1, 0.2], "total_speech_ms": 5000, "first_seen": 0}
    redis_state.set_speaker_profile("sess-1", "spk_00", profile)
    result = redis_state.get_speaker_profile("sess-1", "spk_00")
    assert json.loads(result)["total_speech_ms"] == 5000


def test_get_all_speaker_profiles(redis_state):
    redis_state.set_speaker_profile("sess-1", "spk_00", {"id": "spk_00"})
    redis_state.set_speaker_profile("sess-1", "spk_01", {"id": "spk_01"})
    profiles = redis_state.get_all_speaker_profiles("sess-1")
    assert len(profiles) == 2


def test_append_checkpoint(redis_state):
    redis_state.append_checkpoint("sess-1", {"index": 0, "summary": "test"})
    redis_state.append_checkpoint("sess-1", {"index": 1, "summary": "test2"})
    chkpts = redis_state.get_all_checkpoints("sess-1")
    assert len(chkpts) == 2
    assert chkpts[0]["index"] == 0


def test_append_utterances(redis_state):
    utts = [{"speaker": "spk_00", "text": "hello"}, {"speaker": "spk_01", "text": "hi"}]
    redis_state.append_utterances("sess-1", 0, utts)
    result = redis_state.get_utterances("sess-1", 0)
    assert len(result) == 2


def test_idempotent_check_read_only(redis_state):
    """is_already_processed is read-only — does NOT mark."""
    assert redis_state.is_already_processed("sess-1", "inc-uuid-1") is False
    # Still not marked (read-only check)
    assert redis_state.is_already_processed("sess-1", "inc-uuid-1") is False


def test_atomic_write_marks_and_prevents_duplicate(redis_state):
    """atomic_write_increment marks as processed; second call returns False."""
    first = redis_state.atomic_write_increment(
        "sess-1", "inc-uuid-1", 0,
        meta_updates={"last_increment": "0"},
        speaker_profiles={}, utterances=[{"text": "hi"}],
    )
    assert first is True
    assert redis_state.is_already_processed("sess-1", "inc-uuid-1") is True
    # Retry — should be rejected (no duplicate RPUSH)
    second = redis_state.atomic_write_increment(
        "sess-1", "inc-uuid-1", 0,
        meta_updates={"last_increment": "0"},
        speaker_profiles={}, utterances=[{"text": "hi"}],
    )
    assert second is False
    # Verify no duplicate utterances
    utts = redis_state.get_utterances("sess-1", 0)
    assert len(utts) == 1  # not 2!


def test_acquire_and_release_session_lock(redis_state):
    assert redis_state.acquire_session_lock("sess-1", "worker-1") is True
    assert redis_state.acquire_session_lock("sess-1", "worker-2") is False
    redis_state.release_session_lock("sess-1", "worker-1")
    assert redis_state.acquire_session_lock("sess-1", "worker-2") is True


def test_ttl_is_set(redis_state):
    redis_state.set_meta("sess-1", {"status": "recording"})
    ttl = redis_state._redis.ttl("session:sess-1:meta")
    assert 7100 < ttl <= 7200


def test_cleanup_session(redis_state):
    redis_state.set_meta("sess-1", {"status": "done"})
    redis_state.set_speaker_profile("sess-1", "spk_00", {"id": "spk_00"})
    redis_state.append_checkpoint("sess-1", {"index": 0})
    redis_state.append_utterances("sess-1", 0, [{"text": "hi"}])
    redis_state.cleanup_session("sess-1")
    assert redis_state.get_meta("sess-1") == {}


def test_get_all_utterances(redis_state):
    redis_state.append_utterances("sess-1", 0, [{"text": "a"}, {"text": "b"}])
    redis_state.append_utterances("sess-1", 1, [{"text": "c"}])
    all_utts = redis_state.get_all_utterances("sess-1")
    assert len(all_utts) == 3


def test_release_lock_wrong_owner(redis_state):
    """Release lock with wrong owner should fail."""
    redis_state.acquire_session_lock("sess-1", "worker-1")
    result = redis_state.release_session_lock("sess-1", "worker-wrong")
    assert result is False
    # Lock still held by worker-1
    assert redis_state.acquire_session_lock("sess-1", "worker-2") is False
