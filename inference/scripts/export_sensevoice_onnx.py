"""Download or export SenseVoice-Small ONNX model for sherpa-onnx.

Usage (download pre-exported):
    python scripts/export_sensevoice_onnx.py --download

Usage (export from FunASR, requires PyTorch):
    python scripts/export_sensevoice_onnx.py --export
"""

import argparse
import os
import subprocess
import sys


def download(output_dir: str):
    """Download pre-exported ONNX model from sherpa-onnx releases."""
    os.makedirs(output_dir, exist_ok=True)

    url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
    tarball = os.path.join(output_dir, "model.tar.bz2")

    print(f"Downloading SenseVoice ONNX model to {output_dir}...")
    subprocess.run(["curl", "-SL", "-o", tarball, url], check=True)

    print("Extracting...")
    subprocess.run(["tar", "xf", tarball, "-C", output_dir], check=True)

    os.unlink(tarball)
    print(f"Model ready at {output_dir}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/")


def export_from_funasr(output_dir: str):
    """Export from FunASR (requires PyTorch + funasr installed)."""
    os.makedirs(output_dir, exist_ok=True)

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    from funasr import AutoModel
    model = AutoModel(model="iic/SenseVoiceSmall", trust_remote_code=True, device="cpu")
    model.export(output_dir=output_dir, type="onnx", quantize=False)
    print(f"Model exported to {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SenseVoice ONNX model setup")
    parser.add_argument("--download", action="store_true", help="Download pre-exported model")
    parser.add_argument("--export", action="store_true", help="Export from FunASR (requires PyTorch)")
    parser.add_argument("--output", default=os.path.expanduser("~/.cache/sensevoice-onnx/"))
    args = parser.parse_args()

    if args.download or (not args.export):
        download(args.output)
    elif args.export:
        export_from_funasr(args.output)
