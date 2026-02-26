#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-opensource}"
ARCH="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Backup existing .env if present
if [ -f .env ]; then
  cp .env .env.dev-backup
  echo "Backed up .env → .env.dev-backup"
fi

# Select .env variant
if [ "$VARIANT" = "production" ]; then
  echo "Building COMMERCIAL variant..."
  cp .env.production .env
elif [ "$VARIANT" = "opensource" ]; then
  echo "Building OPEN-SOURCE variant..."
  cp .env.opensource .env
else
  echo "Usage: build.sh [opensource|production] [arm64|x64]"
  exit 1
fi

# Restore .env after build completes (or on error)
restore_env() {
  if [ -f .env.dev-backup ]; then
    mv .env.dev-backup .env
    echo "Restored .env from backup"
  fi
}
trap restore_env EXIT

# Build React app
echo "Building React app..."
npx vite build

# Build Electron DMG
if [ -n "$ARCH" ]; then
  echo "Building Electron DMG for arch=$ARCH..."
  npx electron-builder --mac --$ARCH
else
  echo "Building Electron DMG (all configured architectures)..."
  npx electron-builder --mac
fi

echo ""
echo "Build complete! Output in release/"
ls -lh release/*.dmg 2>/dev/null || echo "(no DMG files found)"
