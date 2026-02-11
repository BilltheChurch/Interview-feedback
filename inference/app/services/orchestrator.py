from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import numpy as np

from app.config import Settings
from app.exceptions import ValidationError
from app.schemas import BindingMeta, EnrollResponse, ParticipantProfile, ResolveEvidence, ResolveResponse, SessionState
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

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _normalize_text_key(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", value.casefold())

    @staticmethod
    def _tokenize_name(value: str) -> set[str]:
        return {token for token in re.split(r"[^a-z0-9]+", value.casefold()) if token}

    def _roster_exact_name(self, state: SessionState, raw_name: str) -> str | None:
        roster = state.roster or []
        if not roster:
            return None
        normalized = self._normalize_text_key(raw_name)
        if not normalized:
            return None
        for item in roster:
            if self._normalize_text_key(item.name) == normalized:
                return item.name
        return None

    def _roster_match_name(self, state: SessionState, raw_name: str) -> str | None:
        roster = state.roster or []
        if not roster:
            return None
        normalized = self._normalize_text_key(raw_name)
        if not normalized:
            return None

        best_name: str | None = None
        best_score = -1.0
        src_tokens = self._tokenize_name(raw_name)
        for item in roster:
            roster_norm = self._normalize_text_key(item.name)
            if not roster_norm:
                continue
            if roster_norm == normalized:
                return item.name
            if len(normalized) >= 4 and (normalized in roster_norm or roster_norm in normalized):
                return item.name

            roster_tokens = self._tokenize_name(item.name)
            if not src_tokens or not roster_tokens:
                continue
            intersect = len(src_tokens & roster_tokens)
            union = len(src_tokens | roster_tokens)
            if union == 0:
                continue
            score = intersect / union
            if score > best_score:
                best_score = score
                best_name = item.name

        if best_score >= 0.6:
            return best_name
        return None

    def _resolve_name_from_roster(self, state: SessionState, asr_text: str | None) -> str | None:
        if not asr_text:
            return None
        candidates = self._name_resolver.extract(asr_text)
        for candidate in candidates:
            matched = self._roster_match_name(state, candidate.name)
            if matched:
                return matched
        return None

    @staticmethod
    def _get_cluster_bound_name(state: SessionState, cluster_id: str) -> str | None:
        bound = state.bindings.get(cluster_id)
        if bound:
            return bound
        for cluster in state.clusters:
            if cluster.cluster_id == cluster_id and cluster.bound_name:
                return cluster.bound_name
        return None

    @staticmethod
    def _get_cluster_binding_meta(state: SessionState, cluster_id: str) -> BindingMeta | None:
        meta = state.cluster_binding_meta.get(cluster_id)
        if meta is None:
            return None
        if isinstance(meta, BindingMeta):
            return meta
        if isinstance(meta, dict):
            return BindingMeta(**meta)
        return None

    @staticmethod
    def _set_cluster_binding(
        state: SessionState,
        cluster_id: str,
        participant_name: str,
        *,
        source: BindingMeta["source"],
        confidence: float,
        locked: bool,
        updated_at: str,
    ) -> None:
        state.bindings[cluster_id] = participant_name
        for cluster in state.clusters:
            if cluster.cluster_id == cluster_id:
                cluster.bound_name = participant_name
                break
        state.cluster_binding_meta[cluster_id] = BindingMeta(
            participant_name=participant_name,
            source=source,
            confidence=confidence,
            locked=locked,
            updated_at=updated_at,
        )

    def _match_profile(
        self, state: SessionState, embedding: np.ndarray
    ) -> tuple[str | None, float | None, float | None]:
        if not state.participant_profiles:
            return None, None, None
        scores: list[tuple[str, float]] = []
        for profile in state.participant_profiles:
            centroid = np.asarray(profile.centroid, dtype=np.float32)
            if centroid.size == 0:
                continue
            score = self._sv_backend.score_embeddings(embedding, centroid)
            scores.append((profile.name, score))
        if not scores:
            return None, None, None
        scores.sort(key=lambda item: item[1], reverse=True)
        top_name, top_score = scores[0]
        second_score = scores[1][1] if len(scores) > 1 else -1.0
        margin = top_score - second_score
        return top_name, top_score, margin

    def _upsert_participant_profile(
        self,
        state: SessionState,
        participant_name: str,
        embedding: np.ndarray,
        sample_seconds: float,
    ) -> ParticipantProfile:
        exact = self._roster_exact_name(state, participant_name)
        final_name = exact or participant_name.strip()
        if not final_name:
            raise ValidationError("participant_name must not be empty")

        roster_email = None
        for item in state.roster or []:
            if self._normalize_text_key(item.name) == self._normalize_text_key(final_name):
                roster_email = item.email
                break

        existing: ParticipantProfile | None = None
        for profile in state.participant_profiles:
            if self._normalize_text_key(profile.name) == self._normalize_text_key(final_name):
                existing = profile
                break

        if existing is None:
            profile = ParticipantProfile(
                name=final_name,
                email=roster_email,
                centroid=embedding.astype(np.float32).tolist(),
                sample_count=1,
                sample_seconds=sample_seconds,
                status="collecting",
            )
            state.participant_profiles.append(profile)
            existing = profile
        else:
            centroid = np.asarray(existing.centroid, dtype=np.float32)
            n = float(max(existing.sample_count, 1))
            updated = ((centroid * n) + embedding) / (n + 1.0)
            existing.centroid = updated.astype(np.float32).tolist()
            existing.sample_count += 1
            existing.sample_seconds += sample_seconds
            if not existing.email and roster_email:
                existing.email = roster_email

        if (
            existing.sample_seconds >= float(self._settings.enrollment_ready_seconds)
            and existing.sample_count >= int(self._settings.enrollment_ready_samples)
        ):
            existing.status = "ready"
        return existing

    def enroll(self, session_id: str, participant_name: str, audio_payload, state: SessionState) -> EnrollResponse:
        audio = self._normalize_audio(audio_payload)
        segments = self._segmenter.segment(audio)
        if not segments:
            raise ValidationError("no speech segment detected by segmenter")
        embeddings: list[np.ndarray] = []
        durations_ms: list[int] = []
        for segment in segments:
            embeddings.append(self._sv_backend.extract_embedding(segment.samples, sample_rate=audio.sample_rate))
            durations_ms.append(max(segment.end_ms - segment.start_ms, 1))
        aggregated = self._aggregate_segment_embeddings(embeddings=embeddings, durations_ms=durations_ms)
        sample_seconds = float(sum(durations_ms)) / 1000.0
        profile = self._upsert_participant_profile(
            state=state,
            participant_name=participant_name,
            embedding=aggregated,
            sample_seconds=sample_seconds,
        )
        logger.info(
            "enroll session=%s participant=%s sample_count=%d sample_seconds=%.2f status=%s",
            session_id,
            profile.name,
            profile.sample_count,
            profile.sample_seconds,
            profile.status,
        )
        return EnrollResponse(
            session_id=session_id,
            participant_name=profile.name,
            embedding_dim=int(aggregated.size),
            sample_seconds=profile.sample_seconds,
            profile_updated=True,
            updated_state=state,
        )

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
        evidence = ResolveEvidence(
            sv_score=sv_score,
            threshold_low=self._settings.sv_t_low,
            threshold_high=self._settings.sv_t_high,
            segment_count=len(segments),
        )
        decision: ResolveResponse["decision"] = "unknown"
        speaker_name: str | None = None

        binding_meta = self._get_cluster_binding_meta(state, cluster_id)
        if binding_meta and binding_meta.locked:
            decision = "auto"
            speaker_name = binding_meta.participant_name
            evidence.binding_source = binding_meta.source
            evidence.reason = "locked manual binding"
        else:
            existing_name = self._get_cluster_bound_name(state, cluster_id)
            if existing_name:
                decision = "auto"
                speaker_name = existing_name
                evidence.binding_source = binding_meta.source if binding_meta else "existing_binding"
                evidence.reason = "existing cluster binding"
            else:
                top_name, top_score, margin = self._match_profile(state, utterance_embedding)
                evidence.profile_top_name = top_name
                evidence.profile_top_score = top_score
                evidence.profile_margin = margin

                if (
                    top_name is not None
                    and top_score is not None
                    and margin is not None
                    and top_score >= self._settings.profile_auto_threshold
                    and margin >= self._settings.profile_margin_threshold
                ):
                    decision = "auto"
                    speaker_name = top_name
                    evidence.binding_source = "enrollment_match"
                    evidence.reason = "profile auto threshold met"
                    self._set_cluster_binding(
                        state=state,
                        cluster_id=cluster_id,
                        participant_name=top_name,
                        source="enrollment_match",
                        confidence=top_score,
                        locked=False,
                        updated_at=self._now_iso(),
                    )
                elif (
                    top_name is not None
                    and top_score is not None
                    and top_score >= self._settings.profile_confirm_threshold
                ):
                    decision = "confirm"
                    speaker_name = top_name
                    evidence.binding_source = "enrollment_match"
                    evidence.reason = "profile confirm threshold met"
                else:
                    extracted = self._resolve_name_from_roster(state, asr_text)
                    if extracted:
                        decision = "confirm"
                        speaker_name = extracted
                        evidence.name_hit = extracted
                        evidence.roster_hit = True
                        evidence.binding_source = "name_extract"
                        evidence.reason = "roster name extracted from ASR"
                    else:
                        decision = "unknown"
                        speaker_name = None
                        evidence.binding_source = "unknown"
                        evidence.reason = "no stable profile/name match"

        if decision == "confirm" and not speaker_name:
            decision = "unknown"
            evidence.reason = "confirm-without-name downgraded to unknown"

        logger.info(
            "resolve session=%s cluster=%s score=%.4f decision=%s speaker=%s source=%s",
            session_id,
            cluster_id,
            sv_score,
            decision,
            speaker_name,
            evidence.binding_source,
        )

        return ResolveResponse(
            session_id=session_id,
            cluster_id=cluster_id,
            speaker_name=speaker_name,
            decision=decision,
            evidence=evidence,
            updated_state=state,
        )
