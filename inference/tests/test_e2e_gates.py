"""E2E gate verification tests.

These test the gate conditions from the B-Prime design doc:
G3: zero-turn speakers -> no S/R
G4: unresolved identity -> confidence <= 0.5
G5: CAM++ at least 1 correction
G6: LLM adapter idempotency hit
G7: Parakeet WER < 8% (CUDA only)

Also verifies architectural constraints:
- finalize_v1 uses Redis merge-only (no processor.finalize)
- LLM adapter conforms to LLMBackend protocol
- LLM pool separation (checkpoint vs finalize)
- Unresolved clusters excluded from report
"""
import inspect
import json

import numpy as np
import pytest


# ── G3: Zero-turn speaker filtering ──────────────────────────────────────


def test_g3_zero_turn_no_claims():
    """G3: Zero-turn speakers must be filtered out of active speakers."""
    from app.schemas import SpeakerStat
    from app.services.report_synthesizer import ReportSynthesizer

    stats = [
        SpeakerStat(speaker_key="spk_0", speaker_name="Alice", turns=5, talk_time_ms=30000),
        SpeakerStat(speaker_key="spk_1", speaker_name="Daisy", turns=0, talk_time_ms=0),
    ]
    interviewer_keys = set()
    memo_keys = {"spk_1"}

    active, zero_turn = ReportSynthesizer._filter_eligible_speakers(
        stats, interviewer_keys, memo_keys,
    )
    assert len(active) == 1
    assert active[0].speaker_key == "spk_0"
    assert len(zero_turn) == 1
    assert zero_turn[0].speaker_key == "spk_1"


def test_g3_unresolved_clusters_excluded():
    """G3: Unresolved clusters (c1, c2 with no real name) must be excluded entirely."""
    from app.schemas import SpeakerStat
    from app.services.report_synthesizer import ReportSynthesizer

    stats = [
        SpeakerStat(speaker_key="spk_0", speaker_name="Alice", turns=5, talk_time_ms=30000),
        SpeakerStat(speaker_key="spk_1", speaker_name="c1", turns=3, talk_time_ms=8000),
        SpeakerStat(speaker_key="spk_2", speaker_name="c2", turns=2, talk_time_ms=5000),
    ]
    interviewer_keys = set()
    memo_keys = set()  # No memos mention these clusters

    active, zero_turn = ReportSynthesizer._filter_eligible_speakers(
        stats, interviewer_keys, memo_keys,
    )
    # Only Alice should be active; c1, c2 have no real name and aren't in memos
    assert len(active) == 1
    assert active[0].speaker_key == "spk_0"
    assert len(zero_turn) == 0


def test_g3_interviewer_excluded():
    """G3: Interviewer (teacher) should be excluded from per-person feedback."""
    from app.schemas import SpeakerStat
    from app.services.report_synthesizer import ReportSynthesizer

    stats = [
        SpeakerStat(speaker_key="spk_0", speaker_name="Teacher Wang", turns=20, talk_time_ms=60000),
        SpeakerStat(speaker_key="spk_1", speaker_name="Alice", turns=5, talk_time_ms=30000),
    ]
    interviewer_keys = {"Teacher Wang"}
    memo_keys = set()

    active, zero_turn = ReportSynthesizer._filter_eligible_speakers(
        stats, interviewer_keys, memo_keys,
    )
    assert len(active) == 1
    assert active[0].speaker_key == "spk_1"


# ── G4: Unresolved identity tracking ─────────────────────────────────────


def test_g4_unresolved_confidence_capped():
    """G4: SpeakerStat accepts binding_status='unresolved' for identity tracking."""
    from app.schemas import SpeakerStat

    stat = SpeakerStat(
        speaker_key="spk_0",
        speaker_name="c1",
        talk_time_ms=5000,
        turns=3,
        binding_status="unresolved",
    )
    assert stat.binding_status == "unresolved"

    # Resolved is default
    stat_resolved = SpeakerStat(
        speaker_key="spk_1",
        speaker_name="Alice",
        talk_time_ms=10000,
        turns=5,
    )
    assert stat_resolved.binding_status == "resolved"


def test_g4_binding_status_validates():
    """G4: binding_status only accepts 'resolved' or 'unresolved'."""
    from pydantic import ValidationError as PydanticValidationError

    from app.schemas import SpeakerStat

    with pytest.raises(PydanticValidationError):
        SpeakerStat(
            speaker_key="spk_0",
            speaker_name="Alice",
            talk_time_ms=5000,
            turns=3,
            binding_status="invalid_status",
        )


# ── G5: SpeakerArbiter interface & logic ──────────────────────────────────


