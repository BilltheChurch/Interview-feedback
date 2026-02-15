"""Tests for audio normalization and ffmpeg subprocess handling."""

from __future__ import annotations

import base64
import subprocess
from unittest.mock import patch

import pytest

from app.exceptions import AudioDecodeError
from app.schemas import AudioPayload
from app.services.audio import normalize_audio_payload


def _make_payload(raw: bytes, fmt: str = "wav", sample_rate: int | None = None) -> AudioPayload:
    return AudioPayload(
        content_b64=base64.b64encode(raw).decode(),
        format=fmt,
        sample_rate=sample_rate,
    )


# ── ffmpeg timeout ───────────────────────────────────────────────────────────


def test_ffmpeg_timeout_raises_audio_decode_error() -> None:
    """subprocess.run raising TimeoutExpired must surface as AudioDecodeError."""
    payload = _make_payload(b"\x00" * 100, fmt="pcm_s16le", sample_rate=16000)

    with patch("app.services.audio.subprocess.run") as mock_run:
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="ffmpeg", timeout=30)
        with pytest.raises(AudioDecodeError, match="timed out"):
            normalize_audio_payload(
                payload,
                target_sample_rate=16000,
                max_audio_bytes=10_000_000,
                max_audio_seconds=300,
            )


def test_ffmpeg_not_installed_raises_audio_decode_error() -> None:
    """FileNotFoundError (ffmpeg missing) must surface as AudioDecodeError."""
    payload = _make_payload(b"\x00" * 100, fmt="pcm_s16le", sample_rate=16000)

    with patch("app.services.audio.subprocess.run") as mock_run:
        mock_run.side_effect = FileNotFoundError("ffmpeg")
        with pytest.raises(AudioDecodeError, match="not installed"):
            normalize_audio_payload(
                payload,
                target_sample_rate=16000,
                max_audio_bytes=10_000_000,
                max_audio_seconds=300,
            )


def test_ffmpeg_nonzero_exit_raises_audio_decode_error() -> None:
    """Non-zero ffmpeg return code must surface as AudioDecodeError."""
    payload = _make_payload(b"\x00" * 100, fmt="pcm_s16le", sample_rate=16000)

    with patch("app.services.audio.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=["ffmpeg"], returncode=1, stdout=b"", stderr=b"invalid data"
        )
        with pytest.raises(AudioDecodeError, match="ffmpeg decode failed"):
            normalize_audio_payload(
                payload,
                target_sample_rate=16000,
                max_audio_bytes=10_000_000,
                max_audio_seconds=300,
            )


# ── invalid input handling ───────────────────────────────────────────────────


def test_invalid_base64_raises_audio_decode_error() -> None:
    """Non-base64 content must raise AudioDecodeError."""
    payload = AudioPayload(content_b64="not-valid-base64!!!", format="wav")
    with pytest.raises(AudioDecodeError, match="not valid base64"):
        normalize_audio_payload(
            payload,
            target_sample_rate=16000,
            max_audio_bytes=10_000_000,
            max_audio_seconds=300,
        )


def test_empty_audio_raises_audio_decode_error() -> None:
    """Empty audio payload must raise AudioDecodeError."""
    payload = _make_payload(b"", fmt="wav")
    with pytest.raises(AudioDecodeError, match="empty"):
        normalize_audio_payload(
            payload,
            target_sample_rate=16000,
            max_audio_bytes=10_000_000,
            max_audio_seconds=300,
        )


def test_oversized_audio_raises_payload_too_large() -> None:
    """Audio exceeding max_audio_bytes must raise PayloadTooLargeError."""
    from app.exceptions import PayloadTooLargeError

    payload = _make_payload(b"\x00" * 1000, fmt="wav")
    with pytest.raises(PayloadTooLargeError, match="exceeds max size"):
        normalize_audio_payload(
            payload,
            target_sample_rate=16000,
            max_audio_bytes=100,  # very small limit
            max_audio_seconds=300,
        )


def test_empty_decoded_output_raises_audio_decode_error() -> None:
    """If ffmpeg produces empty output, raise AudioDecodeError."""
    payload = _make_payload(b"\x00" * 100, fmt="pcm_s16le", sample_rate=16000)

    with patch("app.services.audio.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=["ffmpeg"], returncode=0, stdout=b"", stderr=b""
        )
        with pytest.raises(AudioDecodeError, match="decoded audio is empty"):
            normalize_audio_payload(
                payload,
                target_sample_rate=16000,
                max_audio_bytes=10_000_000,
                max_audio_seconds=300,
            )
