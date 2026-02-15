"""Tests for EventsAnalyzer — cue detection, interruption, silence, empty input."""

from __future__ import annotations

from app.schemas import Memo, SpeakerStat, TranscriptUtterance
from app.services.events_analyzer import EventsAnalyzer


def _utt(
    uid: str,
    speaker: str,
    text: str,
    start_ms: int,
    end_ms: int,
    *,
    stream_role: str = "students",
) -> TranscriptUtterance:
    return TranscriptUtterance(
        utterance_id=uid,
        stream_role=stream_role,
        speaker_name=speaker,
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=end_ms - start_ms,
    )


def _stats(*entries: tuple[str, int, int]) -> list[SpeakerStat]:
    return [
        SpeakerStat(speaker_key=key, speaker_name=key, talk_time_ms=talk, turns=turns)
        for key, talk, turns in entries
    ]


# ── Support cue detection ───────────────────────────────────────────────────


def test_support_cue_english() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "We should use microservices.", 0, 3000),
        _utt("u2", "Bob", "I agree, that makes sense.", 3500, 6000),
    ]
    events = analyzer.analyze(
        session_id="s1",
        transcript=transcript,
        memos=[],
        stats=_stats(("Alice", 3000, 1), ("Bob", 3000, 1)),
    )
    support_events = [e for e in events if e.event_type == "support"]
    assert len(support_events) >= 1
    assert support_events[0].actor == "Bob"
    assert support_events[0].target == "Alice"
    assert support_events[0].confidence == 0.72


def test_support_cue_chinese() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "我们用微服务架构", 0, 3000),
        _utt("u2", "Bob", "我同意这个方案", 3500, 6000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 3000, 1), ("Bob", 3000, 1))
    )
    support_events = [e for e in events if e.event_type == "support"]
    assert len(support_events) >= 1
    assert support_events[0].actor == "Bob"


def test_support_cue_no_target_when_same_speaker() -> None:
    """Support cue at position 0 or from same speaker has no target."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "I agree with the plan.", 0, 3000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 3000, 1))
    )
    support_events = [e for e in events if e.event_type == "support"]
    assert len(support_events) == 1
    assert support_events[0].target is None


# ── Summary cue detection ───────────────────────────────────────────────────


def test_summary_cue_english() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "Let me summarize what we discussed.", 0, 4000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 4000, 1))
    )
    summary_events = [e for e in events if e.event_type == "summary"]
    assert len(summary_events) >= 1
    assert summary_events[0].confidence == 0.78


def test_summary_cue_chinese() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "总结一下今天的讨论内容", 0, 4000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 4000, 1))
    )
    summary_events = [e for e in events if e.event_type == "summary"]
    assert len(summary_events) >= 1


# ── Decision cue detection ──────────────────────────────────────────────────


def test_decision_cue_english() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "Our next step is to implement the API.", 0, 4000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 4000, 1))
    )
    decision_events = [e for e in events if e.event_type == "decision"]
    assert len(decision_events) >= 1
    assert decision_events[0].confidence == 0.8


def test_decision_cue_chinese() -> None:
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "我们的结论是采用方案B", 0, 4000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 4000, 1))
    )
    decision_events = [e for e in events if e.event_type == "decision"]
    assert len(decision_events) >= 1


# ── Interruption detection ──────────────────────────────────────────────────


def test_interruption_detected() -> None:
    """Interrupt requires: different speaker, overlap/cut-in within 300ms,
    and previous turn >= 1200ms."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "I was explaining the architecture in detail.", 0, 5000),
        # Bob starts before Alice is done (overlap) — interrupt
        _utt("u2", "Bob", "Wait, I have a question.", 5100, 7000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 5000, 1), ("Bob", 2000, 1))
    )
    interrupt_events = [e for e in events if e.event_type == "interrupt"]
    assert len(interrupt_events) == 1
    assert interrupt_events[0].actor == "Bob"
    assert interrupt_events[0].target == "Alice"
    assert interrupt_events[0].confidence == 0.67


def test_no_interruption_when_prev_turn_too_short() -> None:
    """No interrupt when previous turn is under 1200ms."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "OK.", 0, 800),  # only 800ms
        _utt("u2", "Bob", "Let me continue.", 900, 3000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 800, 1), ("Bob", 2100, 1))
    )
    interrupt_events = [e for e in events if e.event_type == "interrupt"]
    assert len(interrupt_events) == 0


def test_no_interruption_when_same_speaker() -> None:
    """No interrupt when the same speaker continues."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "First part of my answer.", 0, 3000),
        _utt("u2", "Alice", "And the second part.", 3100, 5000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 5000, 2))
    )
    interrupt_events = [e for e in events if e.event_type == "interrupt"]
    assert len(interrupt_events) == 0


