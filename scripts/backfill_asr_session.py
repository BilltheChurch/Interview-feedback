#!/usr/bin/env python3
"""Backfill ASR windows for one session until ingest last_seq is fully covered."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def request_json(method: str, url: str, payload: dict | None = None, timeout: int = 120) -> dict:
    body = None
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    }
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url=url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {method} {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"network error for {method} {url}: {exc}") from exc

    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"non-JSON response for {method} {url}: {raw[:200]!r}") from exc


def role_state(state: dict, stream_role: str) -> tuple[int, int]:
    ingest_by_stream = state.get("ingest_by_stream", {})
    asr_by_stream = state.get("asr_by_stream", {})
    ingest = ingest_by_stream.get(stream_role, {}) if isinstance(ingest_by_stream, dict) else {}
    asr = asr_by_stream.get(stream_role, {}) if isinstance(asr_by_stream, dict) else {}

    if stream_role == "mixed":
        if not ingest:
            ingest = state.get("ingest", {})
        if not asr:
            asr = state.get("asr", {})

    last_seq = int(ingest.get("last_seq", 0))
    last_window_end_seq = int(asr.get("last_window_end_seq", 0))
    return last_seq, last_window_end_seq


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill ASR for one session")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--stream-role", choices=["mixed", "teacher", "students"], default="mixed")
    parser.add_argument("--batch-windows", type=int, default=5, help="asr-run max_windows per request")
    parser.add_argument("--reset-first", action="store_true")
    parser.add_argument("--sleep-ms", type=int, default=200)
    args = parser.parse_args()

    if args.batch_windows <= 0:
        raise RuntimeError("--batch-windows must be positive")

    base = args.base_url.rstrip("/")
    sid = urllib.parse.quote(args.session_id, safe="")
    state_url = f"{base}/v1/sessions/{sid}/state"
    reset_url = f"{base}/v1/sessions/{sid}/asr-reset?stream_role={args.stream_role}"

    if args.reset_first:
        reset_result = request_json("POST", reset_url, payload={})
        print("asr-reset:", json.dumps(reset_result, ensure_ascii=False))

    rounds = 0
    generated_total = 0
    while True:
        rounds += 1
        state = request_json("GET", state_url)
        last_seq, last_window_end_seq = role_state(state, args.stream_role)
        print(
            f"round={rounds} stream_role={args.stream_role} last_window_end_seq={last_window_end_seq} target_last_seq={last_seq}"
        )

        if last_seq <= 0:
            raise RuntimeError("ingest last_seq is 0; no chunks to backfill")

        if last_window_end_seq >= last_seq:
            print("backfill complete")
            break

        run_url = (
            f"{base}/v1/sessions/{sid}/asr-run"
            f"?stream_role={args.stream_role}&max_windows={args.batch_windows}"
        )
        run_result = request_json("POST", run_url, payload={}, timeout=300)
        generated = int(run_result.get("generated", 0))
        generated_total += generated
        print("asr-run:", json.dumps(run_result, ensure_ascii=False))

        if generated <= 0:
            raise RuntimeError("asr-run generated=0 before reaching target; check last_error/state")

        if args.sleep_ms > 0:
            time.sleep(args.sleep_ms / 1000)

    print(f"generated_total={generated_total}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"backfill_asr_session failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
