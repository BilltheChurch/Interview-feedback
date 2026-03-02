"""E2E benchmark: incremental pipeline on real meeting audio.

Supports two audio sources:
  1. AMI Meeting Corpus (streamed from HuggingFace)
  2. Local WAV file (via --audio-file)

Simulates the Worker's 3-minute incremental processing schedule and measures
SenseVoice + pyannote performance.

Metrics:
    - Per-increment: diarization time, ASR time, total time, speakers detected
    - Global: speaker consistency, total processing overhead, finalize time
    - Accuracy: speakers detected vs ground truth, utterance coverage

Requirements:
    Inference service must be running:
        cd inference && uvicorn app.main:app --host 0.0.0.0 --port 8000

    Or run directly against IncrementalProcessor (--mode local).

Usage:
    cd inference

    # Local WAV file (e.g. qingnian test)
    python tests/benchmark_incremental_e2e.py --mode local --audio-file /tmp/qingnian_test.wav --language zh --locale zh-CN --run-analysis

    # AMI corpus (default)
    python tests/benchmark_incremental_e2e.py --mode local --min-duration 3000

    # Against running server
    python tests/benchmark_incremental_e2e.py --mode http --audio-file /tmp/qingnian_test.wav
"""

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ── Helpers ──────────────────────────────────────────────────────────────────


def ensure_dependencies(need_datasets: bool = True):
    required = ["requests"]
    if need_datasets:
        required.extend(["datasets", "soundfile"])
    missing = []
    for pkg in required:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"Missing: {', '.join(missing)}")
        print(f"Install: pip install {' '.join(missing)}")
        sys.exit(1)


def load_local_wav(path: str):
    """Load a local WAV file and return (array, sr, duration_s)."""
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0
    dur_s = len(pcm) / sr
    return pcm, sr, dur_s


def find_long_sample(min_duration_s: float = 3000):
    """Stream AMI dataset and find the longest sample >= min_duration_s."""
    from datasets import load_dataset

    print(f"Streaming AMI corpus (ihm), looking for sample >= {min_duration_s/60:.0f} min...")
    ds = load_dataset("diarizers-community/ami", "ihm", split="train", streaming=True)

    best = None
    best_dur = 0
    checked = 0

    for sample in ds:
        audio = sample.get("audio", {})
        arr = audio.get("array", np.array([]))
        sr = audio.get("sampling_rate", 16000)
        dur_s = len(arr) / sr if sr > 0 else 0
        checked += 1

        if dur_s > best_dur:
            best = sample
            best_dur = dur_s
            print(f"  [{checked}] New longest: {dur_s/60:.1f} min, "
                  f"speakers={len(set(sample.get('speakers', [])))}")

        if dur_s >= min_duration_s:
            print(f"  Found qualifying sample: {dur_s/60:.1f} min")
            break

        if checked >= 50:
            print(f"  Scanned 50 samples, using best: {best_dur/60:.1f} min")
            break

    if best is None:
        print("ERROR: No samples found in AMI dataset")
        sys.exit(1)

    return best, best_dur


