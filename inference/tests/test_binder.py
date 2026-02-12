from datetime import datetime, timezone

from app.schemas import BindingMeta, ClusterState, RosterEntry, SessionState
from app.services.binder import BinderPolicy
from app.services.name_resolver import NameCandidate


def build_policy() -> BinderPolicy:
    return BinderPolicy(
        threshold_low=0.45,
        threshold_high=0.70,
        profile_auto_threshold=0.72,
        profile_confirm_threshold=0.60,
        profile_margin_threshold=0.08,
    )


def test_binder_auto_when_locked_manual_binding() -> None:
    policy = build_policy()
    now = datetime.now(timezone.utc).isoformat()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c1", centroid=[0.0, 1.0], sample_count=1)],
        bindings={},
        roster=[RosterEntry(name="Alice", email="alice@example.com")],
    )
    binding_meta = BindingMeta(
        participant_name="Alice",
        source="manual_map",
        confidence=1.0,
        locked=True,
        updated_at=now,
    )

    result = policy.resolve(
        state=state,
        cluster_id="c1",
        sv_score=0.8,
        binding_meta=binding_meta,
        profile_top_name=None,
        profile_top_score=None,
        profile_margin=None,
        name_candidates=[NameCandidate(name="Alice", confidence=0.95)],
        now_iso=now,
    )

    assert result.decision == "auto"
    assert result.speaker_name == "Alice"


def test_binder_profile_auto_persists_binding() -> None:
    policy = build_policy()
    now = datetime.now(timezone.utc).isoformat()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c2", centroid=[1.0, 0.0], sample_count=1)],
        bindings={},
    )

    result = policy.resolve(
        state=state,
        cluster_id="c2",
        sv_score=0.55,
        binding_meta=None,
        profile_top_name="Bob",
        profile_top_score=0.83,
        profile_margin=0.15,
        name_candidates=[],
        now_iso=now,
    )

    assert result.decision == "auto"
    assert result.speaker_name == "Bob"
    assert state.bindings["c2"] == "Bob"


def test_binder_profile_confirm_without_persist() -> None:
    policy = build_policy()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c3", centroid=[1.0, 0.0], sample_count=1)],
        bindings={},
    )

    result = policy.resolve(
        state=state,
        cluster_id="c3",
        sv_score=0.55,
        binding_meta=None,
        profile_top_name="Charlie",
        profile_top_score=0.65,
        profile_margin=0.04,
        name_candidates=[],
        now_iso=datetime.now(timezone.utc).isoformat(),
    )

    assert result.decision == "confirm"
    assert result.speaker_name == "Charlie"
    assert "c3" not in state.bindings


def test_binder_name_extract_confirm_when_no_profile() -> None:
    policy = build_policy()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c4", centroid=[0.2, 0.8], sample_count=1)],
        bindings={},
        roster=[RosterEntry(name="Daisy", email=None)],
    )

    result = policy.resolve(
        state=state,
        cluster_id="c4",
        sv_score=0.2,
        binding_meta=None,
        profile_top_name=None,
        profile_top_score=None,
        profile_margin=None,
        name_candidates=[NameCandidate(name="Daisy", confidence=0.9)],
        now_iso=datetime.now(timezone.utc).isoformat(),
    )

    assert result.decision == "confirm"
    assert result.speaker_name == "Daisy"


def test_binder_unknown_when_no_signal() -> None:
    policy = build_policy()
    state = SessionState(
        clusters=[ClusterState(cluster_id="c6", centroid=[0.3, 0.7], sample_count=1)],
        bindings={},
    )

    result = policy.resolve(
        state=state,
        cluster_id="c6",
        sv_score=0.8,
        binding_meta=None,
        profile_top_name=None,
        profile_top_score=None,
        profile_margin=None,
        name_candidates=[],
        now_iso=datetime.now(timezone.utc).isoformat(),
    )

    assert result.decision == "unknown"
    assert result.speaker_name is None
