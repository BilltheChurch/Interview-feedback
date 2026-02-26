#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-opensource}"
ARCH="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

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
