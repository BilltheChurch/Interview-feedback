from __future__ import annotations

from dataclasses import dataclass

from app.schemas import BindingMeta, ClusterState, ResolveEvidence, SessionState
from app.services.name_resolver import NameCandidate


@dataclass(slots=True)
class BindResult:
    speaker_name: str | None
    decision: str
    evidence: ResolveEvidence


class BinderPolicy:
    def __init__(
        self,
        threshold_low: float,
        threshold_high: float,
        *,
        profile_auto_threshold: float,
        profile_confirm_threshold: float,
        profile_margin_threshold: float,
    ) -> None:
        self._threshold_low = threshold_low
        self._threshold_high = threshold_high
        self._profile_auto_threshold = profile_auto_threshold
        self._profile_confirm_threshold = profile_confirm_threshold
        self._profile_margin_threshold = profile_margin_threshold

    @staticmethod
    def _roster_hit(name: str | None, state: SessionState) -> bool | None:
        if name is None:
            return None
        if not state.roster:
            return None

        target = name.casefold()
        for person in state.roster:
            if person.name.casefold() == target:
                return True
        return False

    @staticmethod
    def _find_cluster(clusters: list[ClusterState], cluster_id: str) -> ClusterState | None:
        for cluster in clusters:
            if cluster.cluster_id == cluster_id:
                return cluster
        return None

    def _set_cluster_binding(
        self,
        *,
        state: SessionState,
        cluster_id: str,
        participant_name: str,
        source: str,
        confidence: float,
        locked: bool,
        updated_at: str,
    ) -> None:
        state.bindings[cluster_id] = participant_name
        cluster = self._find_cluster(state.clusters, cluster_id)
        if cluster:
            cluster.bound_name = participant_name
        state.cluster_binding_meta[cluster_id] = BindingMeta(
            participant_name=participant_name,
            source=source,  # type: ignore[arg-type]
            confidence=confidence,
            locked=locked,
            updated_at=updated_at,
        )

    def _legacy_sv_decide(
        self,
        *,
        state: SessionState,
        cluster_id: str,
        sv_score: float,
        name_candidates: list[NameCandidate],
        now_iso: str,
    ) -> tuple[str | None, str, str | None]:
        cluster = self._find_cluster(state.clusters, cluster_id)
        existing_name = state.bindings.get(cluster_id) or (cluster.bound_name if cluster else None)
        top_candidate = name_candidates[0] if name_candidates else None
        candidate_name = top_candidate.name if top_candidate else None
        candidate_confidence = top_candidate.confidence if top_candidate else 0.0
        roster_hit = self._roster_hit(candidate_name, state)

        decision = "unknown"
        speaker_name: str | None = existing_name
        binding_source: str | None = None

        if sv_score < self._threshold_low:
            if candidate_name is not None:
                decision = "confirm"
                speaker_name = candidate_name
                binding_source = "name_extract"
            elif existing_name is not None:
                decision = "confirm"
                speaker_name = existing_name
                binding_source = "existing_binding"
            else:
                decision = "unknown"
                speaker_name = None
                binding_source = "unknown"
        elif sv_score >= self._threshold_high:
            if candidate_name is not None:
                if roster_hit is False:
                    decision = "confirm"
                else:
                    decision = "auto"
                speaker_name = candidate_name
                binding_source = "name_extract"
            elif existing_name is not None:
                decision = "auto"
                speaker_name = existing_name
                binding_source = "existing_binding"
            else:
                decision = "unknown"
                speaker_name = None
                binding_source = "unknown"
        else:
            if candidate_name is not None:
                decision = "confirm"
                speaker_name = candidate_name
                binding_source = "name_extract"
            elif existing_name is not None:
                decision = "confirm"
                speaker_name = existing_name
                binding_source = "existing_binding"
            else:
                decision = "unknown"
                speaker_name = None
                binding_source = "unknown"

        should_persist_binding = decision == "auto" or (
            decision == "confirm"
            and existing_name is None
            and candidate_name is not None
            and speaker_name == candidate_name
            and candidate_confidence >= 0.93
        )
        if should_persist_binding and speaker_name:
            self._set_cluster_binding(
                state=state,
                cluster_id=cluster_id,
                participant_name=speaker_name,
                source="name_extract",
                confidence=max(min(candidate_confidence, 1.0), -1.0),
                locked=False,
                updated_at=now_iso,
            )

        return speaker_name, decision, binding_source

    def resolve(
        self,
        *,
        state: SessionState,
        cluster_id: str,
        sv_score: float,
        binding_meta: BindingMeta | None,
        profile_top_name: str | None,
        profile_top_score: float | None,
        profile_margin: float | None,
        name_candidates: list[NameCandidate],
        now_iso: str,
    ) -> BindResult:
        evidence = ResolveEvidence(
            sv_score=sv_score,
            threshold_low=self._threshold_low,
            threshold_high=self._threshold_high,
            segment_count=0,
            profile_top_name=profile_top_name,
            profile_top_score=profile_top_score,
            profile_margin=profile_margin,
            name_hit=name_candidates[0].name if name_candidates else None,
            roster_hit=self._roster_hit(name_candidates[0].name if name_candidates else None, state),
        )

        if binding_meta and binding_meta.locked:
            evidence.binding_source = binding_meta.source
            evidence.reason = "locked manual binding"
            return BindResult(
                speaker_name=binding_meta.participant_name,
                decision="auto",
                evidence=evidence,
            )

        cluster = self._find_cluster(state.clusters, cluster_id)
        existing_name = state.bindings.get(cluster_id) or (cluster.bound_name if cluster else None)
        if existing_name:
            evidence.binding_source = binding_meta.source if binding_meta else "existing_binding"
            evidence.reason = "existing cluster binding"
            return BindResult(
                speaker_name=existing_name,
                decision="auto",
                evidence=evidence,
            )

        if (
            profile_top_name is not None
            and profile_top_score is not None
            and profile_margin is not None
            and profile_top_score >= self._profile_auto_threshold
            and profile_margin >= self._profile_margin_threshold
        ):
            self._set_cluster_binding(
                state=state,
                cluster_id=cluster_id,
                participant_name=profile_top_name,
                source="enrollment_match",
                confidence=profile_top_score,
                locked=False,
                updated_at=now_iso,
            )
            evidence.binding_source = "enrollment_match"
            evidence.reason = "profile auto threshold met"
            return BindResult(
                speaker_name=profile_top_name,
                decision="auto",
                evidence=evidence,
            )

        if (
            profile_top_name is not None
            and profile_top_score is not None
            and profile_top_score >= self._profile_confirm_threshold
        ):
            evidence.binding_source = "enrollment_match"
            evidence.reason = "profile confirm threshold met"
            return BindResult(
                speaker_name=profile_top_name,
                decision="confirm",
                evidence=evidence,
            )

        if name_candidates:
            top = name_candidates[0]
            evidence.binding_source = "name_extract"
            evidence.reason = "roster name extracted from ASR"
            return BindResult(
                speaker_name=top.name,
                decision="confirm",
                evidence=evidence,
            )

        speaker_name, decision, binding_source = self._legacy_sv_decide(
            state=state,
            cluster_id=cluster_id,
            sv_score=sv_score,
            name_candidates=name_candidates,
            now_iso=now_iso,
        )
        evidence.binding_source = binding_source
        evidence.reason = "legacy sv/name decision"

        if decision == "confirm" and not speaker_name:
            decision = "unknown"
            evidence.reason = "confirm-without-name downgraded to unknown"
        return BindResult(
            speaker_name=speaker_name,
            decision=decision,
            evidence=evidence,
        )
