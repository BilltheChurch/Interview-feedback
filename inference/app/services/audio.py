from __future__ import annotations

import base64
import subprocess
from dataclasses import dataclass

import numpy as np

from app.exceptions import AudioDecodeError, PayloadTooLargeError, ValidationError
from app.schemas import AudioPayload


@dataclass(slots=True)
class NormalizedAudio:
    sample_rate: int
    samples: np.ndarray
    pcm_s16le: bytes

    @property
    def duration_ms(self) -> int:
        if self.samples.size == 0:
            return 0
        return int((self.samples.size / self.sample_rate) * 1000)


def _decode_base64_or_raise(content_b64: str, max_audio_bytes: int) -> bytes:
    try:
        raw = base64.b64decode(content_b64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise AudioDecodeError("audio.content_b64 is not valid base64") from exc

    if not raw:
        raise AudioDecodeError("audio payload is empty")

    if len(raw) > max_audio_bytes:
        raise PayloadTooLargeError(f"audio payload exceeds max size: {max_audio_bytes} bytes")

    return raw


def normalize_audio_payload(
    payload: AudioPayload,
    target_sample_rate: int,
    max_audio_bytes: int,
    max_audio_seconds: int,
) -> NormalizedAudio:
    raw_audio = _decode_base64_or_raise(payload.content_b64, max_audio_bytes=max_audio_bytes)

    ffmpeg_cmd: list[str] = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if payload.format == "pcm_s16le":
        source_sr = payload.sample_rate or target_sample_rate
        source_channels = payload.channels or 1
        ffmpeg_cmd.extend(
            [
                "-f",
                "s16le",
                "-ar",
                str(source_sr),
                "-ac",
                str(source_channels),
            ]
        )

    ffmpeg_cmd.extend(
        [
            "-i",
            "pipe:0",
            "-ar",
            str(target_sample_rate),
            "-ac",
            "1",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "pipe:1",
        ]
    )

    try:
        process = subprocess.run(
            ffmpeg_cmd,
            input=raw_audio,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AudioDecodeError("ffmpeg is not installed in runtime environment") from exc

    if process.returncode != 0:
        stderr = process.stderr.decode("utf-8", errors="ignore")
        raise AudioDecodeError(f"ffmpeg decode failed: {stderr.strip()}")

    pcm = process.stdout
    if len(pcm) < 2:
        raise AudioDecodeError("decoded audio is empty")

    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    duration_sec = samples.size / float(target_sample_rate)
    if duration_sec > float(max_audio_seconds):
        raise ValidationError(f"audio duration exceeds {max_audio_seconds}s")

    return NormalizedAudio(sample_rate=target_sample_rate, samples=samples, pcm_s16le=pcm)