def audio_to_wav_bytes(array: np.ndarray, sr: int) -> bytes:
    """Convert float32 array to 16kHz mono WAV bytes."""
    if sr != 16000:
        duration = len(array) / sr
        n_samples = int(duration * 16000)
        indices = np.linspace(0, len(array) - 1, n_samples)
        array = np.interp(indices, np.arange(len(array)), array)

    pcm = (np.clip(array, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def slice_audio(array: np.ndarray, sr: int, start_ms: int, end_ms: int) -> np.ndarray:
    """Slice audio array by millisecond range."""
    start_sample = int(start_ms / 1000 * sr)
    end_sample = int(end_ms / 1000 * sr)
    return array[start_sample:end_sample]


# ── HTTP mode ────────────────────────────────────────────────────────────────


def process_chunk_http(base_url: str, payload: dict) -> dict:
    import requests
    resp = requests.post(f"{base_url}/incremental/process-chunk", json=payload, timeout=300)
    resp.raise_for_status()
    return resp.json()


def finalize_http(base_url: str, payload: dict) -> dict:
    import requests
    resp = requests.post(f"{base_url}/incremental/finalize", json=payload, timeout=300)
    resp.raise_for_status()
    return resp.json()


# ── Local mode ───────────────────────────────────────────────────────────────


def build_local_processor():
    """Build IncrementalProcessor with real models."""
    from app.config import Settings
    from app.runtime import build_runtime
    settings = Settings()
    runtime = build_runtime(settings)
    return runtime.incremental_processor


def process_chunk_local(processor, payload: dict) -> dict:
    from app.schemas import IncrementalProcessRequest
    req = IncrementalProcessRequest(
        session_id=payload["session_id"],
        increment_index=payload["increment_index"],
        audio_b64=payload["audio_b64"],
        audio_start_ms=payload["start_ms"],
        audio_end_ms=payload["end_ms"],
        language=payload.get("language", "en"),
        locale=payload.get("locale", "en-US"),
        run_analysis=payload.get("run_analysis", False),
        previous_speaker_profiles=None,
    )
    result = processor.process_increment(req)
    return result.model_dump()


def finalize_local(processor, payload: dict) -> dict:
    from app.schemas import IncrementalFinalizeRequest
    req = IncrementalFinalizeRequest(
        session_id=payload["session_id"],
        final_audio_b64=payload.get("audio_b64"),
        final_audio_start_ms=payload.get("start_ms", 0),
        final_audio_end_ms=payload.get("end_ms", 0),
        locale=payload.get("locale", "en-US"),
    )
    result = processor.finalize(req)
    return result.model_dump()


# ── Main benchmark ───────────────────────────────────────────────────────────


def run_benchmark(args):
    # 1. Load audio source
    if args.audio_file:
        ensure_dependencies(need_datasets=False)
        print(f"Loading local audio: {args.audio_file}")
        array, sr, total_dur_s = load_local_wav(args.audio_file)
        gt_speakers = set()  # No ground truth for local files
        source_name = Path(args.audio_file).stem
    else:
        ensure_dependencies(need_datasets=True)
        sample, total_dur_s = find_long_sample(args.min_duration)
        audio = sample["audio"]
        array = np.array(audio["array"], dtype=np.float32)
        sr = audio["sampling_rate"]
        gt_speakers = set(sample.get("speakers", []))
        source_name = "AMI-ihm"

    total_dur_ms = int(total_dur_s * 1000)

    print(f"\n{'='*60}")
    print(f"INCREMENTAL PIPELINE E2E BENCHMARK")
    print(f"{'='*60}")
    print(f"Source          : {source_name}")
    print(f"Audio duration  : {total_dur_s/60:.1f} min ({total_dur_ms} ms)")
    print(f"Sample rate     : {sr} Hz")
    if gt_speakers:
        print(f"GT speakers     : {len(gt_speakers)} ({', '.join(sorted(gt_speakers))})")
    else:
        print(f"GT speakers     : N/A (local file)")
    print(f"Language        : {args.language}")
    print(f"Locale          : {args.locale}")
    print(f"Mode            : {args.mode}")
    print(f"Interval        : {args.interval_ms/1000:.0f}s")
    print(f"Overlap         : {args.overlap_ms/1000:.0f}s")
    print(f"Cumul. threshold: {args.cumulative_threshold}")
    print(f"Run LLM analysis: {args.run_analysis}")
    print(f"{'='*60}\n")

    # 2. Setup processor
    processor = None
    base_url = args.base_url
    if args.mode == "local":
        print("Loading models (this may take a moment on first run)...")
        processor = build_local_processor()
        print("Models loaded.\n")

    # 3. Simulate incremental schedule
    session_id = f"bench-{int(time.time())}"
    interval_ms = args.interval_ms
    overlap_ms = args.overlap_ms
    cumulative_threshold = args.cumulative_threshold

    increment_results = []
    last_processed_ms = 0
    increment_index = 0
    total_process_time = 0
    all_speakers_seen = set()

    # Walk through audio in interval_ms steps
    while last_processed_ms + interval_ms <= total_dur_ms:
        end_ms = last_processed_ms + interval_ms

        # Cumulative vs chunk mode
        if increment_index < cumulative_threshold:
            start_ms = 0
        else:
            start_ms = max(0, last_processed_ms - overlap_ms)

        # Slice and encode audio
        chunk_array = slice_audio(array, sr, start_ms, end_ms)
        wav_bytes = audio_to_wav_bytes(chunk_array, sr)
        audio_b64 = base64.b64encode(wav_bytes).decode()

        mode_str = "CUMUL" if increment_index < cumulative_threshold else "CHUNK"
        print(f"Increment {increment_index:2d} [{mode_str}] "
              f"{start_ms/1000:6.0f}s → {end_ms/1000:6.0f}s "
              f"({(end_ms-start_ms)/1000:.0f}s audio) ... ", end="", flush=True)

        payload = {
            "session_id": session_id,
            "increment_index": increment_index,
            "audio_b64": audio_b64,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "language": args.language,
            "locale": args.locale,
            "run_analysis": args.run_analysis,
            "speaker_profiles": [],
            "memos": [],
            "stats": [],
        }

        t0 = time.time()
        try:
            if args.mode == "http":
                result = process_chunk_http(base_url, payload)
            else:
                result = process_chunk_local(processor, payload)
            elapsed = time.time() - t0
            total_process_time += elapsed

            n_speakers = result.get("speakers_detected", 0)
            n_utterances = len(result.get("utterances", []))
            diar_ms = result.get("diarization_time_ms", 0)
            asr_ms = result.get("transcription_time_ms", 0)
            stable = result.get("stable_speaker_map", False)

            # Track speakers (MergedUtteranceOut uses "speaker" field)
            for u in result.get("utterances", []):
                spk = u.get("speaker") or u.get("speaker_name") or u.get("cluster_id")
                if spk and spk != "_unknown":
                    all_speakers_seen.add(spk)

            print(f"{elapsed:5.1f}s  "
                  f"diar={diar_ms/1000:.1f}s  asr={asr_ms/1000:.1f}s  "
                  f"spk={n_speakers}  utt={n_utterances}  "
                  f"stable={'✓' if stable else '·'}")

            increment_results.append({
                "index": increment_index,
                "mode": mode_str,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "elapsed_s": round(elapsed, 2),
                "diarization_ms": diar_ms,
                "transcription_ms": asr_ms,
                "speakers_detected": n_speakers,
                "utterances": n_utterances,
                "stable": stable,
            })

        except Exception as e:
            elapsed = time.time() - t0
            print(f"FAILED ({elapsed:.1f}s): {e}")
            increment_results.append({
                "index": increment_index,
                "mode": mode_str,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "elapsed_s": round(elapsed, 2),
                "error": str(e),
            })

        last_processed_ms = end_ms
        increment_index += 1

    # 4. Finalize — process remaining audio
    remaining_ms = total_dur_ms - last_processed_ms
    print(f"\n{'─'*60}")
    print(f"FINALIZE: {remaining_ms/1000:.0f}s remaining audio")
    print(f"{'─'*60}")

    finalize_payload = {"session_id": session_id, "locale": args.locale}
    if remaining_ms > 5000:
        final_start = max(0, last_processed_ms - overlap_ms)
        final_chunk = slice_audio(array, sr, final_start, total_dur_ms)
        final_wav = audio_to_wav_bytes(final_chunk, sr)
        finalize_payload["audio_b64"] = base64.b64encode(final_wav).decode()
        finalize_payload["start_ms"] = final_start
        finalize_payload["end_ms"] = total_dur_ms
        print(f"  Final audio: {final_start/1000:.0f}s → {total_dur_ms/1000:.0f}s")
    else:
        print(f"  No significant remaining audio ({remaining_ms}ms < 5s)")

    t0 = time.time()
    try:
        if args.mode == "http":
            fin_result = finalize_http(base_url, finalize_payload)
        else:
            fin_result = finalize_local(processor, finalize_payload)
        finalize_time = time.time() - t0

        fin_utterances = len(fin_result.get("transcript", []))
        fin_increments = fin_result.get("total_increments", 0)
        fin_audio_ms = fin_result.get("total_audio_ms", 0)
        has_report = fin_result.get("report") is not None

        # Count speakers after finalize merge
        fin_speakers = set()
        for u in fin_result.get("transcript", []):
            spk = u.get("speaker")
            if spk and spk != "_unknown":
                fin_speakers.add(spk)

        print(f"  Finalize time : {finalize_time:.1f}s")
        print(f"  Utterances    : {fin_utterances}")
        print(f"  Increments    : {fin_increments}")
        print(f"  Total audio   : {fin_audio_ms/1000:.0f}s")
        print(f"  Report        : {'✓' if has_report else '✗ (no LLM analysis run)'}")
        print(f"  Post-merge spk: {len(fin_speakers)} ({', '.join(sorted(fin_speakers))})")

    except Exception as e:
        finalize_time = time.time() - t0
        fin_result = None
        fin_speakers = set()
        print(f"  FAILED ({finalize_time:.1f}s): {e}")

    # 5. Summary
    print(f"\n{'='*60}")
    print(f"RESULTS SUMMARY")
    print(f"{'='*60}")

    successful = [r for r in increment_results if "error" not in r]
    failed = [r for r in increment_results if "error" in r]

    avg_time = np.mean([r["elapsed_s"] for r in successful]) if successful else 0
    max_time = max([r["elapsed_s"] for r in successful]) if successful else 0
    avg_diar = np.mean([r["diarization_ms"] for r in successful]) / 1000 if successful else 0
    avg_asr = np.mean([r["transcription_ms"] for r in successful]) / 1000 if successful else 0

    # Post-merge speaker count from finalize transcript
    final_speaker_count = len(fin_speakers) if fin_result and fin_speakers else len(all_speakers_seen)

    print(f"Source             : {source_name}")
    print(f"Audio duration     : {total_dur_s/60:.1f} min")
    if gt_speakers:
        print(f"GT speakers        : {len(gt_speakers)}")
    print(f"Pre-merge speakers : {len(all_speakers_seen)}")
    print(f"Post-merge speakers: {final_speaker_count}")
    if gt_speakers:
        print(f"Speaker match      : {'✓ PASS' if final_speaker_count == len(gt_speakers) else '✗ FAIL (expected %d, got %d)' % (len(gt_speakers), final_speaker_count)}")
    else:
        print(f"Speaker detection   : {final_speaker_count} speakers identified")
    print(f"Increments total   : {len(increment_results)} ({len(successful)} ok, {len(failed)} failed)")
    print(f"Avg increment time : {avg_time:.1f}s")
    print(f"Max increment time : {max_time:.1f}s")
    print(f"Avg diarization    : {avg_diar:.1f}s")
    print(f"Avg ASR            : {avg_asr:.1f}s")
    print(f"Total process time : {total_process_time:.1f}s")
    print(f"Finalize time      : {finalize_time:.1f}s")
    print(f"Processing RTF     : {total_process_time / total_dur_s:.3f}")
    print(f"Post-session wait  : {finalize_time:.1f}s (target < 30s)")
    print(f"{'='*60}")

    # 6. Save results
    output = {
        "audio_duration_s": round(total_dur_s, 1),
        "gt_speakers": len(gt_speakers),
        "pre_merge_speakers": len(all_speakers_seen),
        "post_merge_speakers": final_speaker_count,
        "mode": args.mode,
        "interval_ms": args.interval_ms,
        "overlap_ms": args.overlap_ms,
        "increments": increment_results,
        "finalize_time_s": round(finalize_time, 2),
        "total_process_time_s": round(total_process_time, 2),
        "processing_rtf": round(total_process_time / total_dur_s, 4),
    }

    out_path = Path(__file__).parent / "benchmark_incremental_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    # 7. Save full transcript if finalize succeeded
    if fin_result and fin_result.get("transcript"):
        transcript_path = Path(__file__).parent / "benchmark_incremental_transcript.json"
        with open(transcript_path, "w") as f:
            json.dump(fin_result["transcript"], f, indent=2, ensure_ascii=False)
        print(f"Transcript saved to: {transcript_path}")

        # Also save a human-readable version
        txt_path = Path(__file__).parent / "benchmark_incremental_transcript.txt"
        with open(txt_path, "w") as f:
            f.write(f"{source_name} — Incremental Pipeline Transcript\n")
            f.write(f"Audio: {total_dur_s/60:.1f} min | Speakers: {final_speaker_count} | Utterances: {len(fin_result['transcript'])}\n")
            f.write(f"{'='*80}\n\n")
            for utt in fin_result["transcript"]:
                start_s = utt.get("start_ms", 0) / 1000
                end_s = utt.get("end_ms", 0) / 1000
                spk = utt.get("speaker", "?")
                text = utt.get("text", "")
                mm_ss_start = f"{int(start_s//60):02d}:{start_s%60:05.2f}"
                mm_ss_end = f"{int(end_s//60):02d}:{end_s%60:05.2f}"
                f.write(f"[{mm_ss_start} → {mm_ss_end}] {spk}: {text}\n")
        print(f"Readable transcript saved to: {txt_path}")

    # 8. Save LLM report if generated
    if fin_result and fin_result.get("report"):
        report_path = Path(__file__).parent / "benchmark_incremental_report.json"
        with open(report_path, "w") as f:
            json.dump(fin_result["report"], f, indent=2, ensure_ascii=False)
        print(f"LLM report saved to: {report_path}")

    print(f"\nResults saved to: {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Incremental pipeline E2E benchmark")
    parser.add_argument("--mode", choices=["http", "local"], default="local",
                        help="http = against running server, local = direct processor")
    parser.add_argument("--base-url", default="http://localhost:8000",
                        help="Inference server URL (http mode)")
    parser.add_argument("--audio-file", type=str, default=None,
                        help="Path to local WAV file (skips AMI corpus download)")
    parser.add_argument("--language", type=str, default="en",
                        help="Language code (default: en)")
    parser.add_argument("--locale", type=str, default="en-US",
                        help="Locale code (default: en-US)")
    parser.add_argument("--min-duration", type=float, default=3000,
                        help="Minimum sample duration in seconds (default: 3000 = 50min)")
    parser.add_argument("--interval-ms", type=int, default=180_000,
                        help="Incremental interval in ms (default: 180000 = 3min)")
    parser.add_argument("--overlap-ms", type=int, default=30_000,
                        help="Overlap between chunks in ms (default: 30000 = 30s)")
    parser.add_argument("--cumulative-threshold", type=int, default=2,
                        help="Number of cumulative increments (default: 2)")
    parser.add_argument("--run-analysis", action="store_true", default=False,
                        help="Enable LLM checkpoint analysis during increments")
    args = parser.parse_args()
    run_benchmark(args)


if __name__ == "__main__":
    main()
