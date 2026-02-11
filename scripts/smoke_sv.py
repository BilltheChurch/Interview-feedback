#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import httpx


def encode_audio(file_path: Path) -> dict:
    audio_bytes = file_path.read_bytes()
    return {
        "content_b64": base64.b64encode(audio_bytes).decode("ascii"),
        "format": "wav",
    }


def post_json(client: httpx.Client, url: str, payload: dict) -> dict:
    response = client.post(url, json=payload, timeout=60)
    response.raise_for_status()
    return response.json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test for SV + resolve pipeline")
    parser.add_argument("--base-url", required=True, help="e.g. http://localhost:8000")
    parser.add_argument("--samples", required=True, help="samples directory")
    parser.add_argument("--api-key", default="", help="optional x-api-key header")
    args = parser.parse_args()

    samples = Path(args.samples)
    required = {
        "alice_enroll": samples / "alice_enroll.wav",
        "alice_probe": samples / "alice_probe.wav",
        "bob_enroll": samples / "bob_enroll.wav",
        "bob_probe": samples / "bob_probe.wav",
    }

    missing = [name for name, path in required.items() if not path.exists()]
    if missing:
        print(f"missing sample files: {missing}", file=sys.stderr)
        return 2

    headers = {"x-api-key": args.api_key} if args.api_key else {}
    with httpx.Client(base_url=args.base_url.rstrip("/"), headers=headers) as client:
        health = client.get("/health", timeout=10)
        health.raise_for_status()
        print("health:", json.dumps(health.json(), ensure_ascii=False))

        score_aa = post_json(client, "/sv/score", {
            "audio_a": encode_audio(required["alice_enroll"]),
            "audio_b": encode_audio(required["alice_probe"]),
        })
        score_ab = post_json(client, "/sv/score", {
            "audio_a": encode_audio(required["alice_enroll"]),
            "audio_b": encode_audio(required["bob_probe"]),
        })
        score_bb = post_json(client, "/sv/score", {
            "audio_a": encode_audio(required["bob_enroll"]),
            "audio_b": encode_audio(required["bob_probe"]),
        })
        score_ba = post_json(client, "/sv/score", {
            "audio_a": encode_audio(required["bob_enroll"]),
            "audio_b": encode_audio(required["alice_probe"]),
        })

        print("score_aa:", score_aa["score"])
        print("score_ab:", score_ab["score"])
        print("score_bb:", score_bb["score"])
        print("score_ba:", score_ba["score"])

        if score_aa["score"] <= score_ab["score"]:
            print("Top-1 failed for Alice", file=sys.stderr)
            return 1
        if score_bb["score"] <= score_ba["score"]:
            print("Top-1 failed for Bob", file=sys.stderr)
            return 1

        state = {"clusters": [], "bindings": {}, "roster": [{"name": "Alice"}, {"name": "Bob"}]}

        resolve_alice = post_json(client, "/speaker/resolve", {
            "session_id": "smoke-session",
            "audio": encode_audio(required["alice_probe"]),
            "asr_text": "Hi team, my name is Alice.",
            "state": state,
        })
        state = resolve_alice["updated_state"]

        resolve_bob = post_json(client, "/speaker/resolve", {
            "session_id": "smoke-session",
            "audio": encode_audio(required["bob_probe"]),
            "asr_text": "Hello everyone, I am Bob.",
            "state": state,
        })

        print("resolve_alice:", json.dumps(resolve_alice, ensure_ascii=False))
        print("resolve_bob:", json.dumps(resolve_bob, ensure_ascii=False))

        if resolve_alice["decision"] not in {"auto", "confirm"}:
            print("Alice resolve decision invalid", file=sys.stderr)
            return 1
        if resolve_bob["decision"] not in {"auto", "confirm"}:
            print("Bob resolve decision invalid", file=sys.stderr)
            return 1

    print("smoke_sv passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