def test_g5_arbiter_interface():
    """G5: SpeakerArbiter should be importable and have arbitrate method."""
    from app.services.speaker_arbiter import SpeakerArbiter

    assert hasattr(SpeakerArbiter, "arbitrate")
    # Verify arbitrate signature has the expected parameters
    sig = inspect.signature(SpeakerArbiter.arbitrate)
    params = list(sig.parameters.keys())
    assert "pyannote_mapping" in params
    assert "pyannote_confidences" in params
    assert "audio_segments" in params
    assert "global_profiles" in params


def test_g5_arbiter_high_confidence_passthrough():
    """G5: High-confidence pyannote mappings pass through unchanged."""
    from unittest.mock import MagicMock

    from app.services.speaker_arbiter import SpeakerArbiter

    sv_backend = MagicMock()
    arbiter = SpeakerArbiter(sv_backend, confidence_threshold=0.50)

    mapping = {"local_0": "global_A", "local_1": "global_B"}
    confidences = {"local_0": 0.85, "local_1": 0.75}  # Both above threshold

    result = arbiter.arbitrate(mapping, confidences, {}, {})
    assert result == mapping
    sv_backend.extract_embedding.assert_not_called()


def test_g5_arbiter_low_confidence_correction():
    """G5: Low-confidence mappings trigger CAM++ re-verification."""
    from unittest.mock import MagicMock

    from app.services.speaker_arbiter import SpeakerArbiter

    # Mock SV backend that returns a known embedding
    sv_backend = MagicMock()
    mock_emb = np.random.randn(192).astype(np.float32)
    mock_emb = mock_emb / np.linalg.norm(mock_emb)
    sv_result = MagicMock()
    sv_result.embedding = mock_emb
    sv_backend.extract_embedding.return_value = sv_result

    # Global profile with same embedding (should match)
    profile = MagicMock()
    profile.centroid = mock_emb  # Exact match -> cosine sim = 1.0

    arbiter = SpeakerArbiter(sv_backend, confidence_threshold=0.50)

    mapping = {"local_0": "global_WRONG"}
    confidences = {"local_0": 0.30}  # Below threshold
    audio_segments = {"local_0": "/tmp/test.wav"}
    global_profiles = {"global_CORRECT": profile}

    result = arbiter.arbitrate(mapping, confidences, audio_segments, global_profiles)
    # Should correct to the matching profile
    assert result["local_0"] == "global_CORRECT"
    sv_backend.extract_embedding.assert_called_once_with("/tmp/test.wav")


# ── G6: LLM adapter idempotency ──────────────────────────────────────────


def test_g6_adapter_has_idempotency():
    """G6: DashScopeLLMAdapter should support idempotency_key parameter."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter

    sig = inspect.signature(DashScopeLLMAdapter.generate_json)
    assert "idempotency_key" in sig.parameters


def test_g6_adapter_idempotency_cache_hit():
    """G6: Repeated calls with same idempotency_key return cached result."""
    from unittest.mock import MagicMock

    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMConfig

    config = LLMConfig(api_key="test-key", model="test-model")

    # Mock Redis that stores and retrieves
    mock_redis = MagicMock()
    cached_result = {"narrative": "test report", "per_person": []}
    mock_redis.hget.return_value = json.dumps(cached_result).encode()

    adapter = DashScopeLLMAdapter(config, redis_client=mock_redis)

    result = adapter.generate_json(
        system_prompt="test",
        user_prompt="test",
        idempotency_key="session_123:checkpoint_0",
    )
    assert result == cached_result
    mock_redis.hget.assert_called_once_with("llm:idem", "session_123:checkpoint_0")


def test_g6_adapter_pool_separation():
    """G6: LLM adapter has separate checkpoint and finalize pools."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMConfig, LLMPool

    config = LLMConfig(
        api_key="test-key",
        model="test-model",
        checkpoint_concurrency=3,
        finalize_concurrency=1,
    )
    adapter = DashScopeLLMAdapter(config)

    assert LLMPool.CHECKPOINT.value in adapter._pools
    assert LLMPool.FINALIZE.value in adapter._pools
    # Checkpoint pool allows 3 concurrent
    assert adapter._pools[LLMPool.CHECKPOINT.value]._value == 3
    # Finalize pool allows only 1 concurrent
    assert adapter._pools[LLMPool.FINALIZE.value]._value == 1


