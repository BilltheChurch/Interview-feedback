"""Parakeet TDT ASR backend — NVIDIA NeMo, CUDA-only.

Production English primary. Falls back to SenseVoice ONNX on non-CUDA.
WER: 6.05% avg (Parakeet TDT 0.6B v2)
"""
from __future__ import annotations

import logging

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

    def transcribe(self, wav_path: str, language: str = "en") -> list[dict]:
        results = self.model.transcribe([wav_path])
        text = results[0] if isinstance(results[0], str) else results[0].text
        return [{"text": text, "language": "en", "confidence": 0.95}]

    def transcribe_with_timestamps(self, wav_path: str, language: str = "en") -> list[dict]:
        results = self.model.transcribe([wav_path], return_hypotheses=True)
        hyp = results[0]
        segments = []
        if hasattr(hyp, "timestep") and hyp.timestep:
            for word_info in hyp.timestep.get("word", []):
                segments.append({
                    "text": word_info.get("word", ""),
                    "start_ms": int(word_info.get("start_offset", 0) * 1000),
                    "end_ms": int(word_info.get("end_offset", 0) * 1000),
                    "confidence": word_info.get("score", 0.95),
                })
        else:
            segments.append({"text": hyp.text, "confidence": 0.95})
        return segments

    def transcribe_pcm(self, pcm_bytes: bytes, sample_rate: int = 16000, language: str = "en") -> list[dict]:
        import os
        import tempfile
        import wave

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
