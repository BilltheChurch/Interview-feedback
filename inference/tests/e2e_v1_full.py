"""Full V1 Pipeline E2E — complete qingnian audio through HTTP endpoints.

Simulates Worker's 3-minute incremental schedule via V1 HTTP API.
Measures: processing time, speaker detection, recompute metrics, report generation.

Usage:
    # Start inference: cd inference && .venv/bin/uvicorn app.main:app --port 8000
    # Run: cd inference && .venv/bin/python tests/e2e_v1_full.py
"""
import base64
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_URL = "http://localhost:8000"
API_KEY = os.environ.get("INFERENCE_API_KEY", "")
HEADERS = {"x-api-key": API_KEY}
AUDIO_PATH = "/tmp/qingnian_test.wav"
INTERVAL_MS = 180_000  # 3 minutes
OVERLAP_MS = 30_000
CUMULATIVE_THRESHOLD = 2


def load_wav(path: str):
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16)
    dur_ms = int(len(pcm) / sr * 1000)
    return pcm, sr, dur_ms


def slice_to_b64(pcm: np.ndarray, sr: int, start_ms: int, end_ms: int) -> str:
    s = int(start_ms / 1000 * sr)
    e = int(end_ms / 1000 * sr)
    chunk = pcm[s:e]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(chunk.tobytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


def main():
    if not Path(AUDIO_PATH).exists():
        print(f"Audio not found: {AUDIO_PATH}")
        sys.exit(1)

    # Health check
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=5)
        assert r.status_code == 200
    except Exception:
        print("Inference not running. Start: uvicorn app.main:app --port 8000")
        sys.exit(1)

    pcm, sr, total_ms = load_wav(AUDIO_PATH)
    session_id = f"e2e-v1-{int(time.time())}"

    print("=" * 65)
    print("V1 FULL E2E — qingnian_test.wav via HTTP")
    print("=" * 65)
    print(f"Audio    : {total_ms/1000:.0f}s ({total_ms/60000:.1f} min)")
    print(f"Session  : {session_id}")
    print(f"Interval : {INTERVAL_MS/1000:.0f}s, Overlap: {OVERLAP_MS/1000:.0f}s")
    print("=" * 65)

    # ── Incremental process-chunk loop ──
    last_ms = 0
    idx = 0
    total_proc_time = 0
    all_speakers = set()
    all_utt_count = 0
    low_conf_utts = []  # Collect for recompute

    while last_ms + INTERVAL_MS <= total_ms:
        end_ms = last_ms + INTERVAL_MS
        start_ms = 0 if idx < CUMULATIVE_THRESHOLD else max(0, last_ms - OVERLAP_MS)
        mode = "CUMUL" if idx < CUMULATIVE_THRESHOLD else "CHUNK"

        audio_b64 = slice_to_b64(pcm, sr, start_ms, end_ms)

        print(f"\nIncrement {idx} [{mode}] {start_ms/1000:.0f}s → {end_ms/1000:.0f}s "
              f"({(end_ms-start_ms)/1000:.0f}s) ... ", end="", flush=True)

        payload = {
            "v": 1,
            "session_id": session_id,
            "increment_id": f"{session_id}-inc-{idx}",
            "increment_index": idx,
            "audio_b64": audio_b64,
            "audio_start_ms": start_ms,
            "audio_end_ms": end_ms,
            "language": "en",
            "run_analysis": False,
            "locale": "en-US",
        }

        t0 = time.time()
        r = requests.post(f"{BASE_URL}/v1/incremental/process-chunk",
                          json=payload, headers=HEADERS, timeout=300)
        elapsed = time.time() - t0
        total_proc_time += elapsed

        if r.status_code != 200:
            print(f"FAIL ({r.status_code}): {r.text[:200]}")
            last_ms = end_ms
            idx += 1
            continue

        data = r.json()
        n_spk = data.get("speakers_detected", 0)
        utts = data.get("utterances", [])
        n_utt = len(utts)
        stable = data.get("stable_speaker_map", False)
        metrics = data.get("metrics", {})

        for u in utts:
            spk = u.get("speaker", "")
            if spk and spk != "_unknown":
                all_speakers.add(spk)
            # Collect low-confidence for recompute
            conf = u.get("confidence", 1.0)
            if conf < 0.7:
                low_conf_utts.append({
                    "utterance_id": u.get("id", ""),
                    "increment_index": idx,
                    "start_ms": u.get("start_ms", 0),
                    "end_ms": u.get("end_ms", 0),
                    "confidence": conf,
                })

        all_utt_count += n_utt
        print(f"{elapsed:.1f}s  spk={n_spk}  utt={n_utt}  "
              f"stable={'Y' if stable else '-'}  "
              f"diar={metrics.get('diarization_ms', 0)/1000:.1f}s  "
              f"asr={metrics.get('transcription_ms', 0)/1000:.1f}s")

        last_ms = end_ms
        idx += 1

    # ── Process tail audio as final increment ──
    remaining_ms = total_ms - last_ms
    if remaining_ms > 5000:
        tail_start = max(0, last_ms - OVERLAP_MS)
        audio_b64 = slice_to_b64(pcm, sr, tail_start, total_ms)
        print(f"\nTail increment {idx} [TAIL] {tail_start/1000:.0f}s → {total_ms/1000:.0f}s ... ",
              end="", flush=True)
        payload = {
            "v": 1,
            "session_id": session_id,
            "increment_id": f"{session_id}-inc-{idx}",
            "increment_index": idx,
            "audio_b64": audio_b64,
            "audio_start_ms": tail_start,
            "audio_end_ms": total_ms,
            "language": "en",
            "run_analysis": False,
            "locale": "en-US",
        }
        t0 = time.time()
        r = requests.post(f"{BASE_URL}/v1/incremental/process-chunk",
                          json=payload, headers=HEADERS, timeout=300)
        elapsed = time.time() - t0
        total_proc_time += elapsed
        if r.status_code == 200:
            data = r.json()
            utts = data.get("utterances", [])
            for u in utts:
                spk = u.get("speaker", "")
                if spk and spk != "_unknown":
                    all_speakers.add(spk)
                conf = u.get("confidence", 1.0)
                if conf < 0.7:
                    low_conf_utts.append({
                        "utterance_id": u.get("id", ""),
                        "increment_index": idx,
                        "start_ms": u.get("start_ms", 0),
                        "end_ms": u.get("end_ms", 0),
                        "confidence": conf,
                    })
            all_utt_count += len(utts)
            print(f"{elapsed:.1f}s  spk={data.get('speakers_detected')}  utt={len(utts)}")
        else:
            print(f"FAIL: {r.text[:200]}")
        idx += 1

    # ── Build recompute segments (top 5 lowest confidence) ──
    recompute_segments = []
    if low_conf_utts:
        low_conf_utts.sort(key=lambda x: x["confidence"])
        for lc in low_conf_utts[:5]:  # Max 5 segments
            seg_start = lc["start_ms"]
            seg_end = min(lc["end_ms"], total_ms)
            if seg_end - seg_start < 500:
                continue
            seg_audio = slice_to_b64(pcm, sr, seg_start, seg_end)
            recompute_segments.append({
                "utterance_id": lc["utterance_id"],
                "increment_index": lc["increment_index"],
                "start_ms": seg_start,
                "end_ms": seg_end,
                "original_confidence": lc["confidence"],
                "stream_role": "mixed",
                "audio_b64": seg_audio,
                "audio_format": "wav",
            })

    # ── Finalize ──
    print(f"\n{'─' * 65}")
    print(f"FINALIZE: {idx} increments processed, {len(recompute_segments)} recompute segments")
    print(f"{'─' * 65}")

    finalize_payload = {
        "v": 1,
        "session_id": session_id,
        "total_audio_ms": total_ms,
        "locale": "en-US",
        "recompute_segments": recompute_segments,
    }

    t0 = time.time()
    r = requests.post(f"{BASE_URL}/v1/incremental/finalize",
                      json=finalize_payload, headers=HEADERS, timeout=300)
    finalize_time = time.time() - t0

    if r.status_code != 200:
        print(f"  FINALIZE FAILED ({r.status_code}): {r.text[:500]}")
        sys.exit(1)

    fin = r.json()
    transcript = fin.get("transcript", [])
    stats = fin.get("speaker_stats", [])
    metrics = fin.get("metrics", {})
    report = fin.get("report")

    fin_speakers = set()
    for u in transcript:
        spk = u.get("speaker", "")
        if spk and spk != "_unknown":
            fin_speakers.add(spk)

    print(f"  Finalize time     : {finalize_time:.1f}s")
    print(f"  Transcript utts   : {len(transcript)}")
    print(f"  Post-merge spk    : {len(fin_speakers)} ({', '.join(sorted(fin_speakers))})")
    print(f"  Total increments  : {fin.get('total_increments')}")
    print(f"  Report            : {'generated' if report else 'skipped'}")
    print(f"  Redis utterances  : {metrics.get('redis_utterances')}")
    print(f"  Merged speakers   : {metrics.get('merged_speaker_count')}")
    print("\n  Recompute metrics:")
    print(f"    requested       : {metrics.get('recompute_requested')}")
    print(f"    succeeded       : {metrics.get('recompute_succeeded')}")
    print(f"    skipped         : {metrics.get('recompute_skipped')}")
    print(f"    failed          : {metrics.get('recompute_failed')}")

    # ── Summary ──
    print(f"\n{'=' * 65}")
    print("RESULTS SUMMARY")
    print(f"{'=' * 65}")
    print(f"Audio              : {total_ms/60000:.1f} min")
    print(f"Increments         : {idx} ({idx} ok)")
    print(f"Pre-merge speakers : {len(all_speakers)}")
    print(f"Post-merge speakers: {len(fin_speakers)}")
    print(f"Total utterances   : {len(transcript)}")
    print(f"Low-conf collected : {len(low_conf_utts)}")
    print(f"Recompute sent     : {len(recompute_segments)}")
    print(f"Recompute succeeded: {metrics.get('recompute_succeeded', 0)}")
    print(f"Total process time : {total_proc_time:.1f}s")
    print(f"Finalize time      : {finalize_time:.1f}s")
    print(f"Processing RTF     : {total_proc_time / (total_ms/1000):.3f}")
    print(f"{'=' * 65}")

    # ── Speaker stats ──
    if stats:
        print("\nSpeaker Stats:")
        for s in sorted(stats, key=lambda x: x.get("talk_time_ms", 0), reverse=True):
            print(f"  {s.get('speaker_key', '?'):10s} "
                  f"  talk={s.get('talk_time_ms', 0)/1000:.0f}s"
                  f"  turns={s.get('turns', 0)}"
                  f"  name={s.get('speaker_name', '-')}")

    # ── Save results ──
    output = {
        "session_id": session_id,
        "audio_duration_ms": total_ms,
        "increments": idx,
        "pre_merge_speakers": len(all_speakers),
        "post_merge_speakers": len(fin_speakers),
        "transcript_utterances": len(transcript),
        "low_conf_collected": len(low_conf_utts),
        "recompute_sent": len(recompute_segments),
        "recompute_metrics": {
            "requested": metrics.get("recompute_requested"),
            "succeeded": metrics.get("recompute_succeeded"),
            "skipped": metrics.get("recompute_skipped"),
            "failed": metrics.get("recompute_failed"),
        },
        "total_process_time_s": round(total_proc_time, 2),
        "finalize_time_s": round(finalize_time, 2),
        "processing_rtf": round(total_proc_time / (total_ms / 1000), 4),
        "speaker_stats": stats,
        "report_generated": report is not None,
    }

    out_path = Path(__file__).parent / "e2e_v1_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved: {out_path}")

    # Save transcript
    if transcript:
        txt_path = Path(__file__).parent / "e2e_v1_transcript.txt"
        with open(txt_path, "w") as f:
            f.write(f"V1 E2E Transcript — {total_ms/60000:.1f} min | {len(fin_speakers)} speakers\n")
            f.write("=" * 80 + "\n\n")
            for u in transcript:
                s = u.get("start_ms", 0) / 1000
                e = u.get("end_ms", 0) / 1000
                spk = u.get("speaker", "?")
                text = u.get("text", "")
                conf = u.get("confidence", 0)
                recomp = " [RECOMPUTED]" if u.get("recomputed") else ""
                f.write(f"[{int(s//60):02d}:{s%60:05.2f} → {int(e//60):02d}:{e%60:05.2f}] "
                        f"{spk} (conf={conf:.2f}){recomp}: {text}\n")
        print(f"Transcript saved: {txt_path}")


if __name__ == "__main__":
    main()
