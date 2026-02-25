"""Pyannote.audio full-pipeline diarization service.

Runs the complete pyannote/speaker-diarization-3.1 pipeline on a full audio
file, producing globally consistent speaker segments and optional embeddings.

Requires:
  - pyannote.audio >= 3.1
  - A HuggingFace token with accepted pyannote model licenses
  - torch (CUDA, MPS, or CPU)

The service is lazy-initialized: the pipeline is loaded on first call.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from app.services.device import DeviceType, detect_device

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SpeakerSegment:
    id: str
    speaker_id: str
    start_ms: int
    end_ms: int
    confidence: float = 1.0


@dataclass(slots=True)
class DiarizeResult:
    segments: list[SpeakerSegment]
    embeddings: dict[str, list[float]]  # speaker_id -> centroid embedding
    num_speakers: int
    duration_ms: int
    processing_time_ms: int
    global_clustering_done: bool = True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class PyannoteFullDiarizer:
    """Full-file speaker diarization using pyannote.audio.

    Loads the ``pyannote/speaker-diarization-3.1`` pipeline (or a custom
    model ID) and runs it on a complete audio file.

    Usage::

        diarizer = PyannoteFullDiarizer(hf_token="hf_xxx")
        result = diarizer.diarize("/path/to/audio.wav", num_speakers=4)
    """

    def __init__(
        self,
        device: str = "auto",
        hf_token: str | None = None,
        model_id: str = "pyannote/speaker-diarization-3.1",
        embedding_model_id: str = "pyannote/wespeaker-voxceleb-resnet34-LM",
    ) -> None:
        self._device: DeviceType = detect_device() if device == "auto" else device  # type: ignore[assignment]
        self._hf_token = hf_token or os.environ.get("HF_TOKEN", "")
        self._model_id = model_id
        self._embedding_model_id = embedding_model_id
        self._pipeline = None  # lazy init
        self._embedding_model = None  # lazy init
        logger.info(
            "PyannoteFullDiarizer: device=%s, model=%s",
            self._device,
            self._model_id,
        )

    @property
    def device(self) -> DeviceType:
        return self._device

    @property
    def model_id(self) -> str:
        return self._model_id

    def _ensure_pipeline(self):
        """Lazy-load the pyannote pipeline."""
        if self._pipeline is not None:
            return

        if not self._hf_token:
            raise RuntimeError(
                "HuggingFace token required for pyannote.audio. "
                "Set HF_TOKEN environment variable or pass hf_token to constructor. "
                "You must also accept the model license at https://huggingface.co/pyannote/speaker-diarization-3.1"
            )

        from pyannote.audio import Pipeline

        logger.info("Loading pyannote pipeline: %s ...", self._model_id)
        self._pipeline = Pipeline.from_pretrained(
            self._model_id,
            use_auth_token=self._hf_token,
        )

        import torch

        if self._device in ("cuda", "rocm") and torch.cuda.is_available():
            # ROCm uses torch.cuda API via HIP — "cuda" device works for both
            self._pipeline.to(torch.device("cuda"))
        elif self._device == "mps" and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            # pyannote 3.1 has limited MPS support — some ops may fall back to CPU
            try:
                self._pipeline.to(torch.device("mps"))
            except RuntimeError:
                logger.warning("MPS transfer failed for pyannote, falling back to CPU")
                self._pipeline.to(torch.device("cpu"))
        else:
            self._pipeline.to(torch.device("cpu"))

        logger.info("Pyannote pipeline loaded on device=%s", self._device)

    def _ensure_embedding_model(self):
        """Lazy-load the embedding model for speaker centroid extraction."""
        if self._embedding_model is not None:
            return

        if not self._hf_token:
            logger.warning("No HF token — skipping embedding model load")
            return

        try:
            from pyannote.audio import Inference

            logger.info("Loading embedding model: %s ...", self._embedding_model_id)
            self._embedding_model = Inference(
                self._embedding_model_id,
                use_auth_token=self._hf_token,
                window="whole",
            )

            import torch

            if self._device in ("cuda", "rocm") and torch.cuda.is_available():
                self._embedding_model.to(torch.device("cuda"))
        except (ImportError, OSError, RuntimeError):
            logger.warning("Failed to load embedding model, embeddings will be empty", exc_info=True)
            self._embedding_model = None

    def diarize(
        self,
        audio_path: str,
        num_speakers: int | None = None,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> DiarizeResult:
        """Run full-pipeline diarization on an audio file.

        Args:
            audio_path: Path to audio file (WAV preferred, any ffmpeg-supported format).
            num_speakers: Exact number of speakers (hint). Overrides min/max.
            min_speakers: Minimum expected speakers.
            max_speakers: Maximum expected speakers.

        Returns:
            DiarizeResult with globally consistent speaker segments.

        Raises:
            FileNotFoundError: If audio_path does not exist.
            RuntimeError: If pyannote pipeline fails or HF token is missing.
        """
        path = Path(audio_path)
        if not path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        self._ensure_pipeline()

        t0 = time.monotonic()

        # Build kwargs for the pipeline
        kwargs: dict = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        else:
            if min_speakers is not None:
                kwargs["min_speakers"] = min_speakers
            if max_speakers is not None:
                kwargs["max_speakers"] = max_speakers

        logger.info("Running pyannote diarization on %s (kwargs=%s)", audio_path, kwargs)
        diarization = self._pipeline(audio_path, **kwargs)

        # Convert pyannote Annotation to our segment format
        segments: list[SpeakerSegment] = []
        for idx, (turn, _, speaker) in enumerate(diarization.itertracks(yield_label=True)):
            segments.append(
                SpeakerSegment(
                    id=f"seg_{idx:04d}",
                    speaker_id=speaker,
                    start_ms=int(turn.start * 1000),
                    end_ms=int(turn.end * 1000),
                    confidence=1.0,
                )
            )

        # Extract speaker embeddings (centroids) if embedding model available
        embeddings: dict[str, list[float]] = {}
        self._ensure_embedding_model()
        if self._embedding_model is not None:
            embeddings = self._extract_speaker_embeddings(audio_path, diarization)

        # Estimate duration from last segment or from audio
        duration_ms = segments[-1].end_ms if segments else 0
        elapsed = int((time.monotonic() - t0) * 1000)

        num_unique = len(set(s.speaker_id for s in segments))
        logger.info(
            "Diarization complete: %d segments, %d speakers, %dms processing",
            len(segments),
            num_unique,
            elapsed,
        )

        return DiarizeResult(
            segments=segments,
            embeddings=embeddings,
            num_speakers=num_unique,
            duration_ms=duration_ms,
            processing_time_ms=elapsed,
            global_clustering_done=True,
        )

    def diarize_pcm(
        self,
        pcm_data: bytes,
        sample_rate: int = 16000,
        num_speakers: int | None = None,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> DiarizeResult:
        """Diarize raw PCM16 audio data.

        Writes PCM to a temporary WAV file and diarizes it.
        """
        import wave

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_data)
            return self.diarize(
                tmp_path,
                num_speakers=num_speakers,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
        finally:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass

    def _extract_speaker_embeddings(
        self,
        audio_path: str,
        diarization,
    ) -> dict[str, list[float]]:
        """Extract one centroid embedding per speaker from the diarization result.

        For each speaker, we take the longest segment (or average across segments)
        and extract an embedding using the wespeaker model.
        """
        from pyannote.core import Segment

        # Group segments by speaker, pick the longest per speaker
        speaker_segments: dict[str, list[tuple[float, float]]] = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            speaker_segments.setdefault(speaker, []).append((turn.start, turn.end))

        embeddings: dict[str, list[float]] = {}
        for speaker, segs in speaker_segments.items():
            # Use the longest segment for a stable embedding
            segs_sorted = sorted(segs, key=lambda s: s[1] - s[0], reverse=True)
            start, end = segs_sorted[0]
            # Ensure minimum duration
            if end - start < 0.5:
                continue
            try:
                excerpt = Segment(start, min(end, start + 10.0))  # cap at 10s
                emb = self._embedding_model.crop(audio_path, excerpt)
                embeddings[speaker] = emb.flatten().tolist()
            except Exception:  # noqa: BLE001 — per-speaker fault barrier, must not abort other speakers
                logger.warning("Failed to extract embedding for speaker %s", speaker, exc_info=True)
                continue

        return embeddings
