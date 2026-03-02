"""V1 Pipeline Smoke Test — validates full HTTP flow on macOS.

Usage:
    # Terminal 1: start inference
    cd inference && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

    # Terminal 2: run smoke test
    cd inference && .venv/bin/python tests/smoke_v1_pipeline.py

Validates:
    1. V1 process-chunk writes to Redis
    2. Idempotency rejects duplicate increment_id
    3. V1 finalize reads from Redis (merge-only)
    4. Recompute low-confidence utterances
    5. Recompute metrics in response
    6. Redis cleanup after finalize
"""
import base64
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load .env from inference directory
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_URL = "http://localhost:8000"
API_KEY = os.environ.get("INFERENCE_API_KEY", "")
HEADERS = {"x-api-key": API_KEY}
SESSION_ID = f"smoke-v1-{int(time.time())}"


REAL_AUDIO_PATH = "/tmp/qingnian_test.wav"


def make_wav_b64(duration_s: float = 3.0, sr: int = 16000) -> str:
    """Generate silent WAV encoded as base64."""
    buf = io.BytesIO()
    n_samples = int(duration_s * sr)
    pcm = b"\x00\x00" * n_samples
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def slice_real_audio_b64(start_ms: int, end_ms: int) -> str:
    """Slice real audio from REAL_AUDIO_PATH and return base64 WAV."""
    import numpy as np
    with wave.open(REAL_AUDIO_PATH, "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16)
    start_sample = int(start_ms / 1000 * sr)
    end_sample = int(end_ms / 1000 * sr)
    chunk = pcm[start_sample:end_sample]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(chunk.tobytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


def check(label: str, ok: bool, detail: str = ""):
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        return False
    return True


def main():
    all_pass = True

    # 0. Health check
    print("=" * 60)
    print("V1 PIPELINE SMOKE TEST")
    print("=" * 60)
    print(f"Session: {SESSION_ID}\n")

    print("Step 0: Health check")
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=5)  # health skips auth
        all_pass &= check("Inference service reachable", r.status_code == 200)
    except Exception as e:
        print(f"  [FAIL] Cannot reach {BASE_URL}: {e}")
        print("\n  Start inference first:")
        print("    cd inference && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000")
        sys.exit(1)

    # Check real audio exists
    if not Path(REAL_AUDIO_PATH).exists():
        print(f"  [FAIL] Real audio not found: {REAL_AUDIO_PATH}")
        sys.exit(1)

    # 1. Process-chunk increment 0 (first 60s of real audio — enough for speech)
    print("\nStep 1: V1 process-chunk (increment 0, 0-60s real audio)")
    audio_b64 = slice_real_audio_b64(0, 60_000)
    payload = {
        "v": 1,
        "session_id": SESSION_ID,
        "increment_id": f"{SESSION_ID}-inc-0",
        "increment_index": 0,
        "audio_b64": audio_b64,
        "audio_start_ms": 0,
        "audio_end_ms": 60000,
        "language": "en",
        "run_analysis": False,
        "locale": "en-US",
    }

    t0 = time.time()
    r = requests.post(f"{BASE_URL}/v1/incremental/process-chunk", json=payload, headers=HEADERS, timeout=120)
    elapsed = time.time() - t0

    all_pass &= check("HTTP 200", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        all_pass &= check("Response has v=1", data.get("v") == 1)
        all_pass &= check("Has utterances list", isinstance(data.get("utterances"), list))
        all_pass &= check("Has metrics", "processing_ms" in data.get("metrics", {}))
        all_pass &= check("was_written=True", data.get("metrics", {}).get("was_written") is True)
        print(f"  Time: {elapsed:.1f}s, speakers={data.get('speakers_detected')}, utt={len(data.get('utterances', []))}")
    elif r.status_code == 404:
        print(f"  [FAIL] V1 not enabled — check INCREMENTAL_V1_ENABLED=true in .env")
        sys.exit(1)
    elif r.status_code == 503:
        print(f"  [FAIL] Redis unavailable — check redis-cli ping")
        sys.exit(1)
    else:
        print(f"  Response: {r.text[:500]}")

    # 2. Idempotency test — same increment_id should be rejected
    print("\nStep 2: Idempotency (duplicate increment_id)")
    r2 = requests.post(f"{BASE_URL}/v1/incremental/process-chunk", json=payload, headers=HEADERS, timeout=30)
    all_pass &= check("HTTP 200 (cached)", r2.status_code == 200)
    if r2.status_code == 200:
        data2 = r2.json()
        all_pass &= check("idempotent_reject=True", data2.get("metrics", {}).get("idempotent_reject") is True)

    # 3. Process-chunk increment 1 (60-120s)
    print("\nStep 3: V1 process-chunk (increment 1, 60-120s real audio)")
    payload2 = {
        "v": 1,
        "session_id": SESSION_ID,
        "increment_id": f"{SESSION_ID}-inc-1",
        "increment_index": 1,
        "audio_b64": slice_real_audio_b64(60_000, 120_000),
        "audio_start_ms": 60000,
        "audio_end_ms": 120000,
        "language": "en",
        "run_analysis": False,
        "locale": "en-US",
    }
    t0 = time.time()
    r3 = requests.post(f"{BASE_URL}/v1/incremental/process-chunk", json=payload2, headers=HEADERS, timeout=120)
    elapsed = time.time() - t0
    all_pass &= check("HTTP 200", r3.status_code == 200, f"got {r3.status_code}")
    if r3.status_code == 200:
        data3 = r3.json()
        all_pass &= check("was_written=True", data3.get("metrics", {}).get("was_written") is True)
        print(f"  Time: {elapsed:.1f}s, speakers={data3.get('speakers_detected')}, utt={len(data3.get('utterances', []))}")

    # 4. Redis state check
    print("\nStep 4: Redis state verification")
    try:
        import redis
        rc = redis.Redis.from_url("redis://localhost:6379/0", decode_responses=True)
        meta_key = f"session:{SESSION_ID}:meta"
        meta = rc.hgetall(meta_key)
        all_pass &= check("Redis meta exists", bool(meta), f"keys={list(meta.keys())}")
        all_pass &= check("last_increment >= 1", int(meta.get("last_increment", -1)) >= 1)
    except Exception as e:
        all_pass &= check("Redis check", False, str(e))

    # 5. Finalize with recompute segment
    print("\nStep 5: V1 finalize (merge-only + recompute)")
    recompute_audio = slice_real_audio_b64(0, 10_000)  # First 10s of real audio
    finalize_payload = {
        "v": 1,
        "session_id": SESSION_ID,
        "total_audio_ms": 120000,
        "locale": "en-US",
        "recompute_segments": [{
            "utterance_id": "nonexistent-id",  # Will test coord fallback or skip
            "increment_index": 0,
            "start_ms": 0,
            "end_ms": 10000,
            "original_confidence": 0.3,
            "stream_role": "mixed",
            "audio_b64": recompute_audio,
            "audio_format": "wav",
        }],
    }

    t0 = time.time()
    r4 = requests.post(f"{BASE_URL}/v1/incremental/finalize", json=finalize_payload, headers=HEADERS, timeout=300)
    elapsed = time.time() - t0
    all_pass &= check("HTTP 200", r4.status_code == 200, f"got {r4.status_code}")

    if r4.status_code == 200:
        fin = r4.json()
        all_pass &= check("Response has v=1", fin.get("v") == 1)
        all_pass &= check("Has transcript", isinstance(fin.get("transcript"), list))
        all_pass &= check("Has speaker_stats", isinstance(fin.get("speaker_stats"), list))
        all_pass &= check("total_increments >= 2", fin.get("total_increments", 0) >= 2)

        metrics = fin.get("metrics", {})
        all_pass &= check("Has recompute_requested", "recompute_requested" in metrics,
                          f"val={metrics.get('recompute_requested')}")
        all_pass &= check("Has recompute_succeeded", "recompute_succeeded" in metrics,
                          f"val={metrics.get('recompute_succeeded')}")
        all_pass &= check("Has recompute_skipped", "recompute_skipped" in metrics,
                          f"val={metrics.get('recompute_skipped')}")
        all_pass &= check("Has recompute_failed", "recompute_failed" in metrics,
                          f"val={metrics.get('recompute_failed')}")
        all_pass &= check("Has finalize_ms", "finalize_ms" in metrics)
        all_pass &= check("Has redis_utterances", "redis_utterances" in metrics,
                          f"val={metrics.get('redis_utterances')}")
        all_pass &= check("Has merged_speaker_count", "merged_speaker_count" in metrics,
                          f"val={metrics.get('merged_speaker_count')}")

        print(f"\n  Finalize time     : {elapsed:.1f}s")
        print(f"  Transcript utts   : {len(fin.get('transcript', []))}")
        print(f"  Speaker stats     : {len(fin.get('speaker_stats', []))}")
        print(f"  Total increments  : {fin.get('total_increments')}")
        print(f"  Report generated  : {'yes' if fin.get('report') else 'no'}")
        print(f"  Recompute metrics : req={metrics.get('recompute_requested')} "
              f"ok={metrics.get('recompute_succeeded')} "
              f"skip={metrics.get('recompute_skipped')} "
              f"fail={metrics.get('recompute_failed')}")
    else:
        print(f"  Response: {r4.text[:500]}")

    # 6. Redis cleanup verification
    print("\nStep 6: Redis cleanup after finalize")
    try:
        meta_after = rc.hgetall(meta_key)
        all_pass &= check("Redis meta cleaned", not meta_after,
                          f"remaining keys: {list(meta_after.keys()) if meta_after else 'none'}")
    except Exception as e:
        all_pass &= check("Redis cleanup check", False, str(e))

    # Summary
    print(f"\n{'=' * 60}")
    if all_pass:
        print("RESULT: ALL CHECKS PASSED")
    else:
        print("RESULT: SOME CHECKS FAILED — review above")
    print(f"{'=' * 60}")

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