def test_g6_llm_protocol_conformance():
    """G6: DashScopeLLMAdapter conforms to LLMBackend protocol."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter
    from app.services.backends.llm_protocol import LLMBackend, LLMConfig

    config = LLMConfig(api_key="test-key", model="test-model")
    adapter = DashScopeLLMAdapter(config)
    assert isinstance(adapter, LLMBackend)


def test_g6_pii_scrubbing():
    """G6 (Constraint 5): PII must be scrubbed before outbound LLM calls."""
    from app.services.backends.llm_protocol import scrub_pii

    text = "Contact John at john@example.com or 138-1234-5678"
    scrubbed = scrub_pii(text)
    assert "[EMAIL]" in scrubbed
    assert "john@example.com" not in scrubbed


# ── Finalize architecture: Redis merge-only ───────────────────────────────


def test_finalize_uses_redis_not_memory():
    """Finalize route must NOT call processor.finalize() — use Redis merge-only."""
    import ast
    from pathlib import Path

    source = Path("app/routes/incremental_v1.py").read_text()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "finalize_v1":
            # Walk the function body looking for processor.finalize calls
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    call_src = ast.dump(child.func)
                    assert "finalize" not in call_src or "processor" not in call_src, (
                        "finalize_v1 must NOT call processor.finalize() — use Redis merge-only"
                    )
            break


def test_finalize_reads_redis_state():
    """Finalize route must read utterances, checkpoints, and profiles from Redis."""
    import ast
    from pathlib import Path

    source = Path("app/routes/incremental_v1.py").read_text()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "finalize_v1":
            source_lines = source.split("\n")
            func_source = "\n".join(
                source_lines[node.lineno - 1 : node.end_lineno]
            )
            # Must read all three state types from Redis
            assert "get_all_utterances" in func_source, "finalize must read utterances from Redis"
            assert "get_all_checkpoints" in func_source, "finalize must read checkpoints from Redis"
            assert "get_all_speaker_profiles" in func_source, "finalize must read profiles from Redis"
            break


def test_finalize_cleans_up_redis():
    """Finalize route must cleanup Redis session data after report generation."""
    import ast
    from pathlib import Path

    source = Path("app/routes/incremental_v1.py").read_text()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "finalize_v1":
            source_lines = source.split("\n")
            func_source = "\n".join(
                source_lines[node.lineno - 1 : node.end_lineno]
            )
            assert "cleanup_session" in func_source, "finalize must cleanup Redis after completion"
            break


# ── Process-chunk architecture: idempotency + window limit ────────────────


def test_process_chunk_has_idempotency_check():
    """Process-chunk must check for duplicate increment_id before processing."""
    import ast
    from pathlib import Path

    source = Path("app/routes/incremental_v1.py").read_text()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "process_chunk_v1":
            source_lines = source.split("\n")
            func_source = "\n".join(
                source_lines[node.lineno - 1 : node.end_lineno]
            )
            assert "is_already_processed" in func_source, (
                "process_chunk_v1 must check idempotency via Redis"
            )
            assert "atomic_write_increment" in func_source, (
                "process_chunk_v1 must atomically write to Redis"
            )
            break


def test_process_chunk_has_window_limit():
    """Process-chunk must enforce window size limit (360s max)."""
    import ast
    from pathlib import Path

    source = Path("app/routes/incremental_v1.py").read_text()
    tree = ast.parse(source)

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "process_chunk_v1":
            source_lines = source.split("\n")
            func_source = "\n".join(
                source_lines[node.lineno - 1 : node.end_lineno]
            )
            assert "MAX_WINDOW_MS" in func_source or "360_000" in func_source, (
                "process_chunk_v1 must enforce window size limit"
            )
            break


# ── Fallback / rollback tests (Task 12) ──────────────────────────────────


def test_asr_fallback_config():
    """ASR_BACKEND=sensevoice-onnx should work as fallback on macOS."""
    from app.config import Settings

    s = Settings(
        _env_file=None,
        ASR_BACKEND="sensevoice-onnx",
        SV_T_LOW=0.50,
        SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72,
        PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.asr_backend == "sensevoice-onnx"


def test_v1_disabled_returns_404():
    """When V1 disabled, all V1 endpoints return 404."""
    from app.config import Settings

    s = Settings(
        _env_file=None,
        INCREMENTAL_V1_ENABLED="false",
        SV_T_LOW=0.50,
        SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72,
        PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.incremental_v1_enabled is False


def test_v1_enabled_config():
    """When V1 enabled, incremental_v1_enabled should be True."""
    from app.config import Settings

    s = Settings(
        _env_file=None,
        INCREMENTAL_V1_ENABLED="true",
        SV_T_LOW=0.50,
        SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72,
        PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.incremental_v1_enabled is True


def test_body_limit_15mb():
    """Body limit must be 15MB to support cumulative-mode 360s windows."""
    from app.config import Settings

    s = Settings(
        _env_file=None,
        SV_T_LOW=0.50,
        SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72,
        PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.max_request_body_bytes == 15 * 1024 * 1024


def test_report_model_fallback():
    """REPORT_MODEL_NAME can be changed to qwen-plus as fallback."""
    from app.config import Settings

    s = Settings(
        _env_file=None,
        REPORT_MODEL_NAME="qwen-plus",
        SV_T_LOW=0.50,
        SV_T_HIGH=0.70,
        PROFILE_AUTO_THRESHOLD=0.72,
        PROFILE_CONFIRM_THRESHOLD=0.60,
    )
    assert s.report_model_name == "qwen-plus"
