from __future__ import annotations

from dataclasses import dataclass

from app.schemas import ClusterState, ResolveEvidence, SessionState
from app.services.name_resolver import NameCandidate


@dataclass(slots=True)
class BindResult:
    speaker_name: str | None
    decision: str
    evidence: ResolveEvidence


class BinderPolicy:
    def __init__(self, threshold_low: float, threshold_high: float) -> None:
        self._threshold_low = threshold_low
        self._threshold_high = threshold_high

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

    def decide(
        self,
        state: SessionState,
        cluster_id: str,
        sv_score: float,
        name_candidates: list[NameCandidate],
    ) -> BindResult:
        cluster = self._find_cluster(state.clusters, cluster_id)
        existing_name = state.bindings.get(cluster_id) or (cluster.bound_name if cluster else None)
        top_candidate = name_candidates[0] if name_candidates else None
        candidate_name = top_candidate.name if top_candidate else None
        candidate_confidence = top_candidate.confidence if top_candidate else 0.0

        name_hit = candidate_name or existing_name
        roster_hit = self._roster_hit(candidate_name, state)

        decision = "unknown"
        speaker_name: str | None = existing_name

        if sv_score < self._threshold_low:
            if candidate_name is not None:
                decision = "confirm"
                speaker_name = candidate_name
            elif existing_name is not None:
                decision = "confirm"
                speaker_name = existing_name
            else:
                decision = "unknown"
                speaker_name = None
        elif sv_score >= self._threshold_high:
            if candidate_name is not None:
                if roster_hit is False:
                    decision = "confirm"
                    speaker_name = candidate_name
                else:
                    decision = "auto"
                    speaker_name = candidate_name
            elif existing_name is not None:
                decision = "auto"
                speaker_name = existing_name
            else:
                decision = "unknown"
                speaker_name = None
        else:
            if candidate_name is not None:
                decision = "confirm"
                speaker_name = candidate_name
            elif existing_name is not None:
                decision = "confirm"
                speaker_name = existing_name
            else:
                decision = "unknown"
                speaker_name = None

        should_persist_binding = decision == "auto" or (
            decision == "confirm"
            and existing_name is None
            and candidate_name is not None
            and speaker_name == candidate_name
            and candidate_confidence >= 0.93
        )
        if cluster and speaker_name and should_persist_binding:
            cluster.bound_name = speaker_name
            state.bindings[cluster_id] = speaker_name

        evidence = ResolveEvidence(
            sv_score=sv_score,
            threshold_low=self._threshold_low,
            threshold_high=self._threshold_high,
            name_hit=name_hit,
            roster_hit=roster_hit,
            segment_count=0,
        )

        return BindResult(speaker_name=speaker_name, decision=decision, evidence=evidence)
