#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${SV_MODEL_ID:-iic/speech_campplus_sv_zh_en_16k-common_advanced}"
MODEL_REVISION="${SV_MODEL_REVISION:-master}"
CACHE_DIR="${MODELSCOPE_CACHE:-/Users/billthechurch/Interview-feedback/.cache/modelscope}"

mkdir -p "$CACHE_DIR"

python3 - <<PY
from modelscope import snapshot_download
model_dir = snapshot_download(
    model_id='${MODEL_ID}',
    revision='${MODEL_REVISION}',
    cache_dir='${CACHE_DIR}',
)
print(model_dir)
PY
