from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np

from app.config import Settings
from app.schemas import (
    AudioPayload,
    BindingMeta,
    ClusterState,
    ParticipantProfile,
    ResolveRequest,
    RosterEntry,
    SessionState,
)
from app.services.binder import BinderPolicy
from app.services.name_resolver import NameResolver
from app.services.orchestrator import InferenceOrchestrator
from app.services.segmenters.base import Segment


class DummySegmenter:
    def __init__(self, duration_ms: int = 4000) -> None:
        self.duration_ms = duration_ms

    def segment(self, audio):  # noqa: ANN001
        return [
            Segment(
                start_ms=0,
                end_ms=self.duration_ms,
                samples=np.asarray(audio.samples, dtype=np.float32),
            )
        ]


class DummySVBackend:
    def __init__(self, embedding: np.ndarray) -> None:
        self.embedding = embedding.astype(np.float32)

    def extract_embedding(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:  # noqa: ARG002
        return self.embedding

    @staticmethod
    def score_embeddings(a: np.ndarray, b: np.ndarray) -> float:
        a_norm = np.linalg.norm(a)
        b_norm = np.linalg.norm(b)
        if a_norm == 0 or b_norm == 0:
            return -1.0
        return float(np.dot(a, b) / (a_norm * b_norm))


class DummyClusterer:
    def __init__(self, cluster_id: str = "c1", score: float = 0.8) -> None:
        self.cluster_id = cluster_id
        self.score = score

    def assign(self, embedding: np.ndarray, clusters: list[ClusterState]) -> tuple[str, float]:  # noqa: ARG002
        if not clusters:
            clusters.append(
                ClusterState(
                    cluster_id=self.cluster_id,
                    centroid=embedding.astype(np.float32).tolist(),
                    sample_count=1,
                )
            )
        return self.cluster_id, self.score


def _orchestrator_with_embedding(embedding: np.ndarray) -> InferenceOrchestrator:
    settings = Settings()
    return InferenceOrchestrator(
        settings=settings,
        segmenter=DummySegmenter(),
        sv_backend=DummySVBackend(embedding=embedding),
        clusterer=DummyClusterer(),
        name_resolver=NameResolver(),
        binder=BinderPolicy(
            threshold_low=settings.sv_t_low,
            threshold_high=settings.sv_t_high,
            profile_auto_threshold=settings.profile_auto_threshold,
            profile_confirm_threshold=settings.profile_confirm_threshold,
            profile_margin_threshold=settings.profile_margin_threshold,
        ),
    )


def _audio_payload() -> AudioPayload:
    return AudioPayload(content_b64="AQID", format="wav")


def _monkeypatch_normalize(orchestrator: InferenceOrchestrator, duration_seconds: int = 4) -> None:
    sample_count = max(1, duration_seconds * 16000)
    samples = np.ones(sample_count, dtype=np.float32) * 0.05

    class _Audio:
        sample_rate = 16000
        pcm_s16le = b""

        def __init__(self, value: np.ndarray) -> None:
            self.samples = value

    orchestrator._normalize_audio = lambda payload: _Audio(samples)  # type: ignore[method-assign]


def test_resolve_prefers_locked_manual_binding() -> None:
    orchestrator = _orchestrator_with_embedding(np.asarray([1.0, 0.0], dtype=np.float32))
    _monkeypatch_normalize(orchestrator)
    now = datetime.now(timezone.utc).isoformat()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c1", centroid=[1.0, 0.0], sample_count=1, bound_name="Alice")],
        bindings={"c1": "Alice"},
        cluster_binding_meta={
            "c1": BindingMeta(
                participant_name="Alice",
                source="manual_map",
                confidence=1.0,
                locked=True,
                updated_at=now,
            )
        },
    )
    req = ResolveRequest(session_id="s1", audio=_audio_payload(), asr_text="my name is bob", state=state)
    resp = orchestrator.resolve(req.session_id, req.audio, req.asr_text, req.state)
    assert resp.decision == "auto"
    assert resp.speaker_name == "Alice"
    assert resp.evidence.binding_source == "manual_map"


def test_resolve_profile_auto_match_persists_binding() -> None:
    orchestrator = _orchestrator_with_embedding(np.asarray([1.0, 0.0], dtype=np.float32))
    _monkeypatch_normalize(orchestrator)
    state = SessionState(
        participant_profiles=[
            ParticipantProfile(name="Alice", centroid=[1.0, 0.0], sample_count=3, sample_seconds=12, status="ready"),
            ParticipantProfile(name="Bob", centroid=[0.6, 0.8], sample_count=3, sample_seconds=12, status="ready"),
        ]
    )
    req = ResolveRequest(session_id="s2", audio=_audio_payload(), asr_text=None, state=state)
    resp = orchestrator.resolve(req.session_id, req.audio, req.asr_text, req.state)
    assert resp.decision == "auto"
    assert resp.speaker_name == "Alice"
    assert resp.updated_state.bindings["c1"] == "Alice"
    assert resp.evidence.profile_top_name == "Alice"
    assert resp.evidence.profile_top_score is not None
    assert resp.evidence.profile_top_score >= 0.99


def test_resolve_profile_confirm_never_returns_null_name() -> None:
    orchestrator = _orchestrator_with_embedding(np.asarray([1.0, 0.0], dtype=np.float32))
    _monkeypatch_normalize(orchestrator)
    y = math.sqrt(1 - 0.65**2)
    state = SessionState(
        participant_profiles=[
            ParticipantProfile(name="Alice", centroid=[0.65, y], sample_count=3, sample_seconds=12, status="ready"),
            ParticipantProfile(name="Bob", centroid=[0.60, 0.80], sample_count=3, sample_seconds=12, status="ready"),
        ]
    )
    req = ResolveRequest(session_id="s3", audio=_audio_payload(), asr_text=None, state=state)
    resp = orchestrator.resolve(req.session_id, req.audio, req.asr_text, req.state)
    assert resp.decision in {"confirm", "unknown"}
    if resp.decision == "confirm":
        assert resp.speaker_name is not None


def test_resolve_falls_back_to_roster_name_extract() -> None:
    orchestrator = _orchestrator_with_embedding(np.asarray([1.0, 0.0], dtype=np.float32))
    _monkeypatch_normalize(orchestrator)
    state = SessionState(
        roster=[RosterEntry(name="Alice"), RosterEntry(name="Bob")],
    )
    req = ResolveRequest(session_id="s4", audio=_audio_payload(), asr_text="hello my name is alice", state=state)
    resp = orchestrator.resolve(req.session_id, req.audio, req.asr_text, req.state)
    assert resp.decision == "auto"  # confidence 0.95 ("my name is") >= 0.80 persists binding
    assert resp.speaker_name == "Alice"
    assert resp.evidence.binding_source == "name_extract"


def test_enroll_updates_profile_status_to_ready() -> None:
    orchestrator = _orchestrator_with_embedding(np.asarray([1.0, 0.0], dtype=np.float32))
    _monkeypatch_normalize(orchestrator, duration_seconds=4)
    state = SessionState(roster=[RosterEntry(name="Alice")])
    for _ in range(3):
        resp = orchestrator.enroll("enroll-session", "Alice", _audio_payload(), state)
    assert resp.participant_name == "Alice"
    assert resp.profile_updated is True
    assert state.participant_profiles
    profile = state.participant_profiles[0]
    assert profile.sample_count == 3
    assert profile.sample_seconds >= 12
    assert profile.status == "ready"
