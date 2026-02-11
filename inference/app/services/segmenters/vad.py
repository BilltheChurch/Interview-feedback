from __future__ import annotations

import webrtcvad

from app.services.audio import NormalizedAudio
from app.services.segmenters.base import Segment


class VADSegmenter:
    def __init__(
        self,
        mode: int,
        frame_ms: int,
        min_speech_ms: int,
        min_silence_ms: int,
    ) -> None:
        if mode < 0 or mode > 3:
            raise ValueError("vad mode must be in [0, 3]")
        self._vad = webrtcvad.Vad(mode)
        self._frame_ms = frame_ms
        self._min_speech_ms = min_speech_ms
        self._min_silence_ms = min_silence_ms

    def segment(self, audio: NormalizedAudio) -> list[Segment]:
        sr = audio.sample_rate
        frame_size = int(sr * (self._frame_ms / 1000.0))
        if frame_size <= 0:
            return []

        frame_bytes = frame_size * 2
        pcm = audio.pcm_s16le

        speech_segments: list[tuple[int, int]] = []
        in_speech = False
        speech_start = 0
        silence_ms = 0
        cursor = 0

        while cursor + frame_bytes <= len(pcm):
            frame = pcm[cursor : cursor + frame_bytes]
            is_speech = self._vad.is_speech(frame, sr)

            if is_speech and not in_speech:
                in_speech = True
                speech_start = cursor // 2
                silence_ms = 0
            elif is_speech and in_speech:
                silence_ms = 0
            elif not is_speech and in_speech:
                silence_ms += self._frame_ms
                if silence_ms >= self._min_silence_ms:
                    speech_end = max((cursor // 2) - int(sr * (silence_ms / 1000.0)), speech_start)
                    speech_segments.append((speech_start, speech_end))
                    in_speech = False
                    silence_ms = 0

            cursor += frame_bytes

        if in_speech:
            speech_segments.append((speech_start, len(pcm) // 2))

        segments: list[Segment] = []
        for start_sample, end_sample in speech_segments:
            duration_ms = int(((end_sample - start_sample) / sr) * 1000)
            if duration_ms < self._min_speech_ms:
                continue
            segments.append(
                Segment(
                    start_ms=int((start_sample / sr) * 1000),
                    end_ms=int((end_sample / sr) * 1000),
                    samples=audio.samples[start_sample:end_sample],
                )
            )

        return segments
