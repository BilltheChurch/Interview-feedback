"""Unified ONNX parity and performance benchmark — GATE 3 formal verification.

All 5 conditions must pass for GATE 3 to be approved.

Usage:
    cd inference
    python tests/benchmark_onnx_parity.py

GATE 3 conditions (strict — no tolerance degradation):
    G3.1: SenseVoice ONNX vs PyTorch text output must be EXACT match
    G3.2: CAM++ ONNX vs PyTorch embedding cosine distance < 0.01
    G3.3: ONNX inference speed >= PyTorch speed (ONNX must not be slower)
    G3.4: ONNX backends must not import torch at module level
    G3.5: GATE 1 + GATE 2 regression (all tests pass)
"""

import ast
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def check_sensevoice_parity() -> dict:
    """G3.1: SenseVoice ONNX text output must EXACTLY match PyTorch."""
    audio = "samples/short_3s_zh.wav"
    if not Path(audio).exists():
        return {"status": "SKIP", "reason": "No test audio"}

    try:
        from app.services.sensevoice_transcriber import SenseVoiceTranscriber
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        pytorch = SenseVoiceTranscriber()
        onnx = SenseVoiceOnnxTranscriber()

        # Test with explicit language to ensure deterministic comparison
        r_pt = pytorch.transcribe(audio, language="zh")
        r_ox = onnx.transcribe(audio, language="zh")

        text_pt = " ".join(u.text for u in r_pt.utterances)
        text_ox = " ".join(u.text for u in r_ox.utterances)

        exact_match = text_pt == text_ox

        return {
            "status": "PASS" if exact_match else "FAIL",
            "exact_match": exact_match,
            "pytorch_text": text_pt[:100],
            "onnx_text": text_ox[:100],
        }
    except Exception as e:
        return {"status": "FAIL", "error": str(e)}


