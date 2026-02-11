#!/usr/bin/env python3
"""Smoke test for Phase 2 Worker ASR pipeline.

Prerequisites:
1. Session already has uploaded chunks (Phase 1 completed).
2. Worker secret ALIYUN_DASHSCOPE_API_KEY is configured.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def request_json(method: str, url: str, payload: dict | None = None) -> dict:
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
        with urllib.request.urlopen(req, timeout=90) as resp:
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Worker ASR smoke test against one session")
    parser.add_argument("--base-url", required=True, help="Worker base URL, e.g. https://api.frontierace.ai")
    parser.add_argument("--session-id", required=True, help="Session id with existing chunks")
    parser.add_argument(
        "--stream-role",
        default="mixed",
        choices=["mixed", "teacher", "students"],
        help="Target stream role to run ASR on",
    )
    parser.add_argument(
        "--view",
        default="raw",
        choices=["raw", "merged"],
        help="Utterance view to validate",
    )
    parser.add_argument("--min-utterances", type=int, default=1, help="Expected minimum utterance count")
    parser.add_argument(
        "--max-windows",
        type=int,
        default=1,
        help="Max windows to process in one asr-run call (default: 1 for quick smoke)",
    )
    parser.add_argument(
        "--reset-first",
        action="store_true",
        help="Reset ASR state/utterances for this stream before running asr-run",
    )
    parser.add_argument(
        "--allow-empty-text",
        action="store_true",
        help="Allow all ASR texts to be empty (useful for silence-only sessions)",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    sid = urllib.parse.quote(args.session_id, safe="")

    state_url = f"{base}/v1/sessions/{sid}/state"
    asr_reset_url = f"{base}/v1/sessions/{sid}/asr-reset?stream_role={args.stream_role}"
    asr_run_url = (
        f"{base}/v1/sessions/{sid}/asr-run"
        f"?stream_role={args.stream_role}&max_windows={args.max_windows}"
    )
    utterances_url = (
        f"{base}/v1/sessions/{sid}/utterances"
        f"?stream_role={args.stream_role}&view={args.view}&limit=1000"
    )

    state = request_json("GET", state_url)
    print("state.ingest:", json.dumps(state.get("ingest", {}), ensure_ascii=False))
    print("state.asr:", json.dumps(state.get("asr", {}), ensure_ascii=False))
    print("state.ingest_by_stream:", json.dumps(state.get("ingest_by_stream", {}), ensure_ascii=False))
    print("state.asr_by_stream:", json.dumps(state.get("asr_by_stream", {}), ensure_ascii=False))

    if args.reset_first:
        reset_result = request_json("POST", asr_reset_url, payload={})
        print("asr-reset:", json.dumps(reset_result, ensure_ascii=False))

    run_result = request_json("POST", asr_run_url, payload={})
    print("asr-run:", json.dumps(run_result, ensure_ascii=False))

    utterances = request_json("GET", utterances_url)
    count = int(utterances.get("count", 0))
    items = utterances.get("items", [])
    print(f"utterances.count={count}")

    if count < args.min_utterances:
        raise RuntimeError(f"utterance count {count} is below expected {args.min_utterances}")

    has_non_empty = any(str(item.get("text", "")).strip() for item in items)
    if not args.allow_empty_text and not has_non_empty:
        raise RuntimeError("all ASR texts are empty; use --allow-empty-text if this is expected")

    print("smoke_asr_worker passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"smoke_asr_worker failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
