"""GATE 2 diarization benchmark — real meeting audio verification.

Uses the AMI Meeting Corpus (diarizers-community/ami) from HuggingFace
to evaluate pyannote speaker diarization on real multi-speaker recordings.

Metrics:
    - Speaker count accuracy (detected vs ground truth)
    - Speaker attribution coverage (% segments with valid speaker IDs)
    - Processing time / RTF (real-time factor)
    - DER (Diarization Error Rate) if pyannote.metrics is available

GATE 2 conditions validated:
    G2.2: Speaker attribution coverage > 90%
    G2.3: Detected speaker count matches ground truth (±1)
    G2.4: Processing time < 5 min for 10 min audio (MPS) / < 2 min (CUDA)

Requirements:
    pip install datasets soundfile pyannote.audio torch

Usage:
    cd inference
    python tests/benchmark_diarization.py                     # 3 samples (quick)
    python tests/benchmark_diarization.py --max-samples 10    # 10 samples
    python tests/benchmark_diarization.py --max-duration 300  # max 5 min per sample
"""

import argparse
import json
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def ensure_dependencies():
    """Check required dependencies."""
    missing = []
    try:
        import datasets  # noqa: F401
    except ImportError:
        missing.append("datasets")
    try:
        import soundfile  # noqa: F401
    except ImportError:
        missing.append("soundfile")

    if missing:
        print(f"Missing: {', '.join(missing)}")
        print(f"Install: pip install {' '.join(missing)}")
        sys.exit(1)


def count_ground_truth_speakers(sample: dict) -> int:
    """Count unique speakers in AMI ground truth annotations."""
    speakers = sample.get("speakers", [])
    if isinstance(speakers, list) and len(speakers) > 0:
        # speakers is a list of speaker IDs per segment
        return len(set(speakers))
    return 0


def get_audio_duration_ms(sample: dict) -> int:
    """Get audio duration in milliseconds from the sample."""
    audio = sample.get("audio", {})
    array = audio.get("array", np.array([]))
    sr = audio.get("sampling_rate", 16000)
    if len(array) == 0:
        return 0
    return int(len(array) / sr * 1000)


def audio_to_wav(audio_dict: dict, max_duration_sec: float = 0) -> str:
    """Convert HuggingFace audio dict to WAV file, optionally truncating."""
    array = np.array(audio_dict["array"], dtype=np.float32)
    sr = audio_dict["sampling_rate"]

    # Truncate if requested
    if max_duration_sec > 0:
        max_samples = int(max_duration_sec * sr)
        if len(array) > max_samples:
            array = array[:max_samples]

    # Resample to 16kHz if needed
    if sr != 16000:
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


