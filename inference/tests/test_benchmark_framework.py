"""Tests for the A/B ASR benchmark framework."""
import pytest
from unittest.mock import MagicMock
from app.services.backends.asr_protocol import TranscriptSegment


def test_compute_wer():
    from tests.benchmark_asr_ab import compute_wer
    assert compute_wer("hello world", "hello world") == 0.0
    assert compute_wer("hello world", "hello") == 0.5  # 1 deletion / 2 words
    assert compute_wer("", "") == 0.0


def test_benchmark_sample():
    from tests.benchmark_asr_ab import BenchmarkSample
    s = BenchmarkSample(
        wav_path="/tmp/test.wav",
        reference="hello world",
        language="en",
        duration_s=2.0,
    )
    assert s.word_count == 2


def test_backend_metrics():
    from tests.benchmark_asr_ab import BackendMetrics
    m = BackendMetrics(
        backend_name="test",
        wer_mean=0.05,
        wer_p95=0.10,
        rtf_mean=0.15,
        latency_p95_s=1.2,
        samples_evaluated=100,
    )
    assert m.passes_threshold(max_wer=0.10, max_rtf=0.20)
    assert not m.passes_threshold(max_wer=0.03, max_rtf=0.20)
