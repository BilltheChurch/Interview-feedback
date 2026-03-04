"""Test CAM++ SpeakerArbiter integration with IncrementalProcessor."""
from unittest.mock import MagicMock

import numpy as np

from app.services.speaker_arbiter import SpeakerArbiter


def test_arbiter_skips_high_confidence():
    """Arbiter should not modify high-confidence mappings."""
    sv = MagicMock()
    arbiter = SpeakerArbiter(sv_backend=sv, confidence_threshold=0.50)

    mapping = {"local_0": "global_0"}
    confidences = {"local_0": 0.85}  # high confidence
    segments = {"local_0": "/tmp/test.wav"}

    result = arbiter.arbitrate(mapping, confidences, segments, {})
    assert result == {"local_0": "global_0"}
    sv.extract_embedding.assert_not_called()


def test_arbiter_corrects_low_confidence():
    """Arbiter should correct low-confidence mappings via CAM++."""
    sv = MagicMock()
    emb = np.random.randn(192).astype(np.float32)
    sv.extract_embedding.return_value = MagicMock(embedding=emb)
    arbiter = SpeakerArbiter(sv_backend=sv, confidence_threshold=0.50)

    class FakeProfile:
        centroid = emb  # same embedding -> sim ~1.0

    mapping = {"local_0": "global_0"}
    confidences = {"local_0": 0.30}  # LOW -> triggers arbiter
    segments = {"local_0": "/tmp/test.wav"}
    profiles = {"global_1": FakeProfile()}

    result = arbiter.arbitrate(mapping, confidences, segments, profiles)
    assert result["local_0"] == "global_1"


def test_processor_accepts_arbiter_param():
    """IncrementalProcessor should accept optional arbiter parameter."""
    from app.services.incremental_processor import IncrementalProcessor

    proc = IncrementalProcessor(
        settings=MagicMock(),
        diarizer=MagicMock(),
        asr_backend=MagicMock(),
        checkpoint_analyzer=MagicMock(),
        arbiter=MagicMock(),  # NEW param
    )
    assert proc._arbiter is not None


def test_processor_works_without_arbiter():
    """IncrementalProcessor should work without arbiter (backward compat)."""
    from app.services.incremental_processor import IncrementalProcessor

    proc = IncrementalProcessor(
        settings=MagicMock(),
        diarizer=MagicMock(),
        asr_backend=MagicMock(),
        checkpoint_analyzer=MagicMock(),
    )
    assert proc._arbiter is None