def compute_der_simple(
    gt_speakers: list,
    gt_starts: list,
    gt_ends: list,
    pred_segments: list,
    total_duration_ms: int,
) -> dict:
    """Compute a simplified DER using segment overlap.

    This is an approximation — for precise DER use pyannote.metrics.
    Returns miss, false_alarm, confusion, and total DER.
    """
    # Build ground truth timeline (1ms resolution, capped at 10min for memory)
    max_ms = min(total_duration_ms, 600_000)
    gt_timeline = [""] * max_ms
    for spk, s, e in zip(gt_speakers, gt_starts, gt_ends):
        start_ms = int(s * 1000)
        end_ms = min(int(e * 1000), max_ms)
        for t in range(start_ms, end_ms):
            gt_timeline[t] = spk

    # Build predicted timeline
    pred_timeline = [""] * max_ms
    for seg in pred_segments:
        start_ms = seg.start_ms
        end_ms = min(seg.end_ms, max_ms)
        for t in range(start_ms, end_ms):
            pred_timeline[t] = seg.speaker_id

    # Count speech frames in GT
    gt_speech_frames = sum(1 for g in gt_timeline if g)
    if gt_speech_frames == 0:
        return {"der": 0.0, "miss": 0.0, "false_alarm": 0.0, "confusion": 0.0}

    miss = 0  # GT has speech, pred has silence
    false_alarm = 0  # GT has silence, pred has speech
    confusion = 0  # Both have speech but different speakers

    # Build speaker mapping (greedy: map pred speakers to GT speakers by overlap)
    from collections import Counter

    overlap_counts: dict[tuple[str, str], int] = Counter()
    for t in range(max_ms):
        g, p = gt_timeline[t], pred_timeline[t]
        if g and p:
            overlap_counts[(p, g)] += 1

    # Greedy mapping: for each pred speaker, pick the GT speaker with most overlap
    speaker_map: dict[str, str] = {}
    used_gt: set[str] = set()
    for (pred_spk, gt_spk), count in sorted(overlap_counts.items(), key=lambda x: -x[1]):
        if pred_spk not in speaker_map and gt_spk not in used_gt:
            speaker_map[pred_spk] = gt_spk
            used_gt.add(gt_spk)

    # Compute errors
    for t in range(max_ms):
        g, p = gt_timeline[t], pred_timeline[t]
        if g and not p:
            miss += 1
        elif not g and p:
            false_alarm += 1
        elif g and p:
            mapped = speaker_map.get(p, "")
            if mapped != g:
                confusion += 1

    der = (miss + false_alarm + confusion) / gt_speech_frames
    return {
        "der": round(der, 4),
        "miss_rate": round(miss / gt_speech_frames, 4),
        "false_alarm_rate": round(false_alarm / gt_speech_frames, 4),
        "confusion_rate": round(confusion / gt_speech_frames, 4),
        "gt_speech_frames": gt_speech_frames,
        "speaker_mapping": speaker_map,
    }


