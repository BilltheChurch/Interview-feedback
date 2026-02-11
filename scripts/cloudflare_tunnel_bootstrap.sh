#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TUNNEL_NAME="${TUNNEL_NAME:-interview-inference}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}"
ORIGIN_URL="${ORIGIN_URL:-http://localhost:8000}"
CONFIG_PATH="${CONFIG_PATH:-${ROOT_DIR}/cloudflare/tunnel/config.yml}"

usage() {
  cat <<USAGE
Usage:
  ${0##*/} --hostname <api.example.com> [--name <tunnel-name>] [--origin <url>] [--config <path>]

Options:
  --hostname   Public DNS hostname routed to this tunnel (required)
  --name       Tunnel name (default: ${TUNNEL_NAME})
  --origin     Local origin service URL (default: ${ORIGIN_URL})
  --config     Output config file path (default: ${CONFIG_PATH})
  -h, --help   Show this message

Environment overrides:
  TUNNEL_NAME, TUNNEL_HOSTNAME, ORIGIN_URL, CONFIG_PATH
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)
      TUNNEL_HOSTNAME="$2"
      shift 2
      ;;
    --name)
      TUNNEL_NAME="$2"
      shift 2
      ;;
    --origin)
      ORIGIN_URL="$2"
      shift 2
      ;;
    --config)
      CONFIG_PATH="$2"
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

if [[ -z "${TUNNEL_HOSTNAME}" ]]; then
  echo "error: --hostname is required" >&2
  usage
  exit 1
fi

command -v cloudflared >/dev/null 2>&1 || {
  echo "error: cloudflared is not installed. Run: brew install cloudflared" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "error: python3 is required for parsing cloudflared output" >&2
  exit 1
}

if ! cloudflared tunnel list --output json >/dev/null 2>&1; then
  echo "error: cloudflared is not authenticated. Run: cloudflared tunnel login" >&2
  exit 1
fi

get_tunnel_uuid() {
  local json_output
  json_output="$(cloudflared tunnel list --output json 2>/dev/null || true)"
  python3 - "$1" "$json_output" <<'PY'
import json
import sys

name = sys.argv[1]
raw = sys.argv[2].strip()
if not raw:
    raise SystemExit(0)

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(0)

if not data:
    raise SystemExit(0)

for item in data:
    if isinstance(item, dict) and item.get("name") == name:
        print(item.get("id", ""))
        break
PY
}

TUNNEL_UUID="$(get_tunnel_uuid "${TUNNEL_NAME}")"
if [[ -z "${TUNNEL_UUID}" ]]; then
  echo "Creating tunnel: ${TUNNEL_NAME}"
  cloudflared tunnel create "${TUNNEL_NAME}"
  TUNNEL_UUID="$(get_tunnel_uuid "${TUNNEL_NAME}")"
fi

if [[ -z "${TUNNEL_UUID}" ]]; then
  echo "error: failed to resolve tunnel UUID for ${TUNNEL_NAME}" >&2
  exit 1
fi

CREDENTIALS_FILE="${HOME}/.cloudflared/${TUNNEL_UUID}.json"
if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  echo "error: tunnel credentials file not found at ${CREDENTIALS_FILE}" >&2
  echo "Please verify cloudflared login state and tunnel creation output." >&2
  exit 1
fi

if cloudflared tunnel route dns "${TUNNEL_NAME}" "${TUNNEL_HOSTNAME}" >/dev/null 2>&1; then
  echo "DNS route created: ${TUNNEL_HOSTNAME} -> ${TUNNEL_NAME}"
else
  if cloudflared tunnel route list | grep -Fq "${TUNNEL_HOSTNAME}"; then
    echo "DNS route already exists for hostname: ${TUNNEL_HOSTNAME}"
  else
    echo "error: failed to create DNS route for ${TUNNEL_HOSTNAME}" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "${CONFIG_PATH}")"
cat > "${CONFIG_PATH}" <<CFG
tunnel: ${TUNNEL_UUID}
credentials-file: ${CREDENTIALS_FILE}

ingress:
  - hostname: ${TUNNEL_HOSTNAME}
    service: ${ORIGIN_URL}
  - service: http_status:404
CFG

chmod 600 "${CONFIG_PATH}"

echo
echo "Tunnel bootstrap complete"
echo "  tunnel_name:      ${TUNNEL_NAME}"
echo "  tunnel_uuid:      ${TUNNEL_UUID}"
echo "  hostname:         ${TUNNEL_HOSTNAME}"
echo "  origin:           ${ORIGIN_URL}"
echo "  credentials_file: ${CREDENTIALS_FILE}"
echo "  config_file:      ${CONFIG_PATH}"
echo
echo "Run tunnel with:"
echo "  ${ROOT_DIR}/scripts/cloudflare_tunnel_run.sh --config ${CONFIG_PATH}"