# ── Silence detection ───────────────────────────────────────────────────────


def test_silence_detected_for_low_participation() -> None:
    """Speaker with < 5% talk time and <= 2 turns triggers silence event."""
    analyzer = EventsAnalyzer()
    events = analyzer.analyze(
        session_id="s1",
        transcript=[],
        memos=[],
        stats=[
            SpeakerStat(speaker_key="Alice", speaker_name="Alice", talk_time_ms=50000, turns=10),
            SpeakerStat(speaker_key="Bob", speaker_name="Bob", talk_time_ms=1000, turns=1),
        ],
    )
    silence_events = [e for e in events if e.event_type == "silence"]
    assert len(silence_events) == 1
    assert silence_events[0].actor == "Bob"
    assert silence_events[0].confidence == 0.75


def test_no_silence_when_active() -> None:
    """No silence event for speakers with >= 5% talk time."""
    analyzer = EventsAnalyzer()
    events = analyzer.analyze(
        session_id="s1",
        transcript=[],
        memos=[],
        stats=[
            SpeakerStat(speaker_key="Alice", speaker_name="Alice", talk_time_ms=5000, turns=5),
            SpeakerStat(speaker_key="Bob", speaker_name="Bob", talk_time_ms=5000, turns=5),
        ],
    )
    silence_events = [e for e in events if e.event_type == "silence"]
    assert len(silence_events) == 0


# ── Empty transcript ────────────────────────────────────────────────────────


def test_empty_transcript_returns_no_transcript_events() -> None:
    """Empty transcript should not crash and returns no transcript-based events."""
    analyzer = EventsAnalyzer()
    events = analyzer.analyze(
        session_id="s1",
        transcript=[],
        memos=[],
        stats=_stats(("Alice", 5000, 3)),
    )
    # No support/interrupt/summary/decision events (those come from transcript)
    transcript_events = [e for e in events if e.event_type in {"support", "interrupt", "summary", "decision"}]
    assert len(transcript_events) == 0


# ── Memo-to-event lifting ──────────────────────────────────────────────────


def test_observation_memo_creates_summary_event() -> None:
    """Observation memos are lifted as 'summary' events with actor='teacher'."""
    analyzer = EventsAnalyzer()
    events = analyzer.analyze(
        session_id="s1",
        transcript=[],
        memos=[
            Memo(memo_id="m1", created_at_ms=5000, type="observation", tags=[], text="Alice表现积极"),
        ],
        stats=_stats(("Alice", 5000, 3)),
    )
    memo_events = [e for e in events if e.rationale == "teacher memo signal"]
    assert len(memo_events) == 1
    assert memo_events[0].event_type == "summary"
    assert memo_events[0].actor == "teacher"


def test_decision_memo_creates_decision_event() -> None:
    """Decision memos are lifted as 'decision' events."""
    analyzer = EventsAnalyzer()
    events = analyzer.analyze(
        session_id="s1",
        transcript=[],
        memos=[
            Memo(memo_id="m1", created_at_ms=5000, type="decision", tags=[], text="采用方案A"),
        ],
        stats=_stats(("Alice", 5000, 3)),
    )
    memo_events = [e for e in events if e.rationale == "teacher memo signal"]
    assert len(memo_events) == 1
    assert memo_events[0].event_type == "decision"


# ── Event ID uniqueness ────────────────────────────────────────────────────


def test_event_ids_are_unique() -> None:
    """All generated event IDs must be unique."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "I agree, good point. Let me summarize.", 0, 5000),
        _utt("u2", "Bob", "Our next step is clear.", 5100, 8000),
    ]
    events = analyzer.analyze(
        session_id="s1",
        transcript=transcript,
        memos=[
            Memo(memo_id="m1", created_at_ms=5000, type="observation", tags=[], text="Good discussion"),
        ],
        stats=_stats(("Alice", 5000, 1), ("Bob", 3000, 1)),
    )
    ids = [e.event_id for e in events]
    assert len(ids) == len(set(ids)), f"Duplicate event IDs found: {ids}"


# ── Multiple cues in one utterance ──────────────────────────────────────────


def test_multiple_cues_in_same_utterance() -> None:
    """An utterance matching support + summary cues should produce both events."""
    analyzer = EventsAnalyzer()
    transcript = [
        _utt("u1", "Alice", "Something to set context.", 0, 3000),
        _utt("u2", "Bob", "I agree. Let me summarize the key points.", 3500, 7000),
    ]
    events = analyzer.analyze(
        session_id="s1", transcript=transcript, memos=[], stats=_stats(("Alice", 3000, 1), ("Bob", 3500, 1))
    )
    event_types = {e.event_type for e in events if e.actor == "Bob"}
    assert "support" in event_types
    assert "summary" in event_types
