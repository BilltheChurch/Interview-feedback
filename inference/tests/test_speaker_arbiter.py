"""Tests for CAM++ speaker arbitration layer.

CAM++ is only invoked for low-confidence mappings to protect 60s SLA.
"""
from unittest.mock import MagicMock

import numpy as np
import pytest

from app.services.speaker_arbiter import SpeakerArbiter


@pytest.fixture
def mock_sv():
    sv = MagicMock()
    sv.name = "cam++-onnx"
    sv.embedding_dim = 192
    # Return a known embedding
    sv.extract_embedding.return_value = MagicMock(
        embedding=np.array([1.0] * 192, dtype=np.float32),
        confidence=0.9,
    )
    return sv


@pytest.fixture
def arbiter(mock_sv):
    return SpeakerArbiter(sv_backend=mock_sv, confidence_threshold=0.50)


def test_high_confidence_skips_cam_plus(arbiter, mock_sv):
    """High-confidence pyannote mappings should NOT trigger CAM++."""
    mapping = {"local_0": "spk_00", "local_1": "spk_01"}
    confidences = {"local_0": 0.85, "local_1": 0.70}

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={},
        global_profiles={},
    )
    assert result == mapping
    mock_sv.extract_embedding.assert_not_called()


def test_low_confidence_triggers_cam_plus(arbiter, mock_sv):
    """Low-confidence mapping should trigger CAM++ arbitration."""
    mapping = {"local_0": "spk_00"}
    confidences = {"local_0": 0.35}  # below threshold

    # spk_00 centroid points in a different direction (orthogonal-ish)
    # spk_01 centroid points in the same direction as the embedding [1.0]*192
    centroid_00 = np.zeros(192, dtype=np.float32)
    centroid_00[:96] = 1.0  # half-space vector — cosine sim ~0.707 with [1]*192
    centroid_01 = np.ones(192, dtype=np.float32)  # cosine sim = 1.0 with [1]*192

    profiles = {
        "spk_00": MagicMock(centroid=centroid_00),
        "spk_01": MagicMock(centroid=centroid_01),
    }

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={"local_0": "/tmp/seg.wav"},
        global_profiles=profiles,
    )
    # Should have been corrected to spk_01 (closer to [1.0]*192)
    mock_sv.extract_embedding.assert_called_once()
    assert result["local_0"] == "spk_01"


def test_mixed_confidence(arbiter, mock_sv):
    """Mix of high and low confidence."""
    mapping = {"local_0": "spk_00", "local_1": "spk_01"}
    confidences = {"local_0": 0.80, "local_1": 0.30}

    profiles = {
        "spk_00": MagicMock(centroid=np.array([0.5] * 192)),
        "spk_01": MagicMock(centroid=np.array([1.0] * 192)),
    }

    result = arbiter.arbitrate(
        pyannote_mapping=mapping,
        pyannote_confidences=confidences,
        audio_segments={"local_1": "/tmp/seg.wav"},
        global_profiles=profiles,
    )
    assert result["local_0"] == "spk_00"  # kept (high confidence)
    assert mock_sv.extract_embedding.call_count == 1  # only local_1


def test_no_profiles_keeps_original(arbiter, mock_sv):
    """If no global profiles exist, keep original mapping."""
    result = arbiter.arbitrate(
        pyannote_mapping={"local_0": "spk_00"},
        pyannote_confidences={"local_0": 0.30},
        audio_segments={"local_0": "/tmp/seg.wav"},
        global_profiles={},
    )
    assert result["local_0"] == "spk_00"
