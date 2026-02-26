"""ASR benchmark: compares SenseVoice vs Whisper on the same audio.

Usage:
    python tests/benchmark_asr.py --audio samples/10min_interview_16k.wav
    python tests/benchmark_asr.py --audio samples/short_3s_zh.wav --engine sensevoice
    python tests/benchmark_asr.py --audio samples/short_3s_en.wav --engine whisper
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.device import detect_device


def benchmark_sensevoice(audio_path: str) -> dict:
    from app.services.sensevoice_transcriber import SenseVoiceTranscriber
    t = SenseVoiceTranscriber()
    start = time.perf_counter()
    result = t.transcribe(audio_path)
    wall_time_ms = int((time.perf_counter() - start) * 1000)
    return {
        "engine": "sensevoice",
        "backend": result.backend,
        "model": result.model_size,
        "device": t.device,
        "duration_ms": result.duration_ms,
        "processing_time_ms": result.processing_time_ms,
        "wall_time_ms": wall_time_ms,
        "rtf": round(wall_time_ms / max(result.duration_ms, 1), 4),
        "utterance_count": len(result.utterances),
        "total_chars": sum(len(u.text) for u in result.utterances),
        "language": result.language,
    }


def benchmark_whisper(audio_path: str) -> dict:
    from app.services.whisper_batch import WhisperBatchTranscriber
    t = WhisperBatchTranscriber()
    start = time.perf_counter()
    result = t.transcribe(audio_path)
    wall_time_ms = int((time.perf_counter() - start) * 1000)
    return {
        "engine": "whisper",
        "backend": result.backend,
        "model": result.model_size,
        "device": t.device,
        "duration_ms": result.duration_ms,
        "processing_time_ms": result.processing_time_ms,
        "wall_time_ms": wall_time_ms,
        "rtf": round(wall_time_ms / max(result.duration_ms, 1), 4),
        "utterance_count": len(result.utterances),
        "total_chars": sum(len(u.text) for u in result.utterances),
        "language": result.language,
    }


def main():
    parser = argparse.ArgumentParser(description="ASR benchmark")
    parser.add_argument("--audio", required=True, help="Path to test audio (WAV, 16kHz mono)")
    parser.add_argument("--engine", default="both", choices=["sensevoice", "whisper", "both"])
    args = parser.parse_args()

    print(f"Device: {detect_device()}")
    print(f"Audio: {args.audio}")
    print("=" * 60)

    results = []

    if args.engine in ("sensevoice", "both"):
        print("\n--- SenseVoice ---")
        r = benchmark_sensevoice(args.audio)
        results.append(r)
        print(json.dumps(r, indent=2, ensure_ascii=False))

    if args.engine in ("whisper", "both"):
        print("\n--- Whisper ---")
        r = benchmark_whisper(args.audio)
        results.append(r)
        print(json.dumps(r, indent=2, ensure_ascii=False))

    if len(results) == 2:
        sv, wh = results
        print("\n--- Comparison ---")
        print(f"SenseVoice RTF: {sv['rtf']} | Whisper RTF: {wh['rtf']}")
        speedup = round(wh['wall_time_ms'] / max(sv['wall_time_ms'], 1), 1)
        print(f"SenseVoice is {speedup}x faster than Whisper")

    # GATE 1 check
    for r in results:
        if r["engine"] == "sensevoice":
            if r["rtf"] >= 0.1:
                print(f"\n❌ GATE 1 FAIL: SenseVoice RTF {r['rtf']} >= 0.1")
                sys.exit(1)
            else:
                print(f"\n✓ GATE 1.2 PASS: SenseVoice RTF {r['rtf']} < 0.1")


if __name__ == "__main__":
    main()
