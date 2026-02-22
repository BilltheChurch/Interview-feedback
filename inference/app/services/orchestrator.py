from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import numpy as np

from app.config import Settings
from app.exceptions import ValidationError
from app.schemas import BindingMeta, EnrollResponse, ParticipantProfile, ResolveResponse, SessionState
from app.services.audio import normalize_audio_payload
from app.services.binder import BinderPolicy
from app.services.clustering import OnlineClusterer
from app.services.name_resolver import NameCandidate, NameResolver
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
        return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value.casefold())

    @staticmethod
    def _tokenize_name(value: str) -> set[str]:
        normalized = value.casefold()
        raw_tokens = [token for token in re.split(r"[^a-z0-9\u4e00-\u9fff]+", normalized) if token]
        tokens: set[str] = set()
        for token in raw_tokens:
            tokens.add(token)
            if re.search(r"[\u4e00-\u9fff]", token) and len(token) >= 2:
                for idx in range(len(token) - 1):
                    tokens.add(token[idx : idx + 2])
        return tokens

    @staticmethod
    def _levenshtein_distance(a: str, b: str) -> int:
        """Compute Levenshtein edit distance between two strings."""
        m, n = len(a), len(b)
        if m == 0:
            return n
        if n == 0:
            return m
        prev = list(range(n + 1))
        for i in range(1, m + 1):
            curr = [i] + [0] * n
            for j in range(1, n + 1):
                cost = 0 if a[i - 1] == b[j - 1] else 1
                curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            prev = curr
        return prev[n]

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
        stripped = raw_name.strip()
        if not stripped:
            return None
        token_count = len([token for token in re.split(r"\s+", stripped) if token])
        normalized = self._normalize_text_key(raw_name)
        if not normalized:
            return None
        # Reject long English phrases (e.g. "studying in the Netherlands...") from
        # being treated as candidate names.
        if not re.search(r"[\u4e00-\u9fff]", normalized) and token_count >= 4:
            return None

        best_name: str | None = None
        best_score = -1.0
        # Track best edit-distance match as a separate fallback.
        best_edit_name: str | None = None
        best_edit_dist = 3  # only accept distance <= 2
        src_tokens = self._tokenize_name(raw_name)
        for item in roster:
            roster_norm = self._normalize_text_key(item.name)
            if not roster_norm:
                continue
            if roster_norm == normalized:
                return item.name
            if (
                re.search(r"[\u4e00-\u9fff]", normalized)
                and len(normalized) >= 2
                and (normalized in roster_norm or roster_norm in normalized)
            ):
                return item.name

            # Edit-distance fuzzy match: both names >= 5 chars and distance <= 2.
            if len(normalized) >= 5 and len(roster_norm) >= 5:
                dist = self._levenshtein_distance(normalized, roster_norm)
                if dist <= 2 and dist < best_edit_dist:
                    best_edit_dist = dist
                    best_edit_name = item.name

            roster_tokens = self._tokenize_name(item.name)
            if not src_tokens or not roster_tokens:
                continue
            intersect = len(src_tokens & roster_tokens)
            union = len(src_tokens | roster_tokens)
            if union == 0:
                continue
            score = intersect / union
            if not re.search(r"[\u4e00-\u9fff]", normalized):
                if token_count == 1:
                    # For Latin names, only allow fuzzy match when the token starts
                    # with the roster token to avoid matching arbitrary phrases.
                    if not any(
                        src.startswith(roster_token) or roster_token.startswith(src)
                        for src in src_tokens
                        for roster_token in roster_tokens
                    ):
                        continue
                elif token_count > 2:
                    continue
            if score > best_score:
                best_score = score
                best_name = item.name

        if re.search(r"[\u4e00-\u9fff]", normalized):
            if best_score >= 0.5:
                return best_name
            return best_edit_name
        if best_score >= 0.6:
            return best_name
        # Fall back to edit-distance match if token-based matching failed.
        return best_edit_name

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

    @staticmethod
    def _is_recent_binding(updated_at: str | None, *, window_seconds: int = 30) -> bool:
        if not updated_at:
            return False
        try:
            ts = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        delta = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
        return delta.total_seconds() <= window_seconds

    @staticmethod
    def _confidence_for_meta(profile_top_score: float | None, sv_score: float) -> float:
        base = profile_top_score if profile_top_score is not None else sv_score
        if base is None:
            base = 0.0
        return max(min(float(base), 1.0), -1.0)

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
        binding_meta = self._get_cluster_binding_meta(state, cluster_id)
        top_name, top_score, margin = self._match_profile(state, utterance_embedding)

        roster_candidates: list[NameCandidate] = []
        if asr_text:
            dedup: set[str] = set()
            for candidate in self._name_resolver.extract(asr_text):
                matched = self._roster_match_name(state, candidate.name)
                if not matched:
                    continue
                key = matched.casefold()
                if key in dedup:
                    continue
                dedup.add(key)
                roster_candidates.append(NameCandidate(name=matched, confidence=candidate.confidence))

        bind_result = self._binder.resolve(
            state=state,
            cluster_id=cluster_id,
            sv_score=sv_score,
            binding_meta=binding_meta,
            profile_top_name=top_name,
            profile_top_score=top_score,
            profile_margin=margin,
            name_candidates=roster_candidates,
            now_iso=self._now_iso(),
        )
        bind_result.evidence.segment_count = len(segments)
        now_iso = self._now_iso()

        # Stabilize confirm/unknown outputs within a time window so the
        # same cluster does not bounce between different candidate names.
        # 300s window covers group interviews where same speaker may not
        # speak again for minutes.
        if (
            binding_meta
            and not binding_meta.locked
            and binding_meta.participant_name
            and self._is_recent_binding(binding_meta.updated_at, window_seconds=300)
        ):
            if bind_result.decision == "unknown":
                bind_result.speaker_name = binding_meta.participant_name
                bind_result.decision = "confirm"
                bind_result.evidence.binding_source = binding_meta.source
                bind_result.evidence.reason = "stabilized by recent cluster candidate"
            elif bind_result.speaker_name and bind_result.speaker_name != binding_meta.participant_name:
                bind_result.speaker_name = binding_meta.participant_name
                bind_result.evidence.binding_source = binding_meta.source
                bind_result.evidence.reason = "stabilized by recent cluster candidate"

        if bind_result.speaker_name and bind_result.decision in {"auto", "confirm"}:
            source = bind_result.evidence.binding_source
            if source not in {"enrollment_match", "name_extract", "manual_map"}:
                source = "name_extract"
            # Persist both cluster_binding_meta AND state.bindings so subsequent
            # resolves immediately find the existing binding
            state.bindings[cluster_id] = bind_result.speaker_name
            cluster_obj = None
            for c in state.clusters:
                if c.cluster_id == cluster_id:
                    cluster_obj = c
                    break
            if cluster_obj:
                cluster_obj.bound_name = bind_result.speaker_name
            state.cluster_binding_meta[cluster_id] = BindingMeta(
                participant_name=bind_result.speaker_name,
                source=source,  # type: ignore[arg-type]
                confidence=self._confidence_for_meta(top_score, sv_score),
                locked=False,
                updated_at=now_iso,
            )

        logger.info(
            "resolve session=%s cluster=%s score=%.4f decision=%s speaker=%s source=%s",
            session_id,
            cluster_id,
            sv_score,
            bind_result.decision,
            bind_result.speaker_name,
            bind_result.evidence.binding_source,
        )

        return ResolveResponse(
            session_id=session_id,
            cluster_id=cluster_id,
            speaker_name=bind_result.speaker_name,
            decision=bind_result.decision,  # type: ignore[arg-type]
            evidence=bind_result.evidence,
            updated_state=state,
        )
