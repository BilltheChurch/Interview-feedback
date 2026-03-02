#!/bin/bash
# ============================================================================
# AutoDL GPU Instance Setup — Interview Feedback Inference Service
# ============================================================================
#
# Prerequisites:
#   1. Register at https://www.autodl.com/
#   2. Create instance: RTX 4090 (24GB) → Image: PyTorch 2.6.0 / CUDA 12.4
#   3. SSH into instance (or use JupyterLab terminal)
#   4. Upload this script and run: bash autodl_setup.sh
#
# Estimated setup time: ~10 min (first run, model downloads)
# Estimated cost: ~2 元/时 (RTX 4090)
#
# Directory layout:
#   /root/autodl-fs/models/    — Shared network storage (persists across instances)
#   /root/autodl-tmp/chorus/   — Local fast storage (lost on instance release)
#   /root/autodl-tmp/chorus/inference/ — Project code
# ============================================================================

set -euo pipefail

echo "============================================"
echo "  Chorus Inference — AutoDL Setup"
echo "============================================"

# ── 1. Verify GPU ──
echo ""
echo "[1/7] Checking GPU..."
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
CUDA_VERSION=$(nvcc --version | grep "release" | awk '{print $5}' | tr -d ',')
echo "CUDA: $CUDA_VERSION"

# ── 2. Setup directories ──
echo ""
echo "[2/7] Setting up directories..."
MODEL_CACHE="/root/autodl-fs/models"
PROJECT_DIR="/root/autodl-tmp/chorus"
mkdir -p "$MODEL_CACHE"/{modelscope,huggingface,sensevoice-onnx,moonshine-onnx,campplus-onnx}
mkdir -p "$PROJECT_DIR"

# ── 3. Clone project ──
echo ""
echo "[3/7] Cloning project..."
if [ -d "$PROJECT_DIR/inference" ]; then
    echo "Project exists, pulling latest..."
    cd "$PROJECT_DIR" && git pull origin main
else
    cd /root/autodl-tmp
    git clone https://github.com/BilltheChurch/Interview-feedback.git chorus
fi
cd "$PROJECT_DIR/inference"

# ── 4. Install dependencies ──
echo ""
echo "[4/7] Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# NeMo for Parakeet (not in requirements.txt — heavy dependency)
echo "Installing NeMo toolkit for Parakeet..."
pip install --quiet nemo_toolkit[asr]>=2.0.0

# ── 5. Write production .env ──
echo ""
echo "[5/7] Writing production .env..."
cat > .env << 'ENVEOF'
APP_NAME=interview-inference
APP_HOST=0.0.0.0
APP_PORT=6006
LOG_LEVEL=INFO

# === CHANGE THIS: Generate with `python -c "import secrets; print(secrets.token_hex(32))"` ===
INFERENCE_API_KEY=CHANGE_ME_TO_RANDOM_KEY

# Speaker Verification — CAM++ on CUDA
SV_MODEL_ID=iic/speech_campplus_sv_zh_en_16k-common_advanced
SV_MODEL_REVISION=v1.0.0
SV_BACKEND=modelscope
SV_DEVICE=cuda
SV_T_LOW=0.60
SV_T_HIGH=0.70
CLUSTER_MATCH_THRESHOLD=0.60

AUDIO_SR=16000
MAX_AUDIO_SECONDS=30
MAX_AUDIO_BYTES=5242880

ENABLE_DIARIZATION=true
SEGMENTER_BACKEND=vad

# Model cache — shared network storage (persists across instances)
MODELSCOPE_CACHE=/root/autodl-fs/models/modelscope

VAD_MODE=2
VAD_FRAME_MS=30
VAD_MIN_SPEECH_MS=300
VAD_MIN_SILENCE_MS=250

PROFILE_AUTO_THRESHOLD=0.72
PROFILE_CONFIRM_THRESHOLD=0.60
PROFILE_MARGIN_THRESHOLD=0.08
ENROLLMENT_READY_SECONDS=12
ENROLLMENT_READY_SAMPLES=3

# === CHANGE THIS: Your DashScope API key ===
DASHSCOPE_API_KEY=CHANGE_ME

RATE_LIMIT_ENABLED=true
RATE_LIMIT_REQUESTS=120
RATE_LIMIT_WINDOW_SECONDS=60

REPORT_MODEL_NAME=qwen-flash
REPORT_TIMEOUT_MS=100000

# ── ASR: Parakeet TDT on CUDA (primary) ──
ASR_BACKEND=parakeet
PARAKEET_MODEL_NAME=nvidia/parakeet-tdt-0.6b-v2
PARAKEET_DEVICE=cuda

# Fallback ASR (if Parakeet fails to load)
ASR_ONNX_MODEL_PATH=/root/autodl-fs/models/sensevoice-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17

# Speaker Diarization — pyannote on CUDA
PYANNOTE_MODEL_ID=pyannote/speaker-diarization-community-1
PYANNOTE_DEVICE=cuda
# === CHANGE THIS: Your HuggingFace token (needs pyannote license) ===
HF_TOKEN=CHANGE_ME

# ── Incremental V1 Pipeline ──
INCREMENTAL_V1_ENABLED=true
REDIS_URL=redis://localhost:6379/0

# ── Recompute ASR: faster-whisper large-v3 on CUDA ──
RECOMPUTE_ASR_ENABLED=true
RECOMPUTE_ASR_MODEL_SIZE=large-v3
RECOMPUTE_ASR_DEVICE=cuda

# Whisper (Tier 2 batch processing)
WHISPER_MODEL_SIZE=large-v3
WHISPER_DEVICE=cuda
ENVEOF

echo "  .env written. IMPORTANT: Edit INFERENCE_API_KEY, DASHSCOPE_API_KEY, HF_TOKEN!"

# ── 6. Install and start Redis ──
echo ""
echo "[6/7] Setting up Redis..."
if ! command -v redis-server &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq redis-server
fi
redis-server --daemonize yes --save "" --appendonly no
redis-cli ping

# ── 7. Verify setup ──
echo ""
echo "[7/7] Verifying setup..."
python -c "
from app.config import Settings
s = Settings()
print(f'ASR_BACKEND:            {s.asr_backend}')
print(f'PARAKEET_DEVICE:        {s.parakeet_device}')
print(f'INCREMENTAL_V1_ENABLED: {s.incremental_v1_enabled}')
print(f'RECOMPUTE_ASR_ENABLED:  {s.recompute_asr_enabled}')
print(f'RECOMPUTE_ASR_MODEL:    {s.recompute_asr_model_size}')
print(f'RECOMPUTE_ASR_DEVICE:   {s.recompute_asr_device}')
print(f'REDIS_URL:              {s.redis_url}')
print(f'APP_PORT:               {s.app_port}')
"

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit .env: set INFERENCE_API_KEY, DASHSCOPE_API_KEY, HF_TOKEN"
echo "  2. Start service:"
echo "     screen -S inference"
echo "     uvicorn app.main:app --host 0.0.0.0 --port 6006"
echo "     # Ctrl+A, D to detach"
echo ""
echo "  3. Verify:"
echo "     curl http://localhost:6006/health"
echo ""
echo "  4. Access from outside (AutoDL custom service):"
echo "     Go to Console → Instance → Custom Service → Get 6006 mapped URL"
echo "     e.g. https://xxx.seetacloud.com:8443/health"
echo ""
echo "  5. Run E2E test:"
echo "     python tests/e2e_v1_full.py"
echo ""
echo "  6. To save money, shut down instance when not in use."
echo "     Models cached in /root/autodl-fs/ persist across sessions."
echo ""
