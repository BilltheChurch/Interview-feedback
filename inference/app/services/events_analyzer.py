from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.schemas import AnalysisEvent, Memo, SpeakerStat, TranscriptUtterance


@dataclass(slots=True)
class EventsAnalyzer:
    support_cues: tuple[str, ...] = (
        "i agree",
        "based on",
        "to add",
        "building on",
        "good point",
        "补充",
        "我同意",
        "基于",
        "支持",
        "延续",
    )
    summary_cues: tuple[str, ...] = (
        "let me summarize",
        "in summary",
        "to summarize",
        "总结一下",
        "我们总结",
        "小结",
    )
    decision_cues: tuple[str, ...] = (
        "we decide",
        "decision",
        "next step",
        "conclusion",
        "决定",
        "结论",
        "下一步",
    )

    @staticmethod
    def _speaker_key(item: TranscriptUtterance) -> str:
        if item.speaker_name:
            return item.speaker_name
        if item.cluster_id:
            return item.cluster_id
        if item.stream_role == "teacher":
            return "teacher"
        return "unknown"

    @staticmethod
    def _quote(text: str, limit: int = 160) -> str:
        normalized = " ".join(text.strip().split())
        if len(normalized) <= limit:
            return normalized
        return normalized[: limit - 1].rstrip() + "…"

    @staticmethod
    def _contains_any(text: str, cues: tuple[str, ...]) -> bool:
        lowered = text.casefold()
        return any(cue in lowered for cue in cues)

    def analyze(
        self,
        *,
        session_id: str,
        transcript: list[TranscriptUtterance],
        memos: list[Memo],
        stats: list[SpeakerStat],
    ) -> list[AnalysisEvent]:
        items = sorted(transcript, key=lambda x: (x.start_ms, x.end_ms))
        events: list[AnalysisEvent] = []
        idx = 1

        def append_event(
            event_type: Literal["support", "interrupt", "summary", "decision", "silence"],
            item: TranscriptUtterance,
            *,
            actor: str | None = None,
            target: str | None = None,
            confidence: float = 0.7,
            rationale: str | None = None,
        ) -> None:
            nonlocal idx
            events.append(
                AnalysisEvent(
                    event_id=f"ev_{session_id}_{idx:04d}",
                    event_type=event_type,
                    actor=actor if actor is not None else self._speaker_key(item),
                    target=target,
                    time_range_ms=[item.start_ms, item.end_ms],
                    utterance_ids=[item.utterance_id],
                    quote=self._quote(item.text),
                    confidence=confidence,
                    rationale=rationale,
                )
            )
            idx += 1

        for pos, item in enumerate(items):
            if self._contains_any(item.text, self.support_cues):
                target = None
                if pos > 0:
                    prev = items[pos - 1]
                    prev_speaker = self._speaker_key(prev)
                    now_speaker = self._speaker_key(item)
                    if prev_speaker != now_speaker:
                        target = prev_speaker
                append_event(
                    "support",
                    item,
                    target=target,
                    confidence=0.72,
                    rationale="supportive cue words detected",
                )

            if self._contains_any(item.text, self.summary_cues):
                append_event(
                    "summary",
                    item,
                    confidence=0.78,
                    rationale="summary cue words detected",
                )

            if self._contains_any(item.text, self.decision_cues):
                append_event(
                    "decision",
                    item,
                    confidence=0.8,
                    rationale="decision cue words detected",
                )

            if pos > 0:
                prev = items[pos - 1]
                if self._speaker_key(prev) != self._speaker_key(item):
                    overlap_or_cut_in = item.start_ms <= prev.end_ms + 300
                    prev_long_enough = prev.duration_ms >= 1200
                    if overlap_or_cut_in and prev_long_enough:
                        append_event(
                            "interrupt",
                            item,
                            actor=self._speaker_key(item),
                            target=self._speaker_key(prev),
                            confidence=0.67,
                            rationale="rapid speaker switch near previous turn end",
                        )

        total_talk_ms = sum(max(entry.talk_time_ms, 0) for entry in stats)
        if total_talk_ms > 0:
            for entry in stats:
                ratio = entry.talk_time_ms / total_talk_ms if total_talk_ms else 0
                if ratio < 0.05 and entry.turns <= 2:
                    events.append(
                        AnalysisEvent(
                            event_id=f"ev_{session_id}_{idx:04d}",
                            event_type="silence",
                            actor=entry.speaker_key,
                            target=None,
                            time_range_ms=[0, 0],
                            utterance_ids=[],
                            quote=None,
                            confidence=0.75,
                            rationale="low talk-time ratio and low turns",
                        )
                    )
                    idx += 1

        # Memo notes are strong teacher signals, lift them into summary events when not already captured.
        for memo in memos:
            if memo.type in {"observation", "decision"} and memo.text.strip():
                start_ms = memo.created_at_ms
                end_ms = memo.created_at_ms
                if memo.anchors and memo.anchors.time_range_ms and len(memo.anchors.time_range_ms) == 2:
                    start_ms, end_ms = memo.anchors.time_range_ms
                events.append(
                    AnalysisEvent(
                        event_id=f"ev_{session_id}_{idx:04d}",
                        event_type="summary" if memo.type == "observation" else "decision",
                        actor="teacher",
                        target=None,
                        time_range_ms=[start_ms, end_ms],
                        utterance_ids=memo.anchors.utterance_ids if memo.anchors and memo.anchors.utterance_ids else [],
                        quote=self._quote(memo.text),
                        confidence=0.82,
                        rationale="teacher memo signal",
                    )
                )
                idx += 1

        return events
