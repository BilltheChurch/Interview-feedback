# Incremental Pipeline V2 (B+) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the incremental audio processing pipeline with WebSocket binary streaming, Redis state, pluggable model backends, and CAM++ arbitration — targeting p95 < 60s final report for 30-minute English interviews.

**Architecture:** Worker sends PCM via WebSocket binary frames to Inference, which is the sole writer to Redis session state. Pluggable ASR/Diarization/SV backends support A/B testing. CAM++ acts as arbitration layer (low-confidence only). LLM stays on DashScope qwen-plus with 6 engineering constraints. Finalize uses R2 segment refs instead of re-transmitting audio.

**Tech Stack:** Python 3.11+, FastAPI, Redis (redis-py), WebSocket (fastapi.websockets), Protocol classes, pytest, TypeScript (CF Worker), Vitest

**Design doc:** `docs/plans/2026-03-02-incremental-pipeline-v2-design.md`

---

## Phase 1: Redis Foundation + Config (Inference)

### Task 1: Add Redis dependency and config settings

**Files:**
- Modify: `inference/requirements.txt`
- Modify: `inference/app/config.py:89-117`
- Modify: `inference/.env.example`
- Test: `inference/tests/test_config.py` (if exists, else create)

**Step 1: Write the failing test**

```python
# inference/tests/test_redis_config.py
"""Tests for Redis configuration settings."""
import pytest
from app.config import Settings


def test_redis_url_default():
    """Redis URL has sensible default for local dev."""
    s = Settings(INFERENCE_API_KEY="test")
    assert s.redis_url == "redis://localhost:6379/0"


def test_redis_url_from_env(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://prod:6379/1")
    monkeypatch.setenv("INFERENCE_API_KEY", "test")
    s = Settings()
    assert s.redis_url == "redis://prod:6379/1"


def test_session_ttl_default():
    s = Settings(INFERENCE_API_KEY="test")
    assert s.redis_session_ttl_s == 7200


def test_ws_port_default():
    s = Settings(INFERENCE_API_KEY="test")
    assert s.ws_port == 8001
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_redis_config.py -v`
Expected: FAIL — `Settings` has no `redis_url` attribute

**Step 3: Add Redis to requirements and config**

Add to `inference/requirements.txt`:
```
redis>=5.0.0
```

Add to `inference/app/config.py` (after line 117, before `incremental_max_sessions`):
```python
    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    redis_session_ttl_s: int = Field(default=7200, alias="REDIS_SESSION_TTL_S")

    # WebSocket server
    ws_port: int = Field(default=8001, alias="WS_PORT")
```

Add to `inference/.env.example`:
```
REDIS_URL=redis://localhost:6379/0
REDIS_SESSION_TTL_S=7200
WS_PORT=8001
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_redis_config.py -v`
Expected: 4 passed

**Step 5: Commit**

```bash
git add inference/requirements.txt inference/app/config.py inference/.env.example inference/tests/test_redis_config.py
git commit -m "feat(inference): add Redis config settings and WS port"
```

---

### Task 2: Redis session state manager

**Files:**
- Create: `inference/app/services/redis_state.py`
- Test: `inference/tests/test_redis_state.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_redis_state.py
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


def test_idempotent_check(redis_state):
    assert redis_state.try_mark_processed("sess-1", "inc-uuid-1") is True
    assert redis_state.try_mark_processed("sess-1", "inc-uuid-1") is False  # duplicate


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
```

**Step 2: Run test to verify it fails**

Run: `cd inference && pip install fakeredis && python -m pytest tests/test_redis_state.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.redis_state'`

**Step 3: Implement RedisSessionState**

```python
# inference/app/services/redis_state.py
"""Redis-backed session state manager.

Single-writer principle: only Inference writes session state.
Worker reads via API endpoints.

Key structure:
  session:{id}:meta       → Hash  (status, increments_done, etc.)
  session:{id}:profiles   → Hash  (field=spk_id, value=JSON)
  session:{id}:chkpts     → List  (append-only CheckpointResponse JSON)
  session:{id}:utts:{N}   → List  (append-only utterance JSON)
  session:{id}:idem       → Hash  (increment_id → "processed")
  session:{id}:lock       → String (distributed lock)
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from redis import Redis

logger = logging.getLogger(__name__)


class RedisSessionState:
    """Thread-safe Redis session state with single-writer semantics."""

    def __init__(self, redis_client: Redis, ttl_s: int = 7200) -> None:
        self._redis = redis_client
        self._ttl = ttl_s

    # ── Keys ──────────────────────────────────────────────────────────

    def _key(self, session_id: str, suffix: str) -> str:
        return f"session:{session_id}:{suffix}"

    def _refresh_ttl(self, session_id: str, *suffixes: str) -> None:
        pipe = self._redis.pipeline(transaction=False)
        for suffix in suffixes:
            pipe.expire(self._key(session_id, suffix), self._ttl)
        pipe.execute()

    # ── Meta (Hash) ───────────────────────────────────────────────────

    def set_meta(self, session_id: str, mapping: dict[str, Any]) -> None:
        key = self._key(session_id, "meta")
        self._redis.hset(key, mapping={str(k): str(v) for k, v in mapping.items()})
        self._redis.expire(key, self._ttl)

    def get_meta(self, session_id: str) -> dict[str, str]:
        return self._redis.hgetall(self._key(session_id, "meta"))

    # ── Speaker Profiles (Hash) ───────────────────────────────────────

    def set_speaker_profile(
        self, session_id: str, speaker_id: str, profile: dict
    ) -> None:
        key = self._key(session_id, "profiles")
        self._redis.hset(key, speaker_id, json.dumps(profile))
        self._redis.expire(key, self._ttl)

    def get_speaker_profile(self, session_id: str, speaker_id: str) -> str | None:
        return self._redis.hget(self._key(session_id, "profiles"), speaker_id)

    def get_all_speaker_profiles(self, session_id: str) -> dict[str, dict]:
        raw = self._redis.hgetall(self._key(session_id, "profiles"))
        return {k: json.loads(v) for k, v in raw.items()}

    # ── Checkpoints (List, append-only) ───────────────────────────────

    def append_checkpoint(self, session_id: str, checkpoint: dict) -> None:
        key = self._key(session_id, "chkpts")
        self._redis.rpush(key, json.dumps(checkpoint))
        self._redis.expire(key, self._ttl)

    def get_all_checkpoints(self, session_id: str) -> list[dict]:
        raw = self._redis.lrange(self._key(session_id, "chkpts"), 0, -1)
        return [json.loads(item) for item in raw]

    # ── Utterances (List per increment, append-only) ──────────────────

    def append_utterances(
        self, session_id: str, increment_index: int, utterances: list[dict]
    ) -> None:
        key = self._key(session_id, f"utts:{increment_index}")
        if utterances:
            self._redis.rpush(key, *[json.dumps(u) for u in utterances])
            self._redis.expire(key, self._ttl)

    def get_utterances(self, session_id: str, increment_index: int) -> list[dict]:
        raw = self._redis.lrange(
            self._key(session_id, f"utts:{increment_index}"), 0, -1
        )
        return [json.loads(item) for item in raw]

    def get_all_utterances(self, session_id: str, max_increments: int = 100) -> list[dict]:
        all_utts = []
        for i in range(max_increments):
            utts = self.get_utterances(session_id, i)
            if not utts:
                break
            all_utts.extend(utts)
        return all_utts

    # ── Idempotency (Hash) ────────────────────────────────────────────

    def try_mark_processed(self, session_id: str, increment_id: str) -> bool:
        """Returns True if newly marked, False if already processed (duplicate)."""
        key = self._key(session_id, "idem")
        result = self._redis.hsetnx(key, increment_id, "processed")
        self._redis.expire(key, self._ttl)
        return bool(result)

    # ── Distributed Lock ──────────────────────────────────────────────

    def acquire_session_lock(
        self, session_id: str, worker_id: str, lock_ttl_s: int = 300
    ) -> bool:
        key = self._key(session_id, "lock")
        return bool(self._redis.set(key, worker_id, nx=True, ex=lock_ttl_s))

    def release_session_lock(self, session_id: str, worker_id: str) -> bool:
        key = self._key(session_id, "lock")
        current = self._redis.get(key)
        if current == worker_id:
            self._redis.delete(key)
            return True
        return False

    # ── Atomic Increment Write ────────────────────────────────────────

    def atomic_write_increment(
        self,
        session_id: str,
        increment_id: str,
        increment_index: int,
        meta_updates: dict[str, Any],
        speaker_profiles: dict[str, dict],
        utterances: list[dict],
        checkpoint: dict | None = None,
    ) -> None:
        """Atomic write of a full increment result using Redis pipeline."""
        pipe = self._redis.pipeline(transaction=True)

        # Meta update
        meta_key = self._key(session_id, "meta")
        pipe.hset(meta_key, mapping={str(k): str(v) for k, v in meta_updates.items()})
        pipe.expire(meta_key, self._ttl)

        # Speaker profiles (per-field HSET)
        prof_key = self._key(session_id, "profiles")
        for spk_id, profile in speaker_profiles.items():
            pipe.hset(prof_key, spk_id, json.dumps(profile))
        if speaker_profiles:
            pipe.expire(prof_key, self._ttl)

        # Utterances (append-only)
        utt_key = self._key(session_id, f"utts:{increment_index}")
        if utterances:
            pipe.rpush(utt_key, *[json.dumps(u) for u in utterances])
            pipe.expire(utt_key, self._ttl)

        # Checkpoint (append-only)
        if checkpoint:
            chkpt_key = self._key(session_id, "chkpts")
            pipe.rpush(chkpt_key, json.dumps(checkpoint))
            pipe.expire(chkpt_key, self._ttl)

        # Idempotency
        idem_key = self._key(session_id, "idem")
        pipe.hsetnx(idem_key, increment_id, "processed")
        pipe.expire(idem_key, self._ttl)

        pipe.execute()

    # ── Cleanup ───────────────────────────────────────────────────────

    def cleanup_session(self, session_id: str) -> int:
        """Delete all keys for a session. Returns number of keys deleted."""
        pattern = f"session:{session_id}:*"
        keys = list(self._redis.scan_iter(match=pattern, count=100))
        if keys:
            return self._redis.delete(*keys)
        return 0
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_redis_state.py -v`
Expected: 10 passed

