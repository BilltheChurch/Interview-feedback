#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_PATH="${CONFIG_PATH:-${ROOT_DIR}/cloudflare/tunnel/config.yml}"

usage() {
  cat <<USAGE
Usage:
  ${0##*/} [--config <path>] [--name <tunnel-name>]

Options:
  --config   cloudflared config file path (default: ${CONFIG_PATH})
  --name     optional tunnel name override
  -h, --help show help
USAGE
}

TUNNEL_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --name)
      TUNNEL_NAME="$2"
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

command -v cloudflared >/dev/null 2>&1 || {
  echo "error: cloudflared is not installed" >&2
  exit 1
}

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "error: config file not found at ${CONFIG_PATH}" >&2
  echo "Generate one with scripts/cloudflare_tunnel_bootstrap.sh" >&2
  exit 1
fi

if [[ -n "${TUNNEL_NAME}" ]]; then
  exec cloudflared tunnel --config "${CONFIG_PATH}" run "${TUNNEL_NAME}"
fi

exec cloudflared tunnel --config "${CONFIG_PATH}" run
