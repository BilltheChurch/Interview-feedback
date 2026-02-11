from __future__ import annotations

import logging

import numpy as np

from app.config import Settings
from app.exceptions import ValidationError
from app.schemas import ResolveResponse, SessionState
from app.services.audio import normalize_audio_payload
from app.services.binder import BinderPolicy
from app.services.clustering import OnlineClusterer
from app.services.name_resolver import NameResolver
from app.services.segmenters.base import Segmenter
from app.services.sv import ModelScopeSVBackend

logger = logging.getLogger(__name__)


class InferenceOrchestrator:
    def __init__(
        self,
        settings: Settings,
        segmenter: Segmenter,
        sv_backend: ModelScopeSVBackend,
        clusterer: OnlineClusterer,
        name_resolver: NameResolver,
        binder: BinderPolicy,
    ) -> None:
        self._settings = settings
        self._segmenter = segmenter
        self._sv_backend = sv_backend
        self._clusterer = clusterer
        self._name_resolver = name_resolver
        self._binder = binder

    def _normalize_audio(self, audio_payload):
        return normalize_audio_payload(
            payload=audio_payload,
            target_sample_rate=self._settings.audio_sr,
            max_audio_bytes=self._settings.max_audio_bytes,
            max_audio_seconds=self._settings.max_audio_seconds,
        )

    @staticmethod
    def _aggregate_segment_embeddings(embeddings: list[np.ndarray], durations_ms: list[int]) -> np.ndarray:
        if not embeddings:
            raise ValidationError("no embeddings available for aggregation")

        weights = np.asarray(durations_ms, dtype=np.float32)
        if np.all(weights == 0):
            weights = np.ones_like(weights)

        weighted = np.zeros_like(embeddings[0], dtype=np.float32)
        total = float(np.sum(weights))
        for idx, emb in enumerate(embeddings):
            weighted += emb * (weights[idx] / total)

        norm = np.linalg.norm(weighted)
        if norm == 0.0:
            raise ValidationError("aggregated embedding has zero norm")
        return weighted / norm

    def extract_embedding(self, audio_payload) -> np.ndarray:
        audio = self._normalize_audio(audio_payload)
        return self._sv_backend.extract_embedding_from_audio(audio)

    def score(self, audio_payload_a, audio_payload_b) -> float:
        audio_a = self._normalize_audio(audio_payload_a)
        audio_b = self._normalize_audio(audio_payload_b)
        return self._sv_backend.score_audio(audio_a, audio_b)

    def resolve(self, session_id: str, audio_payload, asr_text: str | None, state: SessionState) -> ResolveResponse:
        audio = self._normalize_audio(audio_payload)
        segments = self._segmenter.segment(audio)
        if not segments:
            raise ValidationError("no speech segment detected by segmenter")

        embeddings: list[np.ndarray] = []
        durations_ms: list[int] = []

        for segment in segments:
            embedding = self._sv_backend.extract_embedding(segment.samples, sample_rate=audio.sample_rate)
            embeddings.append(embedding)
            durations_ms.append(max(segment.end_ms - segment.start_ms, 1))

        utterance_embedding = self._aggregate_segment_embeddings(embeddings=embeddings, durations_ms=durations_ms)
        cluster_id, sv_score = self._clusterer.assign(embedding=utterance_embedding, clusters=state.clusters)

        candidates = self._name_resolver.extract(asr_text)
        bind_result = self._binder.decide(
            state=state,
            cluster_id=cluster_id,
            sv_score=sv_score,
            name_candidates=candidates,
        )
        bind_result.evidence.segment_count = len(segments)

        logger.info(
            "resolve session=%s cluster=%s score=%.4f decision=%s name_hit=%s",
            session_id,
            cluster_id,
            sv_score,
            bind_result.decision,
            bind_result.evidence.name_hit,
        )

        return ResolveResponse(
            session_id=session_id,
            cluster_id=cluster_id,
            speaker_name=bind_result.speaker_name,
            decision=bind_result.decision,
            evidence=bind_result.evidence,
            updated_state=state,
        )
