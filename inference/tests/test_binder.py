from app.schemas import ClusterState, RosterEntry, SessionState
from app.services.binder import BinderPolicy
from app.services.name_resolver import NameCandidate


def test_binder_auto_when_high_score_and_roster_hit() -> None:
    policy = BinderPolicy(threshold_low=0.45, threshold_high=0.70)
    state = SessionState(
        clusters=[ClusterState(cluster_id="c1", centroid=[0.0, 1.0], sample_count=1)],
        bindings={},
        roster=[RosterEntry(name="Alice", email="alice@example.com")],
    )

    result = policy.decide(
        state=state,
        cluster_id="c1",
        sv_score=0.8,
        name_candidates=[NameCandidate(name="Alice", confidence=0.95)],
    )

    assert result.decision == "auto"
    assert result.speaker_name == "Alice"
    assert state.bindings["c1"] == "Alice"


def test_binder_confirm_when_mid_score_with_name() -> None:
    policy = BinderPolicy(threshold_low=0.45, threshold_high=0.70)
    state = SessionState(
        clusters=[ClusterState(cluster_id="c2", centroid=[1.0, 0.0], sample_count=1)],
        bindings={},
    )

    result = policy.decide(
        state=state,
        cluster_id="c2",
        sv_score=0.55,
        name_candidates=[NameCandidate(name="Bob", confidence=0.9)],
    )

    assert result.decision == "confirm"
    assert result.speaker_name == "Bob"


def test_binder_unknown_when_low_score() -> None:
    policy = BinderPolicy(threshold_low=0.45, threshold_high=0.70)
    state = SessionState(
        clusters=[ClusterState(cluster_id="c3", centroid=[1.0, 0.0], sample_count=1)],
        bindings={},
    )

    result = policy.decide(
        state=state,
        cluster_id="c3",
        sv_score=0.2,
        name_candidates=[],
    )

    assert result.decision == "unknown"
    assert result.speaker_name is None