**Step 5: Commit**

```bash
git add inference/app/services/redis_state.py inference/tests/test_redis_state.py
git commit -m "feat(inference): add Redis session state manager with single-writer semantics"
```

---

## Phase 2: Pluggable Backend Protocols

### Task 3: ASR Backend protocol + existing backend adapters

**Files:**
- Create: `inference/app/services/backends/__init__.py`
- Create: `inference/app/services/backends/asr_protocol.py`
- Create: `inference/app/services/backends/asr_sensevoice_onnx.py`
- Create: `inference/app/services/backends/asr_faster_whisper.py`
- Test: `inference/tests/test_asr_protocol.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_asr_protocol.py
"""Tests for ASR backend protocol compliance."""
import pytest
from app.services.backends.asr_protocol import ASRBackend, TranscriptSegment


def test_protocol_requires_name():
    """Any ASR backend must expose a name property."""
    class BadBackend:
        pass

    assert not isinstance(BadBackend(), ASRBackend)


def test_protocol_requires_transcribe():
    class MinimalBackend:
        @property
        def name(self) -> str:
            return "test"

        @property
        def supports_streaming(self) -> bool:
            return False

        @property
        def supports_word_timestamps(self) -> bool:
            return False

        def transcribe(self, wav_path, language="auto", *, word_timestamps=False):
            return []

        def transcribe_segment(self, wav_path, start_ms, end_ms, language="auto"):
            return []

    backend = MinimalBackend()
    assert isinstance(backend, ASRBackend)
    assert backend.name == "test"


def test_transcript_segment_dataclass():
    seg = TranscriptSegment(
        text="Hello world",
        start_ms=0,
        end_ms=1500,
        language="en",
        confidence=0.95,
    )
    assert seg.text == "Hello world"
    assert seg.duration_ms == 1500
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_asr_protocol.py -v`
Expected: FAIL — module not found

**Step 3: Implement ASR protocol**

```python
# inference/app/services/backends/__init__.py
"""Pluggable backend layer for ASR, Diarization, SV, and LLM."""

# inference/app/services/backends/asr_protocol.py
"""ASR Backend protocol — all ASR implementations must conform to this."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class TranscriptSegment:
    """A single transcribed segment with timing and confidence."""
    text: str
    start_ms: int
    end_ms: int
    language: str = "auto"
    confidence: float = 1.0
    words: list[dict] | None = None  # word-level timestamps if available

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@runtime_checkable
class ASRBackend(Protocol):
    """Pluggable ASR backend interface.

    Implementations: SenseVoiceONNX, FasterWhisper, DistilWhisper,
    ParakeetTDT, MoonshineONNX.
    """

    @property
    def name(self) -> str: ...

    @property
    def supports_streaming(self) -> bool: ...

    @property
    def supports_word_timestamps(self) -> bool: ...

    def transcribe(
        self,
        wav_path: str,
        language: str = "auto",
        *,
        word_timestamps: bool = False,
    ) -> list[TranscriptSegment]: ...

    def transcribe_segment(
        self,
        wav_path: str,
        start_ms: int,
        end_ms: int,
        language: str = "auto",
    ) -> list[TranscriptSegment]: ...
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_asr_protocol.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
git add inference/app/services/backends/
git add inference/tests/test_asr_protocol.py
git commit -m "feat(inference): add ASR backend protocol for pluggable model backends"
```

---

### Task 4: Diarization + SV backend protocols

**Files:**
- Create: `inference/app/services/backends/diarization_protocol.py`
- Create: `inference/app/services/backends/sv_protocol.py`
- Test: `inference/tests/test_backend_protocols.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_backend_protocols.py
"""Tests for Diarization and SV backend protocols."""
import numpy as np
import pytest

from app.services.backends.diarization_protocol import (
    DiarizationBackend,
    DiarizationResult,
    SpeakerSegment,
)
from app.services.backends.sv_protocol import SVBackend, EmbeddingResult


def test_diarization_segment():
    seg = SpeakerSegment(speaker_id="spk_00", start_ms=0, end_ms=5000)
    assert seg.duration_ms == 5000


def test_diarization_result():
    result = DiarizationResult(
        segments=[
            SpeakerSegment("spk_00", 0, 5000),
            SpeakerSegment("spk_01", 5000, 10000),
        ],
        embeddings={"spk_00": np.zeros(192), "spk_01": np.ones(192)},
        processing_time_ms=1500,
    )
    assert len(result.segments) == 2
    assert result.speaker_count == 2


def test_diarization_protocol_check():
    class FakeDiarizer:
        @property
        def name(self) -> str:
            return "fake"

        def diarize(self, wav_path, num_speakers=None):
            return DiarizationResult([], {}, 0)

    assert isinstance(FakeDiarizer(), DiarizationBackend)


def test_sv_embedding_result():
    emb = EmbeddingResult(
        embedding=np.random.randn(192).astype(np.float32),
        confidence=0.92,
    )
    assert emb.embedding.shape == (192,)
    assert emb.dim == 192


def test_sv_protocol_check():
    class FakeSV:
        @property
        def name(self) -> str:
            return "fake-sv"

        @property
        def embedding_dim(self) -> int:
            return 192

        def extract_embedding(self, wav_path):
            return EmbeddingResult(np.zeros(192), 1.0)

        def score(self, emb_a, emb_b):
            return 0.5

    assert isinstance(FakeSV(), SVBackend)
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_backend_protocols.py -v`
Expected: FAIL — module not found

**Step 3: Implement protocols**

```python
# inference/app/services/backends/diarization_protocol.py
"""Diarization Backend protocol."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass
class SpeakerSegment:
    speaker_id: str
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass
class DiarizationResult:
    segments: list[SpeakerSegment]
    embeddings: dict[str, np.ndarray]  # speaker_id → embedding vector
    processing_time_ms: int
    confidences: dict[str, float] = field(default_factory=dict)

    @property
    def speaker_count(self) -> int:
        return len(set(s.speaker_id for s in self.segments))


@runtime_checkable
class DiarizationBackend(Protocol):
    @property
    def name(self) -> str: ...

    def diarize(
        self,
        wav_path: str,
        num_speakers: int | None = None,
    ) -> DiarizationResult: ...
```

```python
# inference/app/services/backends/sv_protocol.py
"""Speaker Verification Backend protocol — CAM++ as arbitration layer."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass
class EmbeddingResult:
    embedding: np.ndarray
    confidence: float = 1.0

    @property
    def dim(self) -> int:
        return self.embedding.shape[0]


@runtime_checkable
class SVBackend(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def embedding_dim(self) -> int: ...

    def extract_embedding(self, wav_path: str) -> EmbeddingResult: ...

    def score(self, emb_a: np.ndarray, emb_b: np.ndarray) -> float: ...
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_backend_protocols.py -v`
Expected: 5 passed

**Step 5: Commit**

```bash
git add inference/app/services/backends/diarization_protocol.py
git add inference/app/services/backends/sv_protocol.py
git add inference/tests/test_backend_protocols.py
git commit -m "feat(inference): add Diarization and SV backend protocols"
```

---

### Task 5: LLM Backend protocol with 6 engineering constraints

**Files:**
- Create: `inference/app/services/backends/llm_protocol.py`
- Create: `inference/app/services/backends/llm_dashscope.py`
- Test: `inference/tests/test_llm_protocol.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_llm_protocol.py
"""Tests for LLM backend protocol and DashScope adapter with 6 constraints."""
import json
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

try:
    import fakeredis
    HAS_FAKEREDIS = True
except ImportError:
    HAS_FAKEREDIS = False

from app.services.backends.llm_protocol import (
    LLMBackend,
    LLMConfig,
    LLMMetrics,
    LLMPool,
)


def test_llm_config_defaults():
    config = LLMConfig(api_key="test-key", model="qwen-plus")
    assert config.checkpoint_concurrency == 3
    assert config.finalize_concurrency == 1
    assert config.checkpoint_timeout_ms == 30000
    assert config.finalize_timeout_ms == 60000


def test_llm_pool_enum():
    assert LLMPool.CHECKPOINT.value == "checkpoint"
    assert LLMPool.FINALIZE.value == "finalize"


def test_llm_metrics_dataclass():
    m = LLMMetrics(
        latency_ms=1500,
        input_tokens=200,
        output_tokens=500,
        success=True,
        model="qwen-plus",
        pool="checkpoint",
    )
    assert m.total_tokens == 700


def test_llm_protocol_check():
    class FakeLLM:
        def generate_json(self, system_prompt, user_prompt, **kwargs):
            return {"test": True}

    assert isinstance(FakeLLM(), LLMBackend)


@pytest.mark.skipif(not HAS_FAKEREDIS, reason="fakeredis not installed")
def test_idempotency_via_redis():
    """Constraint 4: idempotency uses Redis, not process memory."""
    from app.services.backends.llm_dashscope import DashScopeLLMAdapter

    r = fakeredis.FakeRedis(decode_responses=True)
    adapter = DashScopeLLMAdapter(
        config=LLMConfig(api_key="test", model="qwen-plus"),
        redis_client=r,
    )
    # Simulate a cached result
    r.hset("llm:idem", "sess-1:checkpoint:0", json.dumps({"cached": True}))
    result = adapter.generate_json(
        "system", "user",
        idempotency_key="sess-1:checkpoint:0",
    )
    assert result == {"cached": True}


def test_json_schema_validation_fails():
    """Constraint 3: JSON Schema validation rejects bad output."""
    from app.services.backends.llm_protocol import validate_llm_output

    schema = {
        "type": "object",
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    # Valid
    validate_llm_output({"summary": "test"}, schema)
    # Invalid — should raise
    with pytest.raises(ValueError, match="schema"):
        validate_llm_output({"wrong_key": 123}, schema)
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_llm_protocol.py -v`
Expected: FAIL — module not found

