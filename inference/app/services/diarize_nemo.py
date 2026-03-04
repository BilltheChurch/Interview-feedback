"""NeMo MSDD (Multi-Scale Diarization Decoder) backend.

Uses NVIDIA NeMo's ClusteringDiarizer with MSDD post-processing
for high-accuracy speaker diarization on GPU.

Model: diar_msdd_telephonic (TitaNet-Large 192-dim embeddings)
Target: DER < 15% on AMI meeting corpus

Requires:
  - nemo_toolkit[asr] >= 2.0.0  (GPU environments only)
  - CUDA-capable GPU recommended (CPU fallback available but slow)

NeMo diarization pipeline:
  1. Voice Activity Detection (MarbleNet)
  2. Speaker segmentation (fixed-length windows)
  3. TitaNet-Large speaker embeddings (192-dim)
  4. Spectral clustering (initial assignment)
  5. MSDD refinement (multi-scale temporal context)

This module degrades gracefully when NeMo is not installed — the class
is still importable but raises ImportError on instantiation.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional NeMo import
# ---------------------------------------------------------------------------

try:
    from nemo.collections.asr.models import ClusteringDiarizer

    NEMO_AVAILABLE = True
except ImportError:
    NEMO_AVAILABLE = False
    ClusteringDiarizer = None  # type: ignore[assignment,misc]

# ---------------------------------------------------------------------------
# Re-export shared result types (defined in diarize_full for compatibility)
# ---------------------------------------------------------------------------

from app.services.diarize_full import DiarizeResult, SpeakerSegment  # noqa: E402


# ---------------------------------------------------------------------------
# NeMo MSDD Diarizer
# ---------------------------------------------------------------------------


class NemoMSDDDiarizer:
    """Full-file speaker diarization using NeMo MSDD pipeline.

    Wraps NeMo's ``ClusteringDiarizer`` which runs:
    - MarbleNet VAD
    - TitaNet-Large speaker embedding (192-dim)
    - Spectral clustering + MSDD refinement

    The same interface as ``PyannoteFullDiarizer`` is provided so either
    backend can be substituted via ``DIARIZATION_BACKEND=nemo`` in config.

    Usage::

        diarizer = NemoMSDDDiarizer(model_name="diar_msdd_telephonic", device="cuda")
        result = diarizer.diarize("/path/to/audio.wav", num_speakers=4)

    Raises:
        ImportError: On instantiation when ``nemo_toolkit[asr]`` is not installed.
    """

    def __init__(
        self,
        model_name: str = "diar_msdd_telephonic",
        device: str = "auto",
        num_speakers: int | None = None,
        min_speakers: int = 1,
        max_speakers: int = 10,
    ) -> None:
        if not NEMO_AVAILABLE:
            raise ImportError(
                "NeMo is not installed. Install it with: pip install nemo_toolkit[asr]>=2.0.0\n"
                "Note: NeMo requires a CUDA-capable GPU for reasonable performance."
            )

        self._model_name = model_name
        self._device = self._resolve_device(device)
        self._default_num_speakers = num_speakers
        self._min_speakers = min_speakers
        self._max_speakers = max_speakers
        self._model: ClusteringDiarizer | None = None  # lazy init

        logger.info(
            "NemoMSDDDiarizer: device=%s, model=%s",
            self._device,
            self._model_name,
        )

    # ------------------------------------------------------------------
    # Public properties
    # ------------------------------------------------------------------

    @property
    def device(self) -> str:
        return self._device

    @property
    def model_name(self) -> str:
        return self._model_name

    # ------------------------------------------------------------------
    # Device resolution
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_device(device: str) -> str:
        """Resolve 'auto' to the best available hardware device."""
        if device != "auto":
            return device
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                # NeMo has limited MPS support; fall back to CPU if MPS not validated
                return "cpu"
        except ImportError:
            pass
        return "cpu"

    # ------------------------------------------------------------------
    # Lazy model loading
    # ------------------------------------------------------------------

    def _ensure_model(self) -> None:
        """Lazy-load the NeMo ClusteringDiarizer model."""
        if self._model is not None:
            return

        logger.info("Loading NeMo diarization model: %s ...", self._model_name)
        self._model = ClusteringDiarizer.from_pretrained(self._model_name)
        logger.info("NeMo model loaded: %s on %s", self._model_name, self._device)

    # ------------------------------------------------------------------
    # Manifest helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _write_manifest(audio_path: str, manifest_path: str, duration: float | None = None) -> None:
        """Write a NeMo-format JSON manifest file for a single audio file.

        NeMo diarization requires an input manifest with one JSON object per
        line containing ``audio_filepath``, ``offset``, ``duration``, and
        ``label`` fields.
        """
        entry: dict = {
            "audio_filepath": audio_path,
            "offset": 0,
            "duration": duration,  # None means "full file"
            "label": "infer",
            "text": "-",
            "num_speakers": None,
            "rttm_filepath": None,
            "uem_filepath": None,
        }
        with open(manifest_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    # ------------------------------------------------------------------
    # RTTM parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_rttm(rttm_path: str) -> list[SpeakerSegment]:
        """Parse an RTTM file into a list of SpeakerSegments.

        RTTM format (space-separated):
            SPEAKER <file_id> 1 <start_sec> <duration_sec> <NA> <NA> <speaker_id> <NA> <NA>
        """
        segments: list[SpeakerSegment] = []
        try:
            with open(rttm_path, encoding="utf-8") as fh:
                for idx, line in enumerate(fh):
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    if len(parts) < 9 or parts[0] != "SPEAKER":
                        continue
                    start_sec = float(parts[3])
                    duration_sec = float(parts[4])
                    speaker_id = parts[7]
                    segments.append(
                        SpeakerSegment(
                            id=f"seg_{idx:04d}",
                            speaker_id=speaker_id,
                            start_ms=int(start_sec * 1000),
                            end_ms=int((start_sec + duration_sec) * 1000),
                            confidence=1.0,
                        )
                    )
        except FileNotFoundError:
            logger.warning("RTTM file not found: %s — returning empty segments", rttm_path)
        return segments

    # ------------------------------------------------------------------
    # Embedding extraction helpers
    # ------------------------------------------------------------------

    def _extract_embeddings(self, segments: list[SpeakerSegment]) -> dict[str, list[float]]:
        """Build per-speaker centroid embeddings from TitaNet outputs.

        NeMo stores embeddings in ``self._model._speaker_model`` after
        diarization. This method extracts them where available, returning
        an empty dict as a graceful fallback.
        """
        embeddings: dict[str, list[float]] = {}
        try:
            if self._model is None:
                return embeddings
            # NeMo stores raw embeddings in the clustering module
            clustering = getattr(self._model, "_cluster_embeddings", None)
            if clustering is None:
                clustering = getattr(self._model, "clus_diar_model", None)
            if clustering is None:
                return embeddings
            emb_array = getattr(clustering, "_embeddings", None)
            labels = getattr(clustering, "_labels", None)
            if emb_array is None or labels is None:
                return embeddings

            import numpy as np

            unique_speakers = sorted(set(s.speaker_id for s in segments))
            for spk in unique_speakers:
                # Gather all embedding indices for this speaker
                indices = [i for i, lbl in enumerate(labels) if str(lbl) == spk or f"speaker_{lbl}" == spk]
                if not indices:
                    continue
                spk_embs = emb_array[indices]  # shape: (n, dim)
                centroid = np.mean(spk_embs, axis=0)
                embeddings[spk] = centroid.tolist()
        except Exception:  # noqa: BLE001 — embedding extraction is best-effort
            logger.warning("NeMo embedding extraction failed; returning empty embeddings", exc_info=True)
        return embeddings

    # ------------------------------------------------------------------
    # Core diarize
    # ------------------------------------------------------------------

    def diarize(
        self,
        audio_path: str,
        num_speakers: int | None = None,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> DiarizeResult:
        """Run NeMo MSDD diarization on an audio file.

        Args:
            audio_path: Path to audio file (WAV 16kHz/mono preferred).
            num_speakers: Exact number of speakers (hint). Overrides min/max.
            min_speakers: Minimum expected speakers.
            max_speakers: Maximum expected speakers.

        Returns:
            DiarizeResult with globally consistent speaker segments.

        Raises:
            FileNotFoundError: If audio_path does not exist.
            RuntimeError: If the NeMo pipeline fails.
            ImportError: If nemo_toolkit is not installed.
        """
        path = Path(audio_path)
        if not path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        self._ensure_model()
        assert self._model is not None  # guaranteed by _ensure_model

        t0 = time.monotonic()

        # Resolve speaker count parameters
        effective_num_speakers = num_speakers if num_speakers is not None else self._default_num_speakers
        effective_min = min_speakers if min_speakers is not None else self._min_speakers
        effective_max = max_speakers if max_speakers is not None else self._max_speakers

        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = os.path.join(tmpdir, "manifest.json")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(output_dir, exist_ok=True)

            self._write_manifest(str(path), manifest_path)

            # Configure the NeMo diarizer for this session
            cfg = self._model.cfg
            cfg.diarizer.manifest_filepath = manifest_path
            cfg.diarizer.out_dir = output_dir

            if effective_num_speakers is not None:
                cfg.diarizer.speaker_embeddings.parameters.num_speakers = effective_num_speakers
                cfg.diarizer.clustering.parameters.oracle_num_speakers = True
            else:
                cfg.diarizer.clustering.parameters.oracle_num_speakers = False
                cfg.diarizer.clustering.parameters.max_num_speakers = effective_max

            logger.info(
                "Running NeMo MSDD diarization on %s (num_speakers=%s, min=%s, max=%s)",
                audio_path,
                effective_num_speakers,
                effective_min,
                effective_max,
            )

            self._model.diarize()

            # NeMo writes an RTTM file per audio file in output_dir/pred_rttms/
            stem = path.stem
            rttm_path = os.path.join(output_dir, "pred_rttms", f"{stem}.rttm")
            segments = self._parse_rttm(rttm_path)

        # Sort segments by start time (NeMo output is usually ordered, but ensure it)
        segments.sort(key=lambda s: s.start_ms)

        # Re-assign sequential IDs after sort
        for i, seg in enumerate(segments):
            object.__setattr__(seg, "id", f"seg_{i:04d}")

        embeddings = self._extract_embeddings(segments)
        duration_ms = segments[-1].end_ms if segments else 0
        elapsed = int((time.monotonic() - t0) * 1000)

        num_unique = len(set(s.speaker_id for s in segments))
        logger.info(
            "NeMo diarization complete: %d segments, %d speakers, %dms processing",
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

        Writes PCM bytes to a temporary WAV file, then runs diarize().
        The WAV file is deleted automatically after processing.
        """
        import wave

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit PCM
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
