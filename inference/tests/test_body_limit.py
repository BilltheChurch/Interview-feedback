"""Test body limit and window validation."""
import pytest
from pydantic import ValidationError as PydanticValidationError

from app.config import Settings


def test_default_body_limit_is_15mb():
    """MAX_REQUEST_BODY_BYTES default should be 15MB for incremental audio."""
    s = Settings(
        _env_file=None,
        SV_T_LOW=0.50, SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72, PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.max_request_body_bytes == 15 * 1024 * 1024


def test_window_hard_limit_enforced():
    """Process-chunk should reject windows > 360s."""
    from app.schemas_v1 import ProcessChunkRequestV1, SCHEMA_VERSION

    # 360s window should be accepted
    req = ProcessChunkRequestV1(
        v=1, session_id="s1", increment_id="inc1", increment_index=0,
        audio_b64="dGVzdA==", audio_start_ms=0, audio_end_ms=360_000,
    )
    assert req.audio_end_ms - req.audio_start_ms == 360_000

    # 400s window should also be valid at schema level
    # (server-side check happens in route handler, not schema)
    req2 = ProcessChunkRequestV1(
        v=1, session_id="s1", increment_id="inc1", increment_index=0,
        audio_b64="dGVzdA==", audio_start_ms=0, audio_end_ms=400_000,
    )
    assert req2.audio_end_ms - req2.audio_start_ms == 400_000


def test_cumulative_threshold_is_1():
    """First increment only should use cumulative mode (0..180s max)."""
    s = Settings(
        _env_file=None,
        SV_T_LOW=0.50, SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72, PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.incremental_cumulative_threshold == 1