**Step 3: Implement LLM protocol + DashScope adapter**

```python
# inference/app/services/backends/llm_protocol.py
"""LLM Backend protocol with 6 engineering constraints.

Constraints:
1. Abstract LLMBackend — no direct DashScope SDK in business code
2. Separate pools: checkpoint (concurrency=3) vs finalize (concurrency=1)
3. Forced JSON Schema validation — fail → retry → raise, no silent degradation
4. Idempotency key (session_id:checkpoint_id) via Redis
5. PII scrubbing + audit log before outbound call
6. Metrics: latency, tokens, success, cost → stored for migration decisions
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, runtime_checkable

import jsonschema


class LLMPool(Enum):
    CHECKPOINT = "checkpoint"
    FINALIZE = "finalize"


@dataclass
class LLMConfig:
    api_key: str
    model: str
    checkpoint_concurrency: int = 3
    finalize_concurrency: int = 1
    checkpoint_timeout_ms: int = 30000
    finalize_timeout_ms: int = 60000
    max_retries: int = 1


@dataclass
class LLMMetrics:
    latency_ms: int
    input_tokens: int
    output_tokens: int
    success: bool
    model: str
    pool: str
    cost_estimate_cny: float = 0.0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@runtime_checkable
class LLMBackend(Protocol):
    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        json_schema: dict | None = None,
        timeout_ms: int = 45000,
        idempotency_key: str | None = None,
        pool: str = "default",
    ) -> dict: ...


def validate_llm_output(output: dict, schema: dict) -> None:
    """Constraint 3: forced JSON Schema validation."""
    try:
        jsonschema.validate(output, schema)
    except jsonschema.ValidationError as e:
        raise ValueError(f"LLM output failed schema validation: {e.message}") from e


# ── PII scrubbing (Constraint 5) ──────────────────────────────────

_PII_PATTERNS = [
    (re.compile(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b'), '[PHONE]'),          # US phone
    (re.compile(r'\b\d{11}\b'), '[PHONE]'),                               # CN phone
    (re.compile(r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b'), '[EMAIL]'),            # email
    (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'), '[SSN]'),                    # SSN
    (re.compile(r'\b\d{17}[\dXx]\b'), '[ID_CARD]'),                      # CN ID
]


def scrub_pii(text: str) -> str:
    """Replace PII patterns with placeholders."""
    for pattern, replacement in _PII_PATTERNS:
        text = pattern.sub(replacement, text)
    return text
```

```python
# inference/app/services/backends/llm_dashscope.py
"""DashScope qwen-plus adapter conforming to LLMBackend protocol.

Implements all 6 constraints. Uses Redis for idempotency (not process memory).
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any

from redis import Redis

from app.services.backends.llm_protocol import (
    LLMBackend,
    LLMConfig,
    LLMMetrics,
    LLMPool,
    scrub_pii,
    validate_llm_output,
)

logger = logging.getLogger(__name__)


class DashScopeLLMAdapter:
    """DashScope LLM with 6 engineering constraints."""

    def __init__(
        self,
        config: LLMConfig,
        redis_client: Redis | None = None,
    ) -> None:
        self._config = config
        self._redis = redis_client
        self._metrics_log: list[LLMMetrics] = []
        # Constraint 2: separate semaphores per pool
        self._pools = {
            LLMPool.CHECKPOINT.value: threading.Semaphore(config.checkpoint_concurrency),
            LLMPool.FINALIZE.value: threading.Semaphore(config.finalize_concurrency),
            "default": threading.Semaphore(5),
        }

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        json_schema: dict | None = None,
        timeout_ms: int = 45000,
        idempotency_key: str | None = None,
        pool: str = "default",
    ) -> dict:
        # Constraint 4: idempotency via Redis
        if idempotency_key and self._redis:
            cached = self._redis.hget("llm:idem", idempotency_key)
            if cached:
                logger.debug("LLM idempotency hit: %s", idempotency_key)
                return json.loads(cached)

        # Constraint 5: PII scrubbing + audit
        scrubbed_prompt = scrub_pii(user_prompt)
        prompt_hash = hashlib.sha256(scrubbed_prompt.encode()).hexdigest()[:16]
        logger.info(
            "LLM call: pool=%s, key=%s, prompt_hash=%s",
            pool, idempotency_key, prompt_hash,
        )

        # Constraint 2: pool-based concurrency control
        semaphore = self._pools.get(pool, self._pools["default"])
        acquired = semaphore.acquire(timeout=timeout_ms / 1000)
        if not acquired:
            raise TimeoutError(f"LLM pool '{pool}' busy, timeout after {timeout_ms}ms")

        t0 = time.monotonic()
        success = False
        result: dict = {}
        retries = 0

        try:
            while retries <= self._config.max_retries:
                try:
                    result = self._call_dashscope(
                        system_prompt, scrubbed_prompt, timeout_ms
                    )
                    # Constraint 3: forced JSON Schema validation
                    if json_schema:
                        validate_llm_output(result, json_schema)
                    success = True
                    break
                except ValueError:
                    retries += 1
                    if retries > self._config.max_retries:
                        raise
                    logger.warning("LLM schema validation failed, retry %d", retries)

            # Constraint 4: cache result in Redis
            if idempotency_key and self._redis and success:
                self._redis.hset("llm:idem", idempotency_key, json.dumps(result))
                self._redis.expire("llm:idem", 7200)

            return result

        finally:
            semaphore.release()
            latency_ms = int((time.monotonic() - t0) * 1000)

            # Constraint 6: metrics
            metrics = LLMMetrics(
                latency_ms=latency_ms,
                input_tokens=0,  # populated by _call_dashscope
                output_tokens=0,
                success=success,
                model=self._config.model,
                pool=pool,
            )
            self._metrics_log.append(metrics)
            logger.info(
                "LLM result: pool=%s, success=%s, latency=%dms",
                pool, success, latency_ms,
            )

    def _call_dashscope(
        self, system_prompt: str, user_prompt: str, timeout_ms: int
    ) -> dict:
        """Call DashScope API. Override in tests."""
        # Lazy import to avoid import-time dependency
        from app.services.dashscope_llm import DashScopeLLM

        llm = DashScopeLLM(
            api_key=self._config.api_key,
            model=self._config.model,
        )
        return llm.generate_json(system_prompt, user_prompt)

    def get_metrics(self) -> list[LLMMetrics]:
        return list(self._metrics_log)
```

**Step 4: Run test to verify it passes**

Run: `cd inference && pip install jsonschema && python -m pytest tests/test_llm_protocol.py -v`
Expected: 6 passed

**Step 5: Commit**

```bash
git add inference/app/services/backends/llm_protocol.py
git add inference/app/services/backends/llm_dashscope.py
git add inference/tests/test_llm_protocol.py
git commit -m "feat(inference): add LLM backend protocol with 6 engineering constraints"
```

---

## Phase 3: WebSocket Binary Frame Protocol

### Task 6: Frame protocol encoder/decoder

**Files:**
- Create: `inference/app/services/ws_protocol.py`
- Test: `inference/tests/test_ws_protocol.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_ws_protocol.py
"""Tests for WebSocket binary frame protocol."""
import json
import struct
import zlib
import pytest

from app.services.ws_protocol import (
    StartFrame,
    EndFrame,
    PCMFrame,
    ResultFrame,
    ErrorFrame,
    encode_pcm_frame,
    decode_pcm_frame,
    validate_start_frame,
    SCHEMA_VERSION,
)


def test_schema_version():
    assert SCHEMA_VERSION == 1


def test_start_frame_validation():
    raw = {
        "v": 1,
        "type": "start",
        "session_id": "sess-1",
        "increment_id": "uuid-123",
        "increment_index": 0,
        "audio_start_ms": 0,
        "audio_end_ms": 180000,
        "language": "en",
        "run_analysis": True,
        "total_frames": 10,
        "sample_rate": 16000,
        "channels": 1,
        "bit_depth": 16,
    }
    frame = validate_start_frame(raw)
    assert frame.session_id == "sess-1"
    assert frame.total_frames == 10


def test_start_frame_rejects_wrong_version():
    raw = {"v": 2, "type": "start", "session_id": "s"}
    with pytest.raises(ValueError, match="version"):
        validate_start_frame(raw)


def test_start_frame_rejects_missing_fields():
    raw = {"v": 1, "type": "start"}
    with pytest.raises(ValueError):
        validate_start_frame(raw)


def test_encode_decode_pcm_frame():
    pcm_data = b'\x00\x01' * 1024  # 2KB PCM
    encoded = encode_pcm_frame(frame_seq=0, pcm_data=pcm_data)

    # Header: 12 bytes (seq:4 + size:4 + crc:4)
    assert len(encoded) == 12 + len(pcm_data)

    decoded = decode_pcm_frame(encoded)
    assert decoded.frame_seq == 0
    assert decoded.payload == pcm_data
    assert decoded.payload_size == len(pcm_data)


def test_decode_pcm_frame_crc_check():
    pcm_data = b'\x00\x01' * 100
    encoded = encode_pcm_frame(frame_seq=0, pcm_data=pcm_data)
    # Corrupt one byte in payload
    corrupted = bytearray(encoded)
    corrupted[15] ^= 0xFF
    with pytest.raises(ValueError, match="CRC"):
        decode_pcm_frame(bytes(corrupted))


def test_encode_pcm_frame_max_size():
    """Frame payload must not exceed 64KB."""
    big_data = b'\x00' * (65536 + 1)
    with pytest.raises(ValueError, match="64KB"):
        encode_pcm_frame(frame_seq=0, pcm_data=big_data)


def test_end_frame_schema():
    frame = EndFrame(total_frames_sent=10, total_bytes_sent=20480)
    d = frame.to_dict()
    assert d["type"] == "end"
    assert d["total_frames_sent"] == 10


def test_result_frame_schema():
    frame = ResultFrame(
        session_id="sess-1",
        increment_index=0,
        utterances=[],
        speaker_profiles=[],
        checkpoint=None,
        metrics={"total_ms": 1500},
    )
    d = frame.to_dict()
    assert d["v"] == 1
    assert d["type"] == "result"


def test_error_frame_schema():
    frame = ErrorFrame(code="FRAME_CRC_MISMATCH", message="bad crc")
    d = frame.to_dict()
    assert d["type"] == "error"
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_ws_protocol.py -v`
Expected: FAIL — module not found

