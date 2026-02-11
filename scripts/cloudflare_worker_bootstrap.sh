#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKER_DIR="${ROOT_DIR}/edge/worker"

BUCKET_NAME="${BUCKET_NAME:-interview-feedback-results}"
INFERENCE_BASE_URL="${INFERENCE_BASE_URL:-}"
INFERENCE_API_KEY="${INFERENCE_API_KEY:-}"

usage() {
  cat <<USAGE
Usage:
  ${0##*/} --inference-base-url <https://api.example.com> [--inference-api-key <key>] [--bucket <name>]

Options:
  --inference-base-url   Required. Public base URL for inference service.
  --inference-api-key    Optional. If omitted, you will be prompted by wrangler.
  --bucket               R2 bucket name (default: ${BUCKET_NAME})
  -h, --help             Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --inference-base-url)
      INFERENCE_BASE_URL="$2"
      shift 2
      ;;
    --inference-api-key)
      INFERENCE_API_KEY="$2"
      shift 2
      ;;
    --bucket)
      BUCKET_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${INFERENCE_BASE_URL}" ]]; then
  echo "error: --inference-base-url is required" >&2
  usage
  exit 1
fi

command -v wrangler >/dev/null 2>&1 || {
  echo "error: wrangler is not installed. Run: npm i -g wrangler" >&2
  exit 1
}

if [[ ! -d "${WORKER_DIR}" ]]; then
  echo "error: worker directory not found at ${WORKER_DIR}" >&2
  exit 1
fi

cd "${WORKER_DIR}"

wrangler whoami >/dev/null

if wrangler r2 bucket create "${BUCKET_NAME}" >/dev/null 2>&1; then
  echo "R2 bucket created: ${BUCKET_NAME}"
else
  echo "R2 bucket create returned non-zero; checking if bucket already exists..."
  if wrangler r2 bucket list | grep -Fq "${BUCKET_NAME}"; then
    echo "R2 bucket already exists: ${BUCKET_NAME}"
  else
    echo "error: failed to create or locate R2 bucket ${BUCKET_NAME}" >&2
    exit 1
  fi
fi

printf '%s' "${INFERENCE_BASE_URL}" | wrangler secret put INFERENCE_BASE_URL >/dev/null

echo "Secret set: INFERENCE_BASE_URL"

if [[ -n "${INFERENCE_API_KEY}" ]]; then
  printf '%s' "${INFERENCE_API_KEY}" | wrangler secret put INFERENCE_API_KEY >/dev/null
  echo "Secret set: INFERENCE_API_KEY"
else
  echo "INFERENCE_API_KEY not provided. Run manually if needed:"
  echo "  wrangler secret put INFERENCE_API_KEY"
fi

echo
echo "Cloudflare worker bootstrap complete."
echo "Next steps:"
echo "  cd ${WORKER_DIR}"
echo "  npm run dev"
echo "  npm run deploy"
