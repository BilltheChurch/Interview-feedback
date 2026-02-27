"""GATE 1 WER benchmark: language-adaptive ONNX ASR evaluation.

Uses optimal model per language:
    English → Moonshine Base ONNX (WER ~3.23% on LibriSpeech)
    Chinese → SenseVoice ONNX (CER ~5.17% on AISHELL-1)

Requires:
    pip install jiwer datasets soundfile

Usage:
    # Run both EN + ZH benchmarks (full test sets, may take 30-60 min)
    python tests/benchmark_wer.py

    # Quick smoke test (first 50 samples only)
    python tests/benchmark_wer.py --max-samples 50

    # English only
    python tests/benchmark_wer.py --lang en --max-samples 100

    # Chinese only
    python tests/benchmark_wer.py --lang zh --max-samples 100

GATE 1 thresholds:
    G1.3: Chinese CER (AISHELL-1 test) < 8%
    G1.4: English WER (LibriSpeech test-clean) < 5%
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

# Add parent to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def ensure_dependencies():
    """Check and report missing dependencies."""
    missing = []
    try:
        import jiwer  # noqa: F401
    except ImportError:
        missing.append("jiwer")
    try:
        import datasets  # noqa: F401
    except ImportError:
        missing.append("datasets")
    try:
        import soundfile  # noqa: F401
    except ImportError:
        missing.append("soundfile")

    if missing:
        print(f"Missing dependencies: {', '.join(missing)}")
        print(f"Install with: pip install {' '.join(missing)}")
        sys.exit(1)


def normalize_en(text: str) -> str:
    """Normalize English text for WER comparison.

    Handles ITN (Inverse Text Normalization) differences: SenseVoice normalizes
    titles and numbers during transcription (e.g. 'MISTER' → 'MR'),
    so we normalize both ref and hyp consistently.
    """
    text = text.upper()
    # Remove punctuation
    text = re.sub(r"[^\w\s]", "", text)
    # Normalize common ITN differences
    text = re.sub(r"\bMISTER\b", "MR", text)
    text = re.sub(r"\bMISSUS\b", "MRS", text)
    text = re.sub(r"\bDOCTOR\b", "DR", text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_zh(text: str) -> str:
    """Normalize Chinese text for CER comparison.

    AISHELL-1 uses character-level WER (CER):
    - Remove all spaces (Chinese doesn't use word separators)
    - Remove punctuation
    - Keep Chinese characters and digits
    """
    # Remove all punctuation (Chinese and English)
    text = re.sub(r"[，。！？、；：\u201c\u201d\u2018\u2019（）《》【】\s]", "", text)
    text = re.sub(r"[^\u4e00-\u9fff\u3400-\u4dbf0-9a-zA-Z]", "", text)
    return text


def audio_to_wav_path(audio_dict: dict) -> str:
    """Convert HuggingFace audio dict to a temp WAV file path."""
    array = audio_dict["array"]
    sr = audio_dict["sampling_rate"]

    # Resample to 16kHz if needed
    if sr != 16000:
        # Simple linear interpolation resampling
        duration = len(array) / sr
        n_samples = int(duration * 16000)
        indices = np.linspace(0, len(array) - 1, n_samples)
        array = np.interp(indices, np.arange(len(array)), array)
        sr = 16000

    # Convert to int16 PCM
    pcm = (array * 32767).astype(np.int16)

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm.tobytes())
    return tmp.name


def benchmark_librispeech(transcriber, max_samples: int = 0) -> dict:
    """Benchmark on LibriSpeech test-clean (English).

    Uses streaming mode to avoid downloading the full 6GB+ dataset to disk.
    Streams from openslr/librispeech_asr test-clean split (2620 samples).
    """
    from datasets import load_dataset
    from jiwer import wer

    print("Loading LibriSpeech test-clean (streaming)...")
    ds = load_dataset("openslr/librispeech_asr", "clean", split="test", streaming=True)
    total_expected = 2620  # LibriSpeech test-clean has 2620 samples
    total = max_samples if max_samples > 0 else total_expected
    print(f"Evaluating up to {total} samples (streaming)...")

    references = []
    hypotheses = []
    total_audio_ms = 0
    total_proc_ms = 0
    errors = 0
    i = 0

    for sample in ds:
        if i >= total:
            break
        ref_text = normalize_en(sample["text"])

        try:
            wav_path = audio_to_wav_path(sample["audio"])
            result = transcriber.transcribe(wav_path, language="en")
            os.unlink(wav_path)

            hyp_text = normalize_en(" ".join(u.text for u in result.utterances))
            total_audio_ms += result.duration_ms
            total_proc_ms += result.processing_time_ms

            references.append(ref_text)
            hypotheses.append(hyp_text)

        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  Error on sample {i}: {e}")

        i += 1
        if i % 100 == 0:
            interim_wer = wer(references, hypotheses) if references else 0
            print(f"  [{i}/{total}] interim WER: {interim_wer:.4f} ({interim_wer * 100:.2f}%)")

    print(f"  [{i}/{total}] evaluated {len(references)} samples")
    final_wer = wer(references, hypotheses) if references else 1.0
    rtf = total_proc_ms / max(total_audio_ms, 1)

    return {
        "dataset": "LibriSpeech test-clean",
        "language": "en",
        "samples_evaluated": len(references),
        "samples_errored": errors,
        "wer": round(final_wer, 6),
        "wer_pct": round(final_wer * 100, 2),
        "total_audio_sec": round(total_audio_ms / 1000, 1),
        "total_proc_sec": round(total_proc_ms / 1000, 1),
        "avg_rtf": round(rtf, 4),
        "gate_threshold_pct": 5.0,
        "gate_pass": final_wer < 0.05,
    }


def benchmark_aishell1(transcriber, max_samples: int = 0) -> dict:
    """Benchmark on AISHELL-1 test (Chinese)."""
    from datasets import load_dataset
    from jiwer import cer

    print("Loading AISHELL-1 test dataset...")
    # Try the compact test-only version first, fallback to full dataset
    try:
        ds = load_dataset("AudioLLMs/aishell_1_zh_test", split="test")
    except Exception:
        print("  Compact version unavailable, loading full AISHELL-1...")
        ds = load_dataset("AISHELL/AISHELL-1", split="test")

    total = len(ds)
    if max_samples > 0:
        total = min(max_samples, total)
    print(f"Evaluating {total} / {len(ds)} samples...")

    references = []
    hypotheses = []
    total_audio_ms = 0
    total_proc_ms = 0
    errors = 0

    for i in range(total):
        sample = ds[i]
        # AudioLLMs/aishell_1_zh_test uses "answer" field; others use "text"/"sentence"
        ref_raw = sample.get("answer", sample.get("text", sample.get("sentence", "")))
        ref_text = normalize_zh(ref_raw)

        if not ref_text:
            continue

        try:
            # AudioLLMs/aishell_1_zh_test uses "context" for audio; others use "audio"
            audio_data = sample.get("audio", sample.get("context"))
            wav_path = audio_to_wav_path(audio_data)
            result = transcriber.transcribe(wav_path, language="zh")
            os.unlink(wav_path)

            hyp_text = normalize_zh(" ".join(u.text for u in result.utterances))
            total_audio_ms += result.duration_ms
            total_proc_ms += result.processing_time_ms

            references.append(ref_text)
            hypotheses.append(hyp_text)

        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  Error on sample {i}: {e}")

        if (i + 1) % 100 == 0:
            interim_cer = cer(references, hypotheses) if references else 0
            print(f"  [{i + 1}/{total}] interim CER: {interim_cer:.4f} ({interim_cer * 100:.2f}%)")

    final_cer = cer(references, hypotheses) if references else 1.0
    rtf = total_proc_ms / max(total_audio_ms, 1)

    return {
        "dataset": "AISHELL-1 test",
        "language": "zh",
        "metric": "CER (character error rate)",
        "samples_evaluated": len(references),
        "samples_errored": errors,
        "wer": round(final_cer, 6),
        "wer_pct": round(final_cer * 100, 2),
        "total_audio_sec": round(total_audio_ms / 1000, 1),
        "total_proc_sec": round(total_proc_ms / 1000, 1),
        "avg_rtf": round(rtf, 4),
        "gate_threshold_pct": 8.0,
        "gate_pass": final_cer < 0.08,
    }


def main():
    parser = argparse.ArgumentParser(description="GATE 1 WER benchmark")
    parser.add_argument(
        "--lang",
        default="both",
        choices=["en", "zh", "both"],
        help="Which language to benchmark",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=0,
        help="Max samples per dataset (0 = all). Use 50-100 for quick smoke tests.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="",
        help="Save results to JSON file",
    )
    args = parser.parse_args()

    ensure_dependencies()

    print(f"Max samples: {args.max_samples or 'all'}")
    print("=" * 60)

    results = []

    if args.lang in ("en", "both"):
        # English: Moonshine Base ONNX (best edge model for English)
        from app.services.moonshine_onnx import MoonshineOnnxTranscriber

        print("Warming up Moonshine Base ONNX (English)...")
        en_transcriber = MoonshineOnnxTranscriber()
        warmup_path = str(Path(__file__).parent.parent / "samples" / "silence_3s.wav")
        if Path(warmup_path).exists():
            en_transcriber.transcribe(warmup_path)
        print(f"Warmup complete. Backend: {en_transcriber.backend}\n")

        print("=" * 60)
        print("Benchmarking English (LibriSpeech test-clean) — Moonshine Base ONNX")
        print("=" * 60)
        start = time.perf_counter()
        en_result = benchmark_librispeech(en_transcriber, args.max_samples)
        en_result["wall_time_sec"] = round(time.perf_counter() - start, 1)
        en_result["model"] = "Moonshine Base ONNX (INT8)"
        results.append(en_result)
        print(f"\n{json.dumps(en_result, indent=2, ensure_ascii=False)}")

        status = "PASS" if en_result["gate_pass"] else "FAIL"
        print(f"\n{'✓' if en_result['gate_pass'] else '✗'} G1.4 English WER: "
              f"{en_result['wer_pct']}% (threshold: <{en_result['gate_threshold_pct']}%) — {status}")

    if args.lang in ("zh", "both"):
        # Chinese: SenseVoice ONNX (best model for Chinese)
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        print("\nWarming up SenseVoice ONNX (Chinese)...")
        zh_transcriber = SenseVoiceOnnxTranscriber()
        warmup_path = str(Path(__file__).parent.parent / "samples" / "silence_3s.wav")
        if Path(warmup_path).exists():
            zh_transcriber.transcribe(warmup_path, language="zh")
        print(f"Warmup complete. Backend: {zh_transcriber.backend}\n")

        print("=" * 60)
        print("Benchmarking Chinese (AISHELL-1 test) — SenseVoice ONNX")
        print("=" * 60)
        start = time.perf_counter()
        zh_result = benchmark_aishell1(zh_transcriber, args.max_samples)
        zh_result["wall_time_sec"] = round(time.perf_counter() - start, 1)
        zh_result["model"] = "SenseVoice INT8 ONNX"
        results.append(zh_result)
        print(f"\n{json.dumps(zh_result, indent=2, ensure_ascii=False)}")

        status = "PASS" if zh_result["gate_pass"] else "FAIL"
        print(f"\n{'✓' if zh_result['gate_pass'] else '✗'} G1.3 Chinese CER: "
              f"{zh_result['wer_pct']}% (threshold: <{zh_result['gate_threshold_pct']}%) — {status}")

    # Summary
    print("\n" + "=" * 60)
    print("GATE 1 WER SUMMARY")
    print("=" * 60)
    all_pass = all(r["gate_pass"] for r in results)
    for r in results:
        flag = "✓" if r["gate_pass"] else "✗"
        print(f"  {flag} {r['dataset']}: {r['wer_pct']}% (threshold: <{r['gate_threshold_pct']}%)")

    if all_pass:
        print("\n✓ GATE 1 WER conditions: ALL PASS")
    else:
        print("\n✗ GATE 1 WER conditions: FAILED")
        sys.exit(1)

    # Save results
    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"\nResults saved to {args.output}")


if __name__ == "__main__":
    main()