**Step 3: Implement frame protocol**

```python
# inference/app/services/ws_protocol.py
"""WebSocket binary frame protocol for incremental audio processing.

Frame Types:
  StartFrame   (JSON text)  — session info + expected frame count
  PCMFrame     (binary)     — header(12B) + raw PCM s16le
  EndFrame     (JSON text)  — completion summary
  ResultFrame  (JSON text)  — processing result from Inference
  ErrorFrame   (JSON text)  — error from Inference

PCMFrame binary layout:
  [frame_seq: uint32] [payload_size: uint32] [crc32: uint32] [pcm_data: bytes]
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = 1
MAX_FRAME_PAYLOAD = 65536  # 64KB


# ── Start Frame ───────────────────────────────────────────────────

_REQUIRED_START_FIELDS = {
    "session_id", "increment_id", "increment_index",
    "audio_start_ms", "audio_end_ms", "language",
    "run_analysis", "total_frames",
}


@dataclass
class StartFrame:
    session_id: str
    increment_id: str
    increment_index: int
    audio_start_ms: int
    audio_end_ms: int
    language: str
    run_analysis: bool
    total_frames: int
    sample_rate: int = 16000
    channels: int = 1
    bit_depth: int = 16


def validate_start_frame(raw: dict) -> StartFrame:
    """Parse and validate a StartFrame from JSON dict."""
    if raw.get("v") != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported schema version: {raw.get('v')} (expected {SCHEMA_VERSION})"
        )
    missing = _REQUIRED_START_FIELDS - set(raw.keys())
    if missing:
        raise ValueError(f"StartFrame missing required fields: {missing}")
    return StartFrame(
        session_id=raw["session_id"],
        increment_id=raw["increment_id"],
        increment_index=raw["increment_index"],
        audio_start_ms=raw["audio_start_ms"],
        audio_end_ms=raw["audio_end_ms"],
        language=raw["language"],
        run_analysis=raw["run_analysis"],
        total_frames=raw["total_frames"],
        sample_rate=raw.get("sample_rate", 16000),
        channels=raw.get("channels", 1),
        bit_depth=raw.get("bit_depth", 16),
    )


# ── PCM Frame (binary) ───────────────────────────────────────────

HEADER_FORMAT = "<III"  # little-endian: seq(u32), size(u32), crc(u32)
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)  # 12 bytes


@dataclass
class PCMFrame:
    frame_seq: int
    payload_size: int
    crc32: int
    payload: bytes


def encode_pcm_frame(frame_seq: int, pcm_data: bytes) -> bytes:
    """Encode a PCM frame with header (seq + size + CRC32)."""
    if len(pcm_data) > MAX_FRAME_PAYLOAD:
        raise ValueError(
            f"PCM frame payload {len(pcm_data)} bytes exceeds 64KB limit"
        )
    crc = zlib.crc32(pcm_data) & 0xFFFFFFFF
    header = struct.pack(HEADER_FORMAT, frame_seq, len(pcm_data), crc)
    return header + pcm_data


def decode_pcm_frame(data: bytes) -> PCMFrame:
    """Decode a PCM frame, verifying CRC32."""
    if len(data) < HEADER_SIZE:
        raise ValueError(f"Frame too short: {len(data)} < {HEADER_SIZE}")
    seq, size, expected_crc = struct.unpack(HEADER_FORMAT, data[:HEADER_SIZE])
    payload = data[HEADER_SIZE:HEADER_SIZE + size]
    if len(payload) != size:
        raise ValueError(f"Payload truncated: got {len(payload)}, expected {size}")
    actual_crc = zlib.crc32(payload) & 0xFFFFFFFF
    if actual_crc != expected_crc:
        raise ValueError(
            f"CRC mismatch: expected {expected_crc:#010x}, got {actual_crc:#010x}"
        )
    return PCMFrame(frame_seq=seq, payload_size=size, crc32=expected_crc, payload=payload)


# ── End Frame ─────────────────────────────────────────────────────

@dataclass
class EndFrame:
    total_frames_sent: int
    total_bytes_sent: int

    def to_dict(self) -> dict:
        return {
            "type": "end",
            "total_frames_sent": self.total_frames_sent,
            "total_bytes_sent": self.total_bytes_sent,
        }


# ── Result Frame ──────────────────────────────────────────────────

@dataclass
class ResultFrame:
    session_id: str
    increment_index: int
    utterances: list[dict]
    speaker_profiles: list[dict]
    checkpoint: dict | None
    metrics: dict

    def to_dict(self) -> dict:
        return {
            "v": SCHEMA_VERSION,
            "type": "result",
            "session_id": self.session_id,
            "increment_index": self.increment_index,
            "utterances": self.utterances,
            "speaker_profiles": self.speaker_profiles,
            "checkpoint": self.checkpoint,
            "metrics": self.metrics,
        }


# ── Error Frame ───────────────────────────────────────────────────

@dataclass
class ErrorFrame:
    code: str
    message: str

    def to_dict(self) -> dict:
        return {
            "type": "error",
            "code": self.code,
            "message": self.message,
        }
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_ws_protocol.py -v`
Expected: 10 passed

**Step 5: Commit**

```bash
git add inference/app/services/ws_protocol.py inference/tests/test_ws_protocol.py
git commit -m "feat(inference): add WebSocket binary frame protocol with CRC32 validation"
```

---

### Task 7: WebSocket endpoint on Inference

**Files:**
- Create: `inference/app/routes/ws_incremental.py`
- Modify: `inference/app/main.py` (add WS route)
- Test: `inference/tests/test_ws_incremental.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_ws_incremental.py
"""Tests for WebSocket incremental endpoint.

Uses FastAPI TestClient + mock processor to test the WS handshake,
frame protocol, and error handling without real models.
"""
import json
import struct
import zlib
import pytest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.services.ws_protocol import encode_pcm_frame, SCHEMA_VERSION


@pytest.fixture
def mock_runtime():
    """Build a mock AppRuntime with mock IncrementalProcessor."""
    runtime = MagicMock()
    runtime.incremental_processor = MagicMock()
    runtime.redis_state = MagicMock()
    # Mock process_increment to return a simple result
    runtime.incremental_processor.process_increment_v2.return_value = {
        "session_id": "sess-1",
        "increment_index": 0,
        "utterances": [{"speaker": "spk_00", "text": "hello", "start_ms": 0, "end_ms": 1500}],
        "speaker_profiles": [],
        "checkpoint": None,
        "metrics": {"diarization_ms": 500, "transcription_ms": 300, "total_ms": 1000},
    }
    # Mock idempotency check
    runtime.redis_state.try_mark_processed.return_value = True
    runtime.redis_state.acquire_session_lock.return_value = True
    runtime.redis_state.release_session_lock.return_value = True
    return runtime


@pytest.fixture
def app(mock_runtime):
    from app.routes.ws_incremental import create_ws_app
    return create_ws_app(mock_runtime)


def test_ws_happy_path(app, mock_runtime):
    """Full protocol: start → PCM frames → end → result."""
    client = TestClient(app)

    start_frame = {
        "v": SCHEMA_VERSION,
        "type": "start",
        "session_id": "sess-1",
        "increment_id": "uuid-001",
        "increment_index": 0,
        "audio_start_ms": 0,
        "audio_end_ms": 3000,
        "language": "en",
        "run_analysis": False,
        "total_frames": 2,
        "sample_rate": 16000,
        "channels": 1,
        "bit_depth": 16,
    }

    pcm_chunk = b'\x00\x01' * 512  # 1KB per frame

    with client.websocket_connect("/ws/v1/increment") as ws:
        # Send start
        ws.send_text(json.dumps(start_frame))
        # Send 2 PCM frames
        ws.send_bytes(encode_pcm_frame(0, pcm_chunk))
        ws.send_bytes(encode_pcm_frame(1, pcm_chunk))
        # Send end
        ws.send_text(json.dumps({
            "type": "end",
            "total_frames_sent": 2,
            "total_bytes_sent": len(pcm_chunk) * 2,
        }))
        # Receive result
        result = json.loads(ws.receive_text())
        assert result["type"] == "result"
        assert result["v"] == SCHEMA_VERSION
        assert result["session_id"] == "sess-1"


def test_ws_rejects_bad_version(app):
    client = TestClient(app)
    with client.websocket_connect("/ws/v1/increment") as ws:
        ws.send_text(json.dumps({"v": 99, "type": "start", "session_id": "s"}))
        result = json.loads(ws.receive_text())
        assert result["type"] == "error"
        assert "version" in result["message"].lower()


def test_ws_rejects_duplicate_increment(app, mock_runtime):
    """Constraint 2: duplicate increment_id is rejected."""
    mock_runtime.redis_state.try_mark_processed.return_value = False  # duplicate

    client = TestClient(app)
    start_frame = {
        "v": 1, "type": "start", "session_id": "sess-1",
        "increment_id": "uuid-dup", "increment_index": 0,
        "audio_start_ms": 0, "audio_end_ms": 3000,
        "language": "en", "run_analysis": False,
        "total_frames": 1,
    }
    with client.websocket_connect("/ws/v1/increment") as ws:
        ws.send_text(json.dumps(start_frame))
        result = json.loads(ws.receive_text())
        assert result["type"] == "error"
        assert "idempotent" in result["message"].lower() or "duplicate" in result["message"].lower()
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_ws_incremental.py -v`
Expected: FAIL — module not found

