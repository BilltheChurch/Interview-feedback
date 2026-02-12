#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/sidecar/pyannote-rs-server"
BIN_DIR="$ROOT_DIR/bin"
MODEL_DIR="$BIN_DIR/models"

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "error: cmake is required (install with: brew install cmake)" >&2
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  echo "error: rust toolchain is required" >&2
  echo "install via: curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$MODEL_DIR"

SEG_MODEL="$MODEL_DIR/segmentation-3.0.onnx"
EMB_MODEL="$MODEL_DIR/wespeaker_en_voxceleb_CAM++.onnx"

if [[ ! -f "$SEG_MODEL" ]]; then
  curl -L --fail -o "$SEG_MODEL" \
    'https://github.com/thewh1teagle/pyannote-rs/releases/download/v0.1.0/segmentation-3.0.onnx'
fi

if [[ ! -f "$EMB_MODEL" ]]; then
  curl -L --fail -o "$EMB_MODEL" \
    'https://github.com/thewh1teagle/pyannote-rs/releases/download/v0.1.0/wespeaker_en_voxceleb_CAM++.onnx'
fi

(
  cd "$SIDECAR_DIR"
  cargo build --release
)

cp "$SIDECAR_DIR/target/release/pyannote-rs" "$BIN_DIR/pyannote-rs"
chmod +x "$BIN_DIR/pyannote-rs"

"$BIN_DIR/pyannote-rs" serve --host 127.0.0.1 --port 9705 >/tmp/pyannote-sidecar-install.log 2>&1 &
PID=$!
sleep 2
curl -sS http://127.0.0.1:9705/health >/dev/null
kill "$PID" >/dev/null 2>&1 || true

echo "pyannote sidecar installed: $BIN_DIR/pyannote-rs"
echo "models: $MODEL_DIR"