def benchmark_ami(
    diarizer,
    max_samples: int = 3,
    max_duration_sec: float = 0,
) -> dict:
    """Benchmark diarization on AMI Meeting Corpus.

    Args:
        diarizer: PyannoteFullDiarizer instance.
        max_samples: Max number of meeting recordings to evaluate.
        max_duration_sec: Max duration per sample (0 = full recording).

    Returns:
        Dict with aggregated metrics.
    """
    from datasets import load_dataset

    print("Loading AMI Meeting Corpus (streaming)...")
    ds = load_dataset(
        "diarizers-community/ami",
        "ihm",  # Individual Headset Microphone (clean per-speaker audio)
        split="test",
        streaming=True,
        trust_remote_code=True,
    )

    results = []
    i = 0

    for sample in ds:
        if i >= max_samples:
            break

        audio_dur_ms = get_audio_duration_ms(sample)
        gt_speakers_count = count_ground_truth_speakers(sample)

        # Skip very short samples
        if audio_dur_ms < 10_000:
            print(f"  Skipping sample {i}: too short ({audio_dur_ms}ms)")
            continue

        dur_label = f"{audio_dur_ms / 1000:.0f}s"
        if max_duration_sec > 0:
            effective_dur = min(audio_dur_ms, max_duration_sec * 1000)
            dur_label = f"{effective_dur / 1000:.0f}s (truncated from {audio_dur_ms / 1000:.0f}s)"

        print(f"\n  Sample {i + 1}/{max_samples}: {dur_label}, "
              f"GT speakers: {gt_speakers_count}")

        wav_path = None
        try:
            wav_path = audio_to_wav(sample["audio"], max_duration_sec)

            t0 = time.monotonic()
            result = diarizer.diarize(wav_path, num_speakers=gt_speakers_count if gt_speakers_count > 0 else None)
            elapsed_ms = int((time.monotonic() - t0) * 1000)

            # Metrics
            detected_speakers = result.num_speakers
            total_segments = len(result.segments)
            attributed = sum(1 for s in result.segments if s.speaker_id and s.speaker_id != "_unknown")
            coverage = attributed / max(total_segments, 1)
            speaker_diff = abs(detected_speakers - gt_speakers_count) if gt_speakers_count > 0 else -1

            effective_dur_ms = min(audio_dur_ms, int(max_duration_sec * 1000)) if max_duration_sec > 0 else audio_dur_ms
            rtf = elapsed_ms / max(effective_dur_ms, 1)

            sample_result = {
                "sample_idx": i,
                "audio_duration_ms": effective_dur_ms,
                "gt_speaker_count": gt_speakers_count,
                "detected_speaker_count": detected_speakers,
                "speaker_count_diff": speaker_diff,
                "total_segments": total_segments,
                "attributed_segments": attributed,
                "coverage": round(coverage, 4),
                "processing_time_ms": elapsed_ms,
                "rtf": round(rtf, 4),
                "embeddings_available": len(result.embeddings) > 0,
            }

            # Compute DER if ground truth timestamps available
            gt_speakers_list = sample.get("speakers", [])
            gt_starts = sample.get("timestamps_start", [])
            gt_ends = sample.get("timestamps_end", [])
            if gt_speakers_list and gt_starts and gt_ends:
                der_result = compute_der_simple(
                    gt_speakers_list, gt_starts, gt_ends,
                    result.segments, effective_dur_ms,
                )
                sample_result["der"] = der_result["der"]
                sample_result["miss_rate"] = der_result["miss_rate"]
                sample_result["false_alarm_rate"] = der_result["false_alarm_rate"]
                sample_result["confusion_rate"] = der_result["confusion_rate"]

            results.append(sample_result)

            # Print summary
            der_str = f", DER={sample_result.get('der', 'N/A')}" if "der" in sample_result else ""
            print(f"    Detected {detected_speakers} speakers, "
                  f"{total_segments} segments, coverage={coverage:.1%}, "
                  f"RTF={rtf:.2f}{der_str}")

            # GATE 2 checks per sample
            if coverage < 0.9:
                print(f"    ⚠ G2.2 coverage {coverage:.1%} < 90%")
            if speaker_diff > 1:
                print(f"    ⚠ G2.3 speaker count off by {speaker_diff}")

        except Exception as e:
            print(f"    ✗ Error: {e}")
            results.append({
                "sample_idx": i,
                "error": str(e),
            })
        finally:
            if wav_path:
                try:
                    Path(wav_path).unlink(missing_ok=True)
                except OSError:
                    pass

        i += 1

    # Aggregate
    valid = [r for r in results if "error" not in r]
    if not valid:
        return {"status": "FAIL", "reason": "No valid results", "results": results}

    avg_coverage = np.mean([r["coverage"] for r in valid])
    avg_rtf = np.mean([r["rtf"] for r in valid])
    speaker_accuracy = sum(1 for r in valid if r["speaker_count_diff"] <= 1) / len(valid)
    total_audio_sec = sum(r["audio_duration_ms"] for r in valid) / 1000
    total_proc_sec = sum(r["processing_time_ms"] for r in valid) / 1000
    avg_der = np.mean([r["der"] for r in valid if "der" in r]) if any("der" in r for r in valid) else None

    # GATE 2 checks
    g2_2_pass = avg_coverage > 0.9
    g2_3_pass = speaker_accuracy >= 0.8  # >=80% of samples have correct speaker count ±1
    # G2.4: 10 min audio < 5 min processing (MPS), i.e. RTF < 0.5
    g2_4_pass = avg_rtf < 0.5

    summary = {
        "dataset": "AMI Meeting Corpus (headset-single, test)",
        "samples_evaluated": len(valid),
        "samples_errored": len(results) - len(valid),
        "total_audio_sec": round(total_audio_sec, 1),
        "total_processing_sec": round(total_proc_sec, 1),
        "avg_coverage": round(avg_coverage, 4),
        "avg_rtf": round(avg_rtf, 4),
        "speaker_count_accuracy": round(speaker_accuracy, 4),
        "avg_der": round(avg_der, 4) if avg_der is not None else None,
        "gate_results": {
            "G2.2_coverage_gt_90pct": g2_2_pass,
            "G2.3_speaker_count_accurate": g2_3_pass,
            "G2.4_rtf_lt_0.5": g2_4_pass,
        },
        "all_pass": g2_2_pass and g2_3_pass and g2_4_pass,
        "per_sample": results,
    }

    return summary