**Step 3: Implement WebSocket endpoint**

```python
# inference/app/routes/ws_incremental.py
"""WebSocket endpoint for incremental audio processing.

Protocol: StartFrame (JSON) → PCMFrame[] (binary) → EndFrame (JSON) → ResultFrame (JSON)

Enforces:
- Schema version validation
- Idempotent increment_id (Redis HSETNX)
- Per-session serial lock (Redis SET NX)
- Frame sequence + CRC32 validation
"""
from __future__ import annotations

import io
import json
import logging
import tempfile
import time
import wave

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.services.ws_protocol import (
    SCHEMA_VERSION,
    ErrorFrame,
    ResultFrame,
    decode_pcm_frame,
    validate_start_frame,
)

logger = logging.getLogger(__name__)


def create_ws_app(runtime) -> FastAPI:
    """Create a FastAPI app with the WS endpoint. Separate from main HTTP app."""
    app = FastAPI(title="Inference WS")

    @app.websocket("/ws/v1/increment")
    async def ws_increment(ws: WebSocket):
        await ws.accept()
        try:
            await _handle_increment(ws, runtime)
        except WebSocketDisconnect:
            logger.info("WS client disconnected")
        except Exception as e:
            logger.error("WS error: %s", e, exc_info=True)
            try:
                await ws.send_text(
                    json.dumps(ErrorFrame(code="INTERNAL_ERROR", message=str(e)).to_dict())
                )
            except Exception:
                pass

    return app


async def _handle_increment(ws: WebSocket, runtime) -> None:
    redis_state = runtime.redis_state

    # 1. Receive StartFrame
    raw_start = await ws.receive_text()
    try:
        start_data = json.loads(raw_start)
        start = validate_start_frame(start_data)
    except (json.JSONDecodeError, ValueError) as e:
        await ws.send_text(
            json.dumps(ErrorFrame(code="INVALID_START_FRAME", message=str(e)).to_dict())
        )
        return

    sid = start.session_id
    inc_id = start.increment_id

    # 2. Idempotency check (Constraint 2)
    if not redis_state.try_mark_processed(sid, inc_id):
        await ws.send_text(
            json.dumps(ErrorFrame(
                code="DUPLICATE_INCREMENT",
                message=f"Increment {inc_id} already processed (idempotent reject)",
            ).to_dict())
        )
        return

    # 3. Acquire per-session lock (Constraint 3)
    lock_id = f"ws-{inc_id}"
    if not redis_state.acquire_session_lock(sid, lock_id):
        await ws.send_text(
            json.dumps(ErrorFrame(
                code="SESSION_LOCKED",
                message=f"Session {sid} is being processed by another request",
            ).to_dict())
        )
        return

    try:
        # 4. Receive PCM frames
        pcm_buffer = io.BytesIO()
        frames_received = 0
        bytes_received = 0

        while True:
            msg = await ws.receive()

            if "text" in msg and msg["text"]:
                # Could be EndFrame
                text_data = json.loads(msg["text"])
                if text_data.get("type") == "end":
                    break
                else:
                    await ws.send_text(
                        json.dumps(ErrorFrame(
                            code="UNEXPECTED_TEXT_FRAME",
                            message=f"Expected binary PCM or EndFrame, got: {text_data.get('type')}",
                        ).to_dict())
                    )
                    return

            if "bytes" in msg and msg["bytes"]:
                frame = decode_pcm_frame(msg["bytes"])
                if frame.frame_seq != frames_received:
                    await ws.send_text(
                        json.dumps(ErrorFrame(
                            code="FRAME_SEQ_GAP",
                            message=f"Expected frame_seq={frames_received}, got {frame.frame_seq}",
                        ).to_dict())
                    )
                    return
                pcm_buffer.write(frame.payload)
                frames_received += 1
                bytes_received += frame.payload_size

        # 5. Validate frame count
        if frames_received != start.total_frames:
            logger.warning(
                "Frame count mismatch: expected %d, got %d",
                start.total_frames, frames_received,
            )

        # 6. Write PCM to temp WAV
        pcm_data = pcm_buffer.getvalue()
        wav_path = _pcm_to_wav(
            pcm_data, start.sample_rate, start.channels, start.bit_depth
        )

        # 7. Process increment
        try:
            result = runtime.incremental_processor.process_increment_v2(
                session_id=sid,
                increment_id=inc_id,
                increment_index=start.increment_index,
                wav_path=wav_path,
                audio_start_ms=start.audio_start_ms,
                audio_end_ms=start.audio_end_ms,
                language=start.language,
                run_analysis=start.run_analysis,
            )
        finally:
            import os
            try:
                os.unlink(wav_path)
            except OSError:
                pass

        # 8. Send ResultFrame
        result_frame = ResultFrame(
            session_id=sid,
            increment_index=start.increment_index,
            utterances=result.get("utterances", []),
            speaker_profiles=result.get("speaker_profiles", []),
            checkpoint=result.get("checkpoint"),
            metrics={
                **result.get("metrics", {}),
                "frames_received": frames_received,
                "frames_expected": start.total_frames,
            },
        )
        await ws.send_text(json.dumps(result_frame.to_dict()))

    finally:
        redis_state.release_session_lock(sid, lock_id)


def _pcm_to_wav(pcm_data: bytes, sr: int, channels: int, bit_depth: int) -> str:
    """Write raw PCM to a temporary WAV file. Returns path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bit_depth // 8)
        wf.setframerate(sr)
        wf.writeframes(pcm_data)
    return tmp.name
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_ws_incremental.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
git add inference/app/routes/ws_incremental.py inference/tests/test_ws_incremental.py
git commit -m "feat(inference): add WebSocket endpoint for incremental audio with frame validation"
```

---

## Phase 4: CAM++ Speaker Arbiter

### Task 8: Speaker Arbiter (CAM++ low-confidence only)

**Files:**
- Create: `inference/app/services/speaker_arbiter.py`
- Test: `inference/tests/test_speaker_arbiter.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_speaker_arbiter.py
"""Tests for CAM++ speaker arbitration layer.

CAM++ is only invoked for low-confidence mappings to protect 60s SLA.
"""
import numpy as np
import pytest
from unittest.mock import MagicMock

from app.services.speaker_arbiter import SpeakerArbiter


@pytest.fixture
def mock_sv():
    sv = MagicMock()
    sv.name = "cam++-onnx"
    sv.embedding_dim = 192
    # Return a known embedding
    sv.extract_embedding.return_value = MagicMock(
        embedding=np.array([1.0] * 192, dtype=np.float32),
        confidence=0.9,
    )
    return sv


@pytest.fixture
def arbiter(mock_sv):
    return SpeakerArbiter(sv_backend=mock_sv, confidence_threshold=0.50)


def test_high_confidence_skips_cam_plus(arbiter, mock_sv):
    """High-confidence pyannote mappings should NOT trigger CAM++."""
    mapping = {"local_0": "spk_00", "local_1": "spk_01"}
    confidences = {"local_0": 0.85, "local_1": 0.70}

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={},
        global_profiles={},
    )
    assert result == mapping
    mock_sv.extract_embedding.assert_not_called()


def test_low_confidence_triggers_cam_plus(arbiter, mock_sv):
    """Low-confidence mapping should trigger CAM++ arbitration."""
    mapping = {"local_0": "spk_00"}
    confidences = {"local_0": 0.35}  # below threshold

    profiles = {
        "spk_00": MagicMock(centroid=np.array([0.5] * 192, dtype=np.float32)),
        "spk_01": MagicMock(centroid=np.array([1.0] * 192, dtype=np.float32)),
    }

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={"local_0": "/tmp/seg.wav"},
        global_profiles=profiles,
    )
    # Should have been corrected to spk_01 (closer to [1.0]*192)
    mock_sv.extract_embedding.assert_called_once()
    assert result["local_0"] == "spk_01"


def test_mixed_confidence(arbiter, mock_sv):
    """Mix of high and low confidence."""
    mapping = {"local_0": "spk_00", "local_1": "spk_01"}
    confidences = {"local_0": 0.80, "local_1": 0.30}

    profiles = {
        "spk_00": MagicMock(centroid=np.array([0.5] * 192)),
        "spk_01": MagicMock(centroid=np.array([1.0] * 192)),
    }

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={"local_1": "/tmp/seg.wav"},
        global_profiles=profiles,
    )
    assert result["local_0"] == "spk_00"  # kept (high confidence)
    assert mock_sv.extract_embedding.call_count == 1  # only local_1


def test_no_profiles_keeps_original(arbiter, mock_sv):
    """If no global profiles exist, keep original mapping."""
    result = arbiter.arbitrate(
        pyannote_mapping={"local_0": "spk_00"},
        pyannote_confidences={"local_0": 0.30},
        audio_segments={"local_0": "/tmp/seg.wav"},
        global_profiles={},
    )
    assert result["local_0"] == "spk_00"
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_speaker_arbiter.py -v`
Expected: FAIL — module not found