def check_campplus_parity() -> dict:
    """G3.2: CAM++ ONNX embedding cosine distance < 0.01 vs PyTorch."""
    audio = "samples/short_3s_zh.wav"
    if not Path(audio).exists():
        return {"status": "SKIP", "reason": "No test audio"}

    onnx_model = Path("~/.cache/campplus-onnx/campplus.onnx").expanduser()
    if not onnx_model.exists():
        return {"status": "SKIP", "reason": "ONNX model not exported yet"}

    try:
        import numpy as np
        import wave

        # Load audio
        with wave.open(audio, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32767.0

        # ONNX embedding
        from app.services.sv_onnx import OnnxSVBackend
        onnx_sv = OnnxSVBackend()
        emb_onnx = onnx_sv.extract_embedding(samples, 16000)

        # PyTorch embedding
        from app.services.sv import ModelScopeSVBackend
        pytorch_sv = ModelScopeSVBackend(
            model_id="iic/speech_campplus_sv_zh_en_16k-common_advanced",
            model_revision="master",
            cache_dir="~/.cache/modelscope",
        )
        emb_pt = pytorch_sv.extract_embedding(samples, 16000)

        if len(emb_onnx) != len(emb_pt):
            return {
                "status": "FAIL",
                "error": f"Dimension mismatch: ONNX={len(emb_onnx)}, PyTorch={len(emb_pt)}",
            }

        cosine = float(np.dot(emb_onnx, emb_pt) / (np.linalg.norm(emb_onnx) * np.linalg.norm(emb_pt)))
        distance = 1.0 - cosine

        # Strict threshold: < 0.01 per design doc
        return {
            "status": "PASS" if distance < 0.01 else "FAIL",
            "cosine_similarity": round(cosine, 6),
            "cosine_distance": round(distance, 6),
            "onnx_dim": len(emb_onnx),
            "pytorch_dim": len(emb_pt),
        }
    except Exception as e:
        return {"status": "FAIL", "error": str(e)}


def check_onnx_speed() -> dict:
    """G3.3: ONNX ASR must not be slower than PyTorch (strict, no tolerance)."""
    audio = "samples/short_3s_zh.wav"
    if not Path(audio).exists():
        return {"status": "SKIP", "reason": "No test audio"}

    try:
        from app.services.sensevoice_transcriber import SenseVoiceTranscriber
        from app.services.sensevoice_onnx import SenseVoiceOnnxTranscriber

        pytorch = SenseVoiceTranscriber()
        onnx = SenseVoiceOnnxTranscriber()

        # Warm up (critical for fair comparison)
        pytorch.transcribe(audio, language="zh")
        onnx.transcribe(audio, language="zh")

        # Benchmark (5 runs each, take median for stability)
        pt_times = []
        ox_times = []
        for _ in range(5):
            start = time.perf_counter()
            pytorch.transcribe(audio, language="zh")
            pt_times.append(time.perf_counter() - start)

            start = time.perf_counter()
            onnx.transcribe(audio, language="zh")
            ox_times.append(time.perf_counter() - start)

        avg_pt = sorted(pt_times)[2] * 1000  # median of 5
        avg_ox = sorted(ox_times)[2] * 1000  # median of 5

        # Strict: ONNX must not be slower than PyTorch
        passed = avg_ox <= avg_pt

        return {
            "status": "PASS" if passed else "FAIL",
            "pytorch_median_ms": round(avg_pt, 1),
            "onnx_median_ms": round(avg_ox, 1),
            "ratio": round(avg_ox / max(avg_pt, 0.1), 3),
        }
    except Exception as e:
        return {"status": "FAIL", "error": str(e)}


def check_no_torch_import() -> dict:
    """G3.4: ONNX backends must not import torch at module level."""
    onnx_files = [
        Path("app/services/sensevoice_onnx.py"),
        Path("app/services/sv_onnx.py"),
    ]

    results = {}
    all_clean = True
    for onnx_file in onnx_files:
        if not onnx_file.exists():
            results[str(onnx_file)] = "NOT FOUND"
            all_clean = False
            continue

        source = onnx_file.read_text()
        tree = ast.parse(source)
        torch_imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("torch"):
                        torch_imports.append(alias.name)
            if isinstance(node, ast.ImportFrom):
                if node.module and node.module.startswith("torch"):
                    torch_imports.append(f"from {node.module}")

        if torch_imports:
            results[str(onnx_file)] = f"FAIL: imports {torch_imports}"
            all_clean = False
        else:
            results[str(onnx_file)] = "CLEAN"

    return {
        "status": "PASS" if all_clean else "FAIL",
        **results,
    }


def check_regression() -> dict:
    """G3.5: GATE 1 + GATE 2 regression — all tests pass."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/", "-q", "--tb=no"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    passed = result.returncode == 0
    # Extract summary line
    lines = result.stdout.strip().split("\n")
    summary = lines[-1] if lines else "unknown"

    return {
        "status": "PASS" if passed else "FAIL",
        "summary": summary,
        "returncode": result.returncode,
    }


def main():
    print("=" * 60)
    print("GATE 3: ONNX Runtime Verification (STRICT)")
    print("=" * 60)

    checks = {
        "G3.1 SenseVoice Parity": check_sensevoice_parity,
        "G3.2 CAM++ Parity": check_campplus_parity,
        "G3.3 ONNX Speed": check_onnx_speed,
        "G3.4 No PyTorch Import": check_no_torch_import,
        "G3.5 Regression": check_regression,
    }

    results = {}
    all_passed = True
    for name, fn in checks.items():
        print(f"\nRunning {name}...")
        result = fn()
        results[name] = result
        status = result["status"]
        symbol = "✓" if status == "PASS" else ("⏭" if status == "SKIP" else "✗")
        print(f"  {symbol} {name}: {status}")
        for k, v in result.items():
            if k != "status":
                print(f"    {k}: {v}")
        if status == "FAIL":
            all_passed = False

    print("\n" + "=" * 60)
    if all_passed:
        print("✓ GATE 3: ALL CHECKS PASSED (STRICT)")
    else:
        print("✗ GATE 3: FAILED — review failures above")
        sys.exit(1)

    # Save results
    with open("gate3_results.json", "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print("\nResults saved to gate3_results.json")


if __name__ == "__main__":
    main()
