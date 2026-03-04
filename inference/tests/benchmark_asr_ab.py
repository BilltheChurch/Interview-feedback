"""A/B ASR Benchmark Framework.

Evaluates ASR backends on the same dataset, computing WER/CER/RTF/latency.
Used to decide which model to deploy for English interview scenarios.

Usage:
    cd inference
    python tests/benchmark_asr_ab.py --dataset /path/to/samples.json --backends sensevoice,moonshine
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

# ── Metrics ───────────────────────────────────────────────────────


def compute_wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate via edit distance."""
    ref_words = reference.strip().split()
    hyp_words = hypothesis.strip().split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0

    d = [[0] * (len(hyp_words) + 1) for _ in range(len(ref_words) + 1)]
    for i in range(len(ref_words) + 1):
        d[i][0] = i
    for j in range(len(hyp_words) + 1):
        d[0][j] = j
    for i in range(1, len(ref_words) + 1):
        for j in range(1, len(hyp_words) + 1):
            cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1,      # deletion
                d[i][j - 1] + 1,      # insertion
                d[i - 1][j - 1] + cost  # substitution
            )
    return d[len(ref_words)][len(hyp_words)] / len(ref_words)


@dataclass
class BenchmarkSample:
    wav_path: str
    reference: str
    language: str
    duration_s: float
    speaker_id: str = ""

    @property
    def word_count(self) -> int:
        return len(self.reference.strip().split())


@dataclass
class BackendMetrics:
    backend_name: str
    wer_mean: float
    wer_p95: float
    rtf_mean: float
    latency_p95_s: float
    samples_evaluated: int

    def passes_threshold(self, max_wer: float, max_rtf: float) -> bool:
        return self.wer_mean <= max_wer and self.rtf_mean <= max_rtf

    def to_dict(self) -> dict:
        return {
            "backend": self.backend_name,
            "wer_mean": round(self.wer_mean, 4),
            "wer_p95": round(self.wer_p95, 4),
            "rtf_mean": round(self.rtf_mean, 4),
            "latency_p95_s": round(self.latency_p95_s, 3),
            "samples": self.samples_evaluated,
        }


class ASRBenchmark:
    """Run A/B comparison across ASR backends."""

    def __init__(self, backends: list, samples: list[BenchmarkSample]):
        self.backends = backends
        self.samples = samples

    def run(self) -> list[BackendMetrics]:
        results = []
        for backend in self.backends:
            metrics = self._evaluate(backend)
            results.append(metrics)
        return sorted(results, key=lambda m: m.wer_mean)

    def _evaluate(self, backend) -> BackendMetrics:
        wer_scores = []
        rtf_scores = []
        latencies = []

        for sample in self.samples:
            t0 = time.monotonic()
            segments = backend.transcribe(sample.wav_path, language=sample.language)
            latency = time.monotonic() - t0

            hypothesis = " ".join(seg.text for seg in segments)
            wer = compute_wer(sample.reference, hypothesis)
            rtf = latency / max(sample.duration_s, 0.001)

            wer_scores.append(wer)
            rtf_scores.append(rtf)
            latencies.append(latency)

        return BackendMetrics(
            backend_name=backend.name,
            wer_mean=float(np.mean(wer_scores)) if wer_scores else 0.0,
            wer_p95=float(np.percentile(wer_scores, 95)) if wer_scores else 0.0,
            rtf_mean=float(np.mean(rtf_scores)) if rtf_scores else 0.0,
            latency_p95_s=float(np.percentile(latencies, 95)) if latencies else 0.0,
            samples_evaluated=len(self.samples),
        )