**Step 3: Implement SpeakerArbiter**

```python
# inference/app/services/speaker_arbiter.py
"""CAM++ speaker arbitration layer.

Only invoked for low-confidence pyannote speaker mappings.
Protects 60s SLA by skipping high-confidence matches entirely.
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


class SpeakerArbiter:
    """Arbitrate speaker identity using CAM++ only when pyannote is uncertain."""

    def __init__(self, sv_backend: Any, confidence_threshold: float = 0.50) -> None:
        self.sv = sv_backend
        self.confidence_threshold = confidence_threshold

    def arbitrate(
        self,
        pyannote_mapping: dict[str, str],
        pyannote_confidences: dict[str, float],
        audio_segments: dict[str, str],  # local_id → wav_path
        global_profiles: dict[str, Any],  # global_id → profile with .centroid
    ) -> dict[str, str]:
        """Return corrected mapping. High-confidence entries pass through unchanged."""
        if not global_profiles:
            return dict(pyannote_mapping)

        corrections: dict[str, str] = {}

        for local_id, confidence in pyannote_confidences.items():
            if confidence >= self.confidence_threshold:
                continue  # trust pyannote

            wav_path = audio_segments.get(local_id)
            if not wav_path:
                continue

            try:
                emb_result = self.sv.extract_embedding(wav_path)
                emb = emb_result.embedding
                best_global, best_sim = self._cosine_match(emb, global_profiles)
                if best_global and best_sim > 0.55:
                    corrections[local_id] = best_global
                    logger.debug(
                        "Arbiter correction: %s → %s (sim=%.3f, was %s conf=%.2f)",
                        local_id, best_global, best_sim,
                        pyannote_mapping.get(local_id), confidence,
                    )
            except Exception:
                logger.warning(
                    "Arbiter failed for %s, keeping pyannote mapping",
                    local_id, exc_info=True,
                )

        return {**pyannote_mapping, **corrections}

    def _cosine_match(
        self, emb: np.ndarray, profiles: dict[str, Any]
    ) -> tuple[str | None, float]:
        """Find best matching global profile by cosine similarity."""
        best_id = None
        best_sim = -1.0
        emb_norm = emb / (np.linalg.norm(emb) + 1e-8)

        for gid, profile in profiles.items():
            centroid = getattr(profile, "centroid", None)
            if centroid is None:
                continue
            centroid = np.asarray(centroid, dtype=np.float32)
            if centroid.size == 0:
                continue
            c_norm = centroid / (np.linalg.norm(centroid) + 1e-8)
            sim = float(np.dot(emb_norm, c_norm))
            if sim > best_sim:
                best_sim = sim
                best_id = gid

        return best_id, best_sim
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_speaker_arbiter.py -v`
Expected: 4 passed

**Step 5: Commit**

```bash
git add inference/app/services/speaker_arbiter.py inference/tests/test_speaker_arbiter.py
git commit -m "feat(inference): add CAM++ speaker arbiter (low-confidence only)"
```

---

## Phase 5: V1 Finalize Schema + Contract Tests

### Task 9: V1 Finalize HTTP endpoint with R2 refs

**Files:**
- Create: `inference/app/routes/incremental_v1.py`
- Create: `inference/app/schemas_v1.py`
- Test: `inference/tests/test_incremental_v1_schema.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_incremental_v1_schema.py
"""Tests for V1 incremental schemas with versioning."""
import pytest
from pydantic import ValidationError

from app.schemas_v1 import (
    FinalizeRequestV1,
    FinalizeResponseV1,
    R2AudioRef,
    SCHEMA_VERSION,
)


def test_schema_version():
    assert SCHEMA_VERSION == 1


def test_r2_audio_ref():
    ref = R2AudioRef(key="chunks/sess-1/000.pcm", start_ms=0, end_ms=10000)
    assert ref.duration_ms == 10000


def test_finalize_request_valid():
    req = FinalizeRequestV1(
        v=1,
        session_id="sess-1",
        r2_audio_refs=[
            R2AudioRef(key="chunks/sess-1/000.pcm", start_ms=0, end_ms=10000),
        ],
        total_audio_ms=10000,
        locale="en-US",
    )
    assert req.session_id == "sess-1"


def test_finalize_request_rejects_wrong_version():
    with pytest.raises(ValidationError):
        FinalizeRequestV1(
            v=2,
            session_id="sess-1",
            r2_audio_refs=[],
            total_audio_ms=0,
            locale="en-US",
        )


def test_finalize_request_requires_session_id():
    with pytest.raises(ValidationError):
        FinalizeRequestV1(
            v=1,
            session_id="",
            r2_audio_refs=[],
            total_audio_ms=0,
            locale="en-US",
        )


def test_finalize_response_has_metrics():
    resp = FinalizeResponseV1(
        v=1,
        session_id="sess-1",
        transcript=[],
        speaker_stats=[],
        report=None,
        total_increments=3,
        total_audio_ms=180000,
        finalize_time_ms=25000,
        metrics={
            "segments_recomputed": 5,
            "segments_total": 50,
            "recompute_ratio": 0.10,
            "llm_latency_ms": 12000,
        },
    )
    assert resp.metrics["recompute_ratio"] == 0.10
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_incremental_v1_schema.py -v`
Expected: FAIL — module not found

**Step 3: Implement V1 schemas**

```python
# inference/app/schemas_v1.py
"""V1 Incremental Pipeline schemas with explicit versioning.

All schemas include "v": 1 for contract stability.
Breaking changes require v2 with dual-version support for 1 release cycle.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


class R2AudioRef(BaseModel):
    """Reference to an audio chunk stored in R2/S3."""
    key: str
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class FinalizeRequestV1(BaseModel):
    """V1 finalize request — uses R2 refs instead of re-transmitting PCM."""
    v: Literal[1]
    session_id: str = Field(min_length=1, max_length=128)
    r2_audio_refs: list[R2AudioRef] = Field(default_factory=list)
    total_audio_ms: int = Field(ge=0)
    locale: str = "en-US"
    memos: list[dict] = Field(default_factory=list)
    stats: list[dict] = Field(default_factory=list)
    evidence: list[dict] = Field(default_factory=list)
    session_context: dict | None = None
    name_aliases: dict[str, list[str]] = Field(default_factory=dict)


class FinalizeResponseV1(BaseModel):
    """V1 finalize response with metrics for SLA tracking."""
    v: Literal[1] = 1
    session_id: str
    transcript: list[dict]
    speaker_stats: list[dict]
    report: dict | None = None
    total_increments: int
    total_audio_ms: int
    finalize_time_ms: int
    metrics: dict = Field(default_factory=dict)
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_incremental_v1_schema.py -v`
Expected: 6 passed

**Step 5: Commit**

```bash
git add inference/app/schemas_v1.py inference/tests/test_incremental_v1_schema.py
git commit -m "feat(inference): add V1 finalize schemas with R2 refs and SLA metrics"
```

---

### Task 10: Cross-service contract tests

**Files:**
- Create: `inference/tests/test_contract_worker_inference.py`
- Create: `edge/worker/tests/contract-inference.test.ts`

**Step 1: Write the failing tests (Python side)**

```python
# inference/tests/test_contract_worker_inference.py
"""Cross-service contract tests: Worker ↔ Inference schema compatibility.

These tests validate that the field names, types, and structures used by
the Worker (TypeScript) match what Inference (Python) expects.

Run in CI to prevent field drift (the P0 bug that caused this redesign).
"""
import json
import pytest

from app.schemas_v1 import FinalizeRequestV1, R2AudioRef, SCHEMA_VERSION
from app.services.ws_protocol import StartFrame, validate_start_frame


class TestIncrementContract:
    """Validate Worker → Inference increment request contract."""

    def test_start_frame_accepts_worker_format(self):
        """Simulate the exact JSON that Worker sends as StartFrame."""
        worker_payload = {
            "v": 1,
            "type": "start",
            "session_id": "sess-abc-123",
            "increment_id": "inc-uuid-456",
            "increment_index": 0,
            "audio_start_ms": 0,
            "audio_end_ms": 180000,
            "language": "en",
            "run_analysis": True,
            "total_frames": 100,
            "sample_rate": 16000,
            "channels": 1,
            "bit_depth": 16,
        }
        frame = validate_start_frame(worker_payload)
        assert frame.session_id == "sess-abc-123"
        assert frame.audio_end_ms == 180000

    def test_start_frame_field_names_match_design_doc(self):
        """Ensure field names match design doc exactly (prevents drift)."""
        required_fields = {
            "v", "type", "session_id", "increment_id", "increment_index",
            "audio_start_ms", "audio_end_ms", "language", "run_analysis",
            "total_frames",
        }
        # These are the fields validate_start_frame requires
        from app.services.ws_protocol import _REQUIRED_START_FIELDS
        assert _REQUIRED_START_FIELDS == required_fields - {"v", "type"}


class TestFinalizeContract:
    """Validate Worker → Inference finalize request contract."""

    def test_finalize_accepts_worker_format(self):
        worker_payload = {
            "v": 1,
            "session_id": "sess-abc-123",
            "r2_audio_refs": [
                {"key": "chunks/sess-abc-123/000.pcm", "start_ms": 0, "end_ms": 10000},
                {"key": "chunks/sess-abc-123/001.pcm", "start_ms": 10000, "end_ms": 20000},
            ],
            "total_audio_ms": 20000,
            "locale": "en-US",
            "memos": [],
            "stats": [],
            "evidence": [],
            "name_aliases": {},
        }
        req = FinalizeRequestV1(**worker_payload)
        assert len(req.r2_audio_refs) == 2
        assert req.r2_audio_refs[0].duration_ms == 10000

    def test_schema_version_constant(self):
        assert SCHEMA_VERSION == 1
```