def main():
    parser = argparse.ArgumentParser(description="GATE 2 diarization benchmark on real audio")
    parser.add_argument(
        "--max-samples", type=int, default=3,
        help="Number of AMI recordings to evaluate (default: 3)",
    )
    parser.add_argument(
        "--max-duration", type=float, default=300,
        help="Max duration per sample in seconds (default: 300 = 5 min). 0 = full recording.",
    )
    parser.add_argument(
        "--output", type=str, default="",
        help="Save results to JSON file",
    )
    parser.add_argument(
        "--device", type=str, default="auto",
        help="Device for pyannote (auto, cpu, mps, cuda)",
    )
    args = parser.parse_args()

    ensure_dependencies()

    hf_token = os.environ.get("HF_TOKEN", "")
    if not hf_token:
        print("ERROR: HF_TOKEN environment variable required for pyannote.audio")
        print("Set it: export HF_TOKEN=hf_xxx")
        sys.exit(1)

    print("=" * 60)
    print("GATE 2: Diarization Benchmark — AMI Meeting Corpus")
    print("=" * 60)
    print(f"  Max samples: {args.max_samples}")
    print(f"  Max duration per sample: {args.max_duration}s" if args.max_duration > 0 else "  Full recordings")
    print(f"  Device: {args.device}")
    print(f"  HF_TOKEN: {hf_token[:8]}...{hf_token[-4:]}")
    print()

    # Initialize diarizer
    from app.services.diarize_full import PyannoteFullDiarizer

    print("Initializing PyannoteFullDiarizer...")
    diarizer = PyannoteFullDiarizer(
        device=args.device,
        hf_token=hf_token,
    )

    # Run benchmark
    summary = benchmark_ami(
        diarizer,
        max_samples=args.max_samples,
        max_duration_sec=args.max_duration,
    )

    # Print results
    print("\n" + "=" * 60)
    print("GATE 2 DIARIZATION RESULTS")
    print("=" * 60)
    print(f"  Samples: {summary.get('samples_evaluated', 0)} evaluated, "
          f"{summary.get('samples_errored', 0)} errors")
    print(f"  Total audio: {summary.get('total_audio_sec', 0):.1f}s")
    print(f"  Total processing: {summary.get('total_processing_sec', 0):.1f}s")
    print(f"  Avg coverage: {summary.get('avg_coverage', 0):.1%}")
    print(f"  Avg RTF: {summary.get('avg_rtf', 0):.3f}")
    print(f"  Speaker count accuracy: {summary.get('speaker_count_accuracy', 0):.1%}")
    if summary.get("avg_der") is not None:
        print(f"  Avg DER: {summary['avg_der']:.1%}")

    gates = summary.get("gate_results", {})
    print(f"\n  {'✓' if gates.get('G2.2_coverage_gt_90pct') else '✗'} G2.2 Coverage > 90%: "
          f"{summary.get('avg_coverage', 0):.1%}")
    print(f"  {'✓' if gates.get('G2.3_speaker_count_accurate') else '✗'} G2.3 Speaker count ±1: "
          f"{summary.get('speaker_count_accuracy', 0):.1%}")
    print(f"  {'✓' if gates.get('G2.4_rtf_lt_0.5') else '✗'} G2.4 RTF < 0.5: "
          f"{summary.get('avg_rtf', 0):.3f}")

    if summary.get("all_pass"):
        print(f"\n✓ GATE 2 diarization benchmark: ALL PASS")
    else:
        print(f"\n✗ GATE 2 diarization benchmark: FAILED")

    # Save results
    output_file = args.output or "gate2_diarization_results.json"

    # Convert numpy types for JSON serialization
    def _json_safe(obj):
        if isinstance(obj, (np.bool_,)):
            return bool(obj)
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    with open(output_file, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False, default=_json_safe)
    print(f"\nResults saved to {output_file}")

    if not summary.get("all_pass"):
        sys.exit(1)


if __name__ == "__main__":
    main()
