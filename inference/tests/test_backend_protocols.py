"""Tests for Diarization and SV backend protocols."""
import numpy as np

from app.services.backends.diarization_protocol import (
    DiarizationBackend,
    DiarizationResult,
    SpeakerSegment,
)
from app.services.backends.sv_protocol import EmbeddingResult, SVBackend


def test_diarization_segment():
    seg = SpeakerSegment(speaker_id="spk_00", start_ms=0, end_ms=5000)
    assert seg.duration_ms == 5000


def test_diarization_result():
    result = DiarizationResult(
        segments=[
            SpeakerSegment("spk_00", 0, 5000),
            SpeakerSegment("spk_01", 5000, 10000),
        ],
        embeddings={"spk_00": np.zeros(192), "spk_01": np.ones(192)},
        processing_time_ms=1500,
    )
    assert len(result.segments) == 2
    assert result.speaker_count == 2


def test_diarization_protocol_check():
    class FakeDiarizer:
        @property
        def name(self) -> str:
            return "fake"

        def diarize(self, wav_path, num_speakers=None):
            return DiarizationResult([], {}, 0)

    assert isinstance(FakeDiarizer(), DiarizationBackend)


def test_sv_embedding_result():
    emb = EmbeddingResult(
        embedding=np.random.randn(192).astype(np.float32),
        confidence=0.92,
    )
    assert emb.embedding.shape == (192,)
    assert emb.dim == 192


def test_sv_protocol_check():
    class FakeSV:
        @property
        def name(self) -> str:
            return "fake-sv"

        @property
        def embedding_dim(self) -> int:
            return 192

        def extract_embedding(self, wav_path):
            return EmbeddingResult(np.zeros(192), 1.0)

        def score(self, emb_a, emb_b):
            return 0.5

    assert isinstance(FakeSV(), SVBackend)
