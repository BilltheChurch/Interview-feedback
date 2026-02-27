"""Streaming ASR service using sherpa-onnx OnlineRecognizer.

Uses the Paraformer trilingual model (Chinese + English + Cantonese) for
real-time streaming transcription. Replaces FunASR DashScope WebSocket
with a local, zero-latency solution.

Each session gets a persistent stream handle that accepts incremental
audio chunks and returns partial/final results.

Architecture:
    Desktop → Edge Worker → Inference /asr/stream (WebSocket)
    Audio chunks flow in, text results flow out.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_recognizer: Any | None = None
_recognizer_lock = threading.Lock()
_onnx_provider: str | None = None


def _detect_onnx_provider() -> str:
    """Auto-detect best ONNX Runtime provider: CoreML > CUDA > CPU."""
    try:
        import onnxruntime as ort

        available = ort.get_available_providers()
        if "CoreMLExecutionProvider" in available:
            return "coreml"
        if "CUDAExecutionProvider" in available:
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def _get_streaming_recognizer(model_dir: str) -> Any:
    """Lazy-load streaming Paraformer OnlineRecognizer (thread-safe singleton).

    Uses the trilingual model (zh + en + cantonese) for universal streaming ASR.
    """
    global _recognizer, _onnx_provider
    if _recognizer is not None:
        return _recognizer

    with _recognizer_lock:
        if _recognizer is not None:
            return _recognizer

        import sherpa_onnx

        # INT8 quantized (228MB total) preferred over FP32 (825MB)
        encoder_int8 = os.path.join(model_dir, "encoder.int8.onnx")
        encoder_fp32 = os.path.join(model_dir, "encoder.onnx")
        decoder_int8 = os.path.join(model_dir, "decoder.int8.onnx")
        decoder_fp32 = os.path.join(model_dir, "decoder.onnx")
        tokens_path = os.path.join(model_dir, "tokens.txt")

        encoder = encoder_int8 if os.path.exists(encoder_int8) else encoder_fp32
        decoder = decoder_int8 if os.path.exists(decoder_int8) else decoder_fp32

        for path, name in [
            (encoder, "encoder"),
            (decoder, "decoder"),
            (tokens_path, "tokens"),
        ]:
            if not os.path.exists(path):
                raise FileNotFoundError(f"Streaming Paraformer {name} not found: {path}")

        _onnx_provider = _detect_onnx_provider()
        logger.info(
            "Loading streaming Paraformer from %s (provider=%s)",
            model_dir, _onnx_provider,
        )
        start = time.perf_counter()

        rec = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=tokens_path,
            encoder=encoder,
            decoder=decoder,
            num_threads=4,
            sample_rate=16000,
            feature_dim=80,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,   # endpoint after 2.4s silence (final)
            rule2_min_trailing_silence=1.2,   # endpoint after 1.2s silence (mid-utterance)
            rule3_min_utterance_length=20.0,  # force endpoint after 20s continuous speech
            decoding_method="greedy_search",
            provider=_onnx_provider,
        )

        load_time = time.perf_counter() - start
        logger.info(
            "Streaming Paraformer loaded in %.2fs (provider=%s)",
            load_time, _onnx_provider,
        )
        _recognizer = rec
        return rec


@dataclass
class StreamingResult:
    """Result from processing a chunk of audio."""
    text: str
    is_final: bool
    segment_id: int
    start_ms: int = 0
    end_ms: int = 0


@dataclass
class StreamingSession:
    """Persistent streaming ASR session for one audio stream.

    Wraps a sherpa-onnx OnlineStream and tracks state across chunks.
    """
    session_id: str
    stream: Any = None  # sherpa_onnx OnlineStream
    _recognizer: Any = None
    _segment_id: int = 0
    _total_samples: int = 0
    _last_text: str = ""
    _created_at: float = field(default_factory=time.monotonic)

    def feed_pcm(self, pcm_samples: list[float], sample_rate: int = 16000) -> list[StreamingResult]:
        """Feed audio samples and return any available results.

        Args:
            pcm_samples: Float32 audio samples in [-1.0, 1.0].
            sample_rate: Sample rate (must match recognizer, typically 16000).

        Returns:
            List of StreamingResult (may be empty if no endpoint detected yet).
        """
        if self.stream is None:
            raise RuntimeError("Session not initialized. Call start() first.")

        self.stream.accept_waveform(sample_rate, pcm_samples)
        self._total_samples += len(pcm_samples)

        results: list[StreamingResult] = []

        while self._recognizer.is_ready(self.stream):
            self._recognizer.decode_stream(self.stream)

        current_text = self._recognizer.get_result(self.stream).strip()

        # Check for endpoint (utterance boundary)
        if self._recognizer.is_endpoint(self.stream):
            if current_text:
                end_ms = int(self._total_samples / sample_rate * 1000)
                results.append(StreamingResult(
                    text=current_text,
                    is_final=True,
                    segment_id=self._segment_id,
                    end_ms=end_ms,
                ))
                self._segment_id += 1
            self._recognizer.reset(self.stream)
            self._last_text = ""
        elif current_text and current_text != self._last_text:
            # Partial result changed
            end_ms = int(self._total_samples / sample_rate * 1000)
            results.append(StreamingResult(
                text=current_text,
                is_final=False,
                segment_id=self._segment_id,
                end_ms=end_ms,
            ))
            self._last_text = current_text

        return results

    @property
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._created_at) * 1000)


class StreamingASRService:
    """Manages streaming ASR sessions.

    One service instance per inference server. Sessions are created per
    audio stream (one per WebSocket connection from Edge Worker).
    """

    def __init__(
        self,
        model_dir: str = "~/.cache/streaming-paraformer/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en",
    ) -> None:
        self._model_dir = os.path.expanduser(model_dir)
        self._sessions: dict[str, StreamingSession] = {}
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        """Check if the streaming model exists."""
        tokens = os.path.join(self._model_dir, "tokens.txt")
        return os.path.exists(tokens)

    @property
    def provider(self) -> str:
        return _onnx_provider or "cpu"

    def create_session(self, session_id: str) -> StreamingSession:
        """Create a new streaming session."""
        recognizer = _get_streaming_recognizer(self._model_dir)
        stream = recognizer.create_stream()

        session = StreamingSession(
            session_id=session_id,
            stream=stream,
            _recognizer=recognizer,
        )

        with self._lock:
            # Clean up old session if exists
            if session_id in self._sessions:
                logger.warning("Replacing existing session: %s", session_id)
            self._sessions[session_id] = session

        logger.info("Created streaming session: %s", session_id)
        return session

    def get_session(self, session_id: str) -> StreamingSession | None:
        """Get an existing session by ID."""
        return self._sessions.get(session_id)

    def close_session(self, session_id: str) -> None:
        """Close and remove a streaming session."""
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            logger.info(
                "Closed streaming session: %s (elapsed=%dms)",
                session_id, session.elapsed_ms,
            )

    def active_sessions(self) -> int:
        """Number of active sessions."""
        return len(self._sessions)
