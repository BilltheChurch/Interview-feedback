"""Parakeet TDT ASR backend — NVIDIA NeMo, CUDA-only.

Production English primary. Falls back to SenseVoice ONNX on non-CUDA.
WER: 6.05% avg (Parakeet TDT 0.6B v2)

Returns TranscriptResult for compatibility with IncrementalProcessor pipeline.
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
import wave

from app.services.whisper_batch import TranscriptResult, Utterance, WordTimestamp

logger = logging.getLogger(__name__)


class ParakeetTDTTranscriber:
    """NVIDIA Parakeet TDT 0.6B v2 — English real-time ASR.

    Requirements:
    - nemo_toolkit[asr] >= 2.0.0
    - CUDA GPU (will NOT work on MPS or CPU efficiently)
    """

    def __init__(self, model_name: str = "nvidia/parakeet-tdt-0.6b-v2", device: str = "cuda") -> None:
        import nemo.collections.asr as nemo_asr

        self.model = nemo_asr.models.ASRModel.from_pretrained(model_name)
        self.model = self.model.to(device)
        self.model.eval()
        self._device = device
        self.backend = "parakeet"
        self.device = device
        self.model_size = model_name
        logger.info("Parakeet TDT loaded on %s", device)

    def transcribe(self, wav_path: str, language: str = "en") -> TranscriptResult:
        """Transcribe a WAV file and return TranscriptResult."""
        t0 = time.monotonic()
        duration_ms = self._get_wav_duration_ms(wav_path)

        results = self.model.transcribe([wav_path])
        text = results[0] if isinstance(results[0], str) else results[0].text

        elapsed_ms = int((time.monotonic() - t0) * 1000)

        utterance = Utterance(
            id="utt_0",
            text=text,
            start_ms=0,
            end_ms=duration_ms,
            language="en",
            confidence=0.95,
        )

        return TranscriptResult(
            utterances=[utterance],
            language="en",
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend=self.backend,
            model_size=self.model_size,
        )

    def transcribe_with_timestamps(self, wav_path: str, language: str = "en") -> TranscriptResult:
        """Transcribe with word-level timestamps via NeMo hypotheses."""
        t0 = time.monotonic()
        duration_ms = self._get_wav_duration_ms(wav_path)

        results = self.model.transcribe([wav_path], return_hypotheses=True)
        hyp = results[0]

        words: list[WordTimestamp] = []
        full_text = ""

        if hasattr(hyp, "timestep") and hyp.timestep:
            for word_info in hyp.timestep.get("word", []):
                words.append(WordTimestamp(
                    word=word_info.get("word", ""),
                    start_ms=int(word_info.get("start_offset", 0) * 1000),
                    end_ms=int(word_info.get("end_offset", 0) * 1000),
                    confidence=word_info.get("score", 0.95),
                ))
            full_text = " ".join(w.word for w in words)
        else:
            full_text = hyp.text if hasattr(hyp, "text") else str(hyp)

        elapsed_ms = int((time.monotonic() - t0) * 1000)

        utterance = Utterance(
            id="utt_0",
            text=full_text,
            start_ms=0,
            end_ms=duration_ms,
            words=words,
            language="en",
            confidence=0.95,
        )

        return TranscriptResult(
            utterances=[utterance],
            language="en",
            duration_ms=duration_ms,
            processing_time_ms=elapsed_ms,
            backend=self.backend,
            model_size=self.model_size,
        )

    def transcribe_pcm(self, pcm_bytes: bytes, sample_rate: int = 16000, language: str = "en") -> TranscriptResult:
        """Transcribe raw PCM bytes by writing to temp WAV first."""
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        with wave.open(tmp.name, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)
        try:
            return self.transcribe(tmp.name, language)
        finally:
            os.unlink(tmp.name)

    @staticmethod
    def _get_wav_duration_ms(wav_path: str) -> int:
        """Get duration of a WAV file in milliseconds."""
        with wave.open(wav_path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate == 0:
                return 0
            return int(frames / rate * 1000)