**Step 2: Run test to verify it fails (or passes if schemas are already correct)**

Run: `cd inference && python -m pytest tests/test_contract_worker_inference.py -v`
Expected: Should pass if previous tasks completed correctly. If not, fix issues.

**Step 3: Write TypeScript-side contract test**

```typescript
// edge/worker/tests/contract-inference.test.ts
import { describe, it, expect } from 'vitest';

/**
 * Cross-service contract tests: ensure Worker-side field names
 * match Inference V1 schema exactly.
 *
 * These MUST be in CI to prevent field drift.
 */

// V1 schema version
const SCHEMA_VERSION = 1;

describe('Worker → Inference Contract: Increment StartFrame', () => {
  it('should produce a valid StartFrame JSON', () => {
    const startFrame = {
      v: SCHEMA_VERSION,
      type: 'start' as const,
      session_id: 'sess-abc-123',
      increment_id: 'inc-uuid-456',
      increment_index: 0,
      audio_start_ms: 0,
      audio_end_ms: 180000,
      language: 'en',
      run_analysis: true,
      total_frames: 100,
      sample_rate: 16000,
      channels: 1,
      bit_depth: 16,
    };

    // Required fields (must match Inference _REQUIRED_START_FIELDS)
    const requiredFields = [
      'session_id', 'increment_id', 'increment_index',
      'audio_start_ms', 'audio_end_ms', 'language',
      'run_analysis', 'total_frames',
    ];

    for (const field of requiredFields) {
      expect(startFrame).toHaveProperty(field);
    }

    // Type checks
    expect(typeof startFrame.session_id).toBe('string');
    expect(typeof startFrame.increment_index).toBe('number');
    expect(typeof startFrame.audio_start_ms).toBe('number');
    expect(typeof startFrame.run_analysis).toBe('boolean');
  });

  it('should use audio_start_ms NOT start_ms (P0 fix)', () => {
    // This was the original P0 bug: Worker sent start_ms, Inference expected audio_start_ms
    const frame = {
      audio_start_ms: 0,
      audio_end_ms: 180000,
    };
    expect(frame).not.toHaveProperty('start_ms');
    expect(frame).not.toHaveProperty('end_ms');
    expect(frame).toHaveProperty('audio_start_ms');
    expect(frame).toHaveProperty('audio_end_ms');
  });
});

describe('Worker → Inference Contract: Finalize', () => {
  it('should use r2_audio_refs NOT audio_b64 (B+ design)', () => {
    const finalizePayload = {
      v: SCHEMA_VERSION,
      session_id: 'sess-abc-123',
      r2_audio_refs: [
        { key: 'chunks/sess-abc-123/000.pcm', start_ms: 0, end_ms: 10000 },
      ],
      total_audio_ms: 10000,
      locale: 'en-US',
      memos: [],
      stats: [],
      evidence: [],
      name_aliases: {},
    };

    // Must NOT have audio_b64 (old format)
    expect(finalizePayload).not.toHaveProperty('audio_b64');
    // Must have r2_audio_refs
    expect(finalizePayload.r2_audio_refs).toHaveLength(1);
    expect(finalizePayload.r2_audio_refs[0]).toHaveProperty('key');
    expect(finalizePayload.r2_audio_refs[0]).toHaveProperty('start_ms');
    expect(finalizePayload.r2_audio_refs[0]).toHaveProperty('end_ms');
  });
});
```

**Step 4: Run both sides**

Run: `cd inference && python -m pytest tests/test_contract_worker_inference.py -v`
Run: `cd edge/worker && npx vitest run tests/contract-inference.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add inference/tests/test_contract_worker_inference.py
git add edge/worker/tests/contract-inference.test.ts
git commit -m "test: add cross-service contract tests for Worker ↔ Inference V1 schema"
```

---

## Phase 6: A/B Benchmark Framework

### Task 11: ASR Benchmark runner

**Files:**
- Create: `inference/tests/benchmark_asr_ab.py`
- Test: `inference/tests/test_benchmark_framework.py`

**Step 1: Write the failing tests**

```python
# inference/tests/test_benchmark_framework.py
"""Tests for the A/B ASR benchmark framework."""
import pytest
from unittest.mock import MagicMock
from app.services.backends.asr_protocol import TranscriptSegment


def test_compute_wer():
    from tests.benchmark_asr_ab import compute_wer
    assert compute_wer("hello world", "hello world") == 0.0
    assert compute_wer("hello world", "hello") == 0.5  # 1 deletion / 2 words
    assert compute_wer("", "") == 0.0


def test_benchmark_sample():
    from tests.benchmark_asr_ab import BenchmarkSample
    s = BenchmarkSample(
        wav_path="/tmp/test.wav",
        reference="hello world",
        language="en",
        duration_s=2.0,
    )
    assert s.word_count == 2


def test_backend_metrics():
    from tests.benchmark_asr_ab import BackendMetrics
    m = BackendMetrics(
        backend_name="test",
        wer_mean=0.05,
        wer_p95=0.10,
        rtf_mean=0.15,
        latency_p95_s=1.2,
        samples_evaluated=100,
    )
    assert m.passes_threshold(max_wer=0.10, max_rtf=0.20)
    assert not m.passes_threshold(max_wer=0.03, max_rtf=0.20)
```

**Step 2: Run test to verify it fails**

Run: `cd inference && python -m pytest tests/test_benchmark_framework.py -v`
Expected: FAIL — module not found

**Step 3: Implement benchmark framework**

```python
# inference/tests/benchmark_asr_ab.py
"""A/B ASR Benchmark Framework.

Evaluates ASR backends on the same dataset, computing WER/CER/RTF/latency.
Used to decide which model to deploy for English interview scenarios.

Usage:
    cd inference
    python tests/benchmark_asr_ab.py --dataset /path/to/samples.json --backends sensevoice,moonshine
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np


# ── Metrics ───────────────────────────────────────────────────────


def compute_wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate via edit distance."""
    ref_words = reference.strip().split()
    hyp_words = hypothesis.strip().split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0

    d = [[0] * (len(hyp_words) + 1) for _ in range(len(ref_words) + 1)]
    for i in range(len(ref_words) + 1):
        d[i][0] = i
    for j in range(len(hyp_words) + 1):
        d[0][j] = j
    for i in range(1, len(ref_words) + 1):
        for j in range(1, len(hyp_words) + 1):
            cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1,      # deletion
                d[i][j - 1] + 1,      # insertion
                d[i - 1][j - 1] + cost  # substitution
            )
    return d[len(ref_words)][len(hyp_words)] / len(ref_words)


@dataclass
class BenchmarkSample:
    wav_path: str
    reference: str
    language: str
    duration_s: float
    speaker_id: str = ""

    @property
    def word_count(self) -> int:
        return len(self.reference.strip().split())


@dataclass
class BackendMetrics:
    backend_name: str
    wer_mean: float
    wer_p95: float
    rtf_mean: float
    latency_p95_s: float
    samples_evaluated: int

    def passes_threshold(self, max_wer: float, max_rtf: float) -> bool:
        return self.wer_mean <= max_wer and self.rtf_mean <= max_rtf

    def to_dict(self) -> dict:
        return {
            "backend": self.backend_name,
            "wer_mean": round(self.wer_mean, 4),
            "wer_p95": round(self.wer_p95, 4),
            "rtf_mean": round(self.rtf_mean, 4),
            "latency_p95_s": round(self.latency_p95_s, 3),
            "samples": self.samples_evaluated,
        }


class ASRBenchmark:
    """Run A/B comparison across ASR backends."""

    def __init__(self, backends: list, samples: list[BenchmarkSample]):
        self.backends = backends
        self.samples = samples

    def run(self) -> list[BackendMetrics]:
        results = []
        for backend in self.backends:
            metrics = self._evaluate(backend)
            results.append(metrics)
        return sorted(results, key=lambda m: m.wer_mean)

    def _evaluate(self, backend) -> BackendMetrics:
        wer_scores = []
        rtf_scores = []
        latencies = []

        for sample in self.samples:
            t0 = time.monotonic()
            segments = backend.transcribe(sample.wav_path, language=sample.language)
            latency = time.monotonic() - t0

            hypothesis = " ".join(seg.text for seg in segments)
            wer = compute_wer(sample.reference, hypothesis)
            rtf = latency / max(sample.duration_s, 0.001)

            wer_scores.append(wer)
            rtf_scores.append(rtf)
            latencies.append(latency)

        return BackendMetrics(
            backend_name=backend.name,
            wer_mean=float(np.mean(wer_scores)) if wer_scores else 0.0,
            wer_p95=float(np.percentile(wer_scores, 95)) if wer_scores else 0.0,
            rtf_mean=float(np.mean(rtf_scores)) if rtf_scores else 0.0,
            latency_p95_s=float(np.percentile(latencies, 95)) if latencies else 0.0,
            samples_evaluated=len(self.samples),
        )
```

**Step 4: Run test to verify it passes**

Run: `cd inference && python -m pytest tests/test_benchmark_framework.py -v`
Expected: 3 passed

**Step 5: Commit**

```bash
git add inference/tests/benchmark_asr_ab.py inference/tests/test_benchmark_framework.py
git commit -m "feat(inference): add A/B ASR benchmark framework with WER/RTF metrics"
```

---

## Phase 7: Worker-Side Updates

### Task 12: Worker WebSocket client + queue backpressure

> **Note:** This task modifies the CF Worker TypeScript codebase.

**Files:**
- Create: `edge/worker/src/incremental_v1.ts`
- Modify: `edge/worker/src/types_v2.ts` (add V1 types)
- Test: `edge/worker/tests/incremental-v1.test.ts`

**Step 1: Write the failing tests**

```typescript
// edge/worker/tests/incremental-v1.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildStartFrameV1,
  buildFinalizePayloadV1,
  MAX_QUEUE_CHUNKS,
  shouldDropChunk,
} from '../src/incremental_v1';

describe('V1 StartFrame builder', () => {
  it('should produce a valid V1 StartFrame', () => {
    const frame = buildStartFrameV1({
      sessionId: 'sess-1',
      incrementId: 'uuid-001',
      incrementIndex: 0,
      audioStartMs: 0,
      audioEndMs: 180000,
      language: 'en',
      runAnalysis: true,
      totalFrames: 100,
    });

    expect(frame.v).toBe(1);
    expect(frame.type).toBe('start');
    expect(frame.audio_start_ms).toBe(0);
    expect(frame).not.toHaveProperty('start_ms'); // P0 fix
  });
});

describe('V1 Finalize payload builder', () => {
  it('should use r2_audio_refs NOT audio_b64', () => {
    const payload = buildFinalizePayloadV1({
      sessionId: 'sess-1',
      r2AudioRefs: [
        { key: 'chunks/sess-1/000.pcm', startMs: 0, endMs: 10000 },
      ],
      totalAudioMs: 10000,
      locale: 'en-US',
    });

    expect(payload.v).toBe(1);
    expect(payload).not.toHaveProperty('audio_b64');
    expect(payload.r2_audio_refs).toHaveLength(1);
  });
});

describe('Queue backpressure', () => {
  it('should enforce MAX_QUEUE_CHUNKS', () => {
    expect(MAX_QUEUE_CHUNKS).toBeGreaterThan(0);
    expect(MAX_QUEUE_CHUNKS).toBeLessThanOrEqual(1000);
  });

  it('should drop oldest when queue full', () => {
    const result = shouldDropChunk(MAX_QUEUE_CHUNKS + 1, MAX_QUEUE_CHUNKS);
    expect(result.drop).toBe(true);
    expect(result.reason).toContain('backpressure');
  });

  it('should allow when under limit', () => {
    const result = shouldDropChunk(10, MAX_QUEUE_CHUNKS);
    expect(result.drop).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd edge/worker && npx vitest run tests/incremental-v1.test.ts`
Expected: FAIL — module not found

**Step 3: Implement Worker V1 helpers**

```typescript
// edge/worker/src/incremental_v1.ts
/**
 * V1 Incremental Pipeline helpers for Worker → Inference communication.
 *
 * Changes from V0:
 * - Uses audio_start_ms/audio_end_ms (not start_ms/end_ms) — P0 fix
 * - Finalize uses r2_audio_refs (not audio_b64) — B+ design
 * - Queue backpressure with MAX_QUEUE_CHUNKS
 * - Schema version: v=1
 */

export const SCHEMA_VERSION = 1;
export const MAX_QUEUE_CHUNKS = 500;

// ── Types ────────────────────────────────────────────────────────

export interface StartFrameV1 {
  v: 1;
  type: 'start';
  session_id: string;
  increment_id: string;
  increment_index: number;
  audio_start_ms: number;
  audio_end_ms: number;
  language: string;
  run_analysis: boolean;
  total_frames: number;
  sample_rate: number;
  channels: number;
  bit_depth: number;
}

export interface R2AudioRefV1 {
  key: string;
  start_ms: number;
  end_ms: number;
}

export interface FinalizePayloadV1 {
  v: 1;
  session_id: string;
  r2_audio_refs: R2AudioRefV1[];
  total_audio_ms: number;
  locale: string;
  memos: unknown[];
  stats: unknown[];
  evidence: unknown[];
  name_aliases: Record<string, string[]>;
}

export interface DropDecision {
  drop: boolean;
  reason: string;
}

// ── Builders ─────────────────────────────────────────────────────

export function buildStartFrameV1(opts: {
  sessionId: string;
  incrementId: string;
  incrementIndex: number;
  audioStartMs: number;
  audioEndMs: number;
  language: string;
  runAnalysis: boolean;
  totalFrames: number;
}): StartFrameV1 {
  return {
    v: SCHEMA_VERSION as 1,
    type: 'start',
    session_id: opts.sessionId,
    increment_id: opts.incrementId,
    increment_index: opts.incrementIndex,
    audio_start_ms: opts.audioStartMs,
    audio_end_ms: opts.audioEndMs,
    language: opts.language,
    run_analysis: opts.runAnalysis,
    total_frames: opts.totalFrames,
    sample_rate: 16000,
    channels: 1,
    bit_depth: 16,
  };
}

export function buildFinalizePayloadV1(opts: {
  sessionId: string;
  r2AudioRefs: Array<{ key: string; startMs: number; endMs: number }>;
  totalAudioMs: number;
  locale: string;
  memos?: unknown[];
  stats?: unknown[];
  evidence?: unknown[];
  nameAliases?: Record<string, string[]>;
}): FinalizePayloadV1 {
  return {
    v: SCHEMA_VERSION as 1,
    session_id: opts.sessionId,
    r2_audio_refs: opts.r2AudioRefs.map((r) => ({
      key: r.key,
      start_ms: r.startMs,
      end_ms: r.endMs,
    })),
    total_audio_ms: opts.totalAudioMs,
    locale: opts.locale,
    memos: opts.memos ?? [],
    stats: opts.stats ?? [],
    evidence: opts.evidence ?? [],
    name_aliases: opts.nameAliases ?? {},
  };
}

// ── Queue Backpressure ───────────────────────────────────────────

export function shouldDropChunk(
  currentQueueSize: number,
  maxSize: number = MAX_QUEUE_CHUNKS,
): DropDecision {
  if (currentQueueSize > maxSize) {
    return {
      drop: true,
      reason: `Queue backpressure: ${currentQueueSize} > ${maxSize} max chunks`,
    };
  }
  return { drop: false, reason: '' };
}
```

**Step 4: Run test to verify it passes**

Run: `cd edge/worker && npx vitest run tests/incremental-v1.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add edge/worker/src/incremental_v1.ts edge/worker/tests/incremental-v1.test.ts
git commit -m "feat(worker): add V1 incremental helpers with P0 fixes and queue backpressure"
```

---

## Phase 8: CI Pipeline Update

### Task 13: Add contract tests and Worker tests to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Read current CI config**

Check: `.github/workflows/ci.yml` — look for the `edge-worker` job section.

**Step 2: Add Worker vitest to CI (not just typecheck)**

Add to the edge-worker job steps (after typecheck):
```yaml
      - name: Run Worker tests
        working-directory: edge/worker
        run: npx vitest run

      - name: Run contract tests
        working-directory: edge/worker
        run: npx vitest run tests/contract-inference.test.ts
```

Add to the inference job steps (after existing pytest):
```yaml
      - name: Run contract tests
        working-directory: inference
        run: python -m pytest tests/test_contract_worker_inference.py -v
```

**Step 3: Run CI locally to verify**

Run: `cd edge/worker && npx vitest run`
Run: `cd inference && python -m pytest tests/test_contract_worker_inference.py -v`
Expected: Both pass

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Worker vitest + cross-service contract tests to CI pipeline"
```

---

## Summary: Task Dependency Graph

```
Phase 1: Foundation
  Task 1 (Redis config) → Task 2 (Redis state manager)

Phase 2: Pluggable Backends
  Task 3 (ASR protocol) ─┐
  Task 4 (Diar+SV proto) ─┼─ (independent, can be parallel)
  Task 5 (LLM protocol)  ─┘

Phase 3: WebSocket Protocol
  Task 6 (Frame protocol) → Task 7 (WS endpoint)
  Depends on: Task 2 (Redis state)

Phase 4: CAM++ Arbiter
  Task 8 (Speaker arbiter)
  Depends on: Task 4 (SV protocol)

Phase 5: V1 Schemas + Contracts
  Task 9 (V1 finalize schema) → Task 10 (contract tests)
  Depends on: Task 6 (frame protocol)

Phase 6: Benchmark
  Task 11 (A/B benchmark)
  Depends on: Task 3 (ASR protocol)

Phase 7: Worker
  Task 12 (Worker WS client + backpressure)
  Depends on: Task 9, Task 10

Phase 8: CI
  Task 13 (CI update)
  Depends on: Task 10, Task 12
```

**Parallelizable groups:**
- Group A: Tasks 3, 4, 5 (protocols — independent)
- Group B: Tasks 1, 2 (Redis — sequential but independent of Group A)
- Group C: Tasks 6, 7 (WS — needs Task 2)
- Group D: Tasks 8, 11 (Arbiter + Benchmark — independent after protocols)

**Critical path:** Task 1 → 2 → 6 → 7 → 9 → 10 → 12 → 13

**Total: 13 tasks, estimated 40-60 TDD steps**
