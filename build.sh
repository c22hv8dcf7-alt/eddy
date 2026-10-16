#!/usr/bin/env bash
#
# build.sh — package Eddy as a macOS desktop app.
#
# The app is already inside this folder (dist/index.html).
# This script just wraps it into Eddy.app + Eddy.dmg.
#
# Run from this folder:  ./build.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PROJECT_DIR/dist/index.html" ]; then
  echo "ERROR: dist/index.html is missing — the app files are not in this folder." >&2
  exit 1
fi

cd "$PROJECT_DIR"

# Self-healing setup: install JS deps and generate icons if they're missing,
# so a fresh unzip just works with ./build.sh and nothing else.
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Installing build tools (first run only, takes a couple minutes)..."
  npm install
fi
if [ ! -f "$PROJECT_DIR/src-tauri/icons/32x32.png" ]; then
  echo "Generating app icons..."
  npx tauri icon "$PROJECT_DIR/src-tauri/icons/icon.png"
fi

npx tauri build

# Camera permission: Tauri doesn't merge src-tauri/Info.plist into the built
# app on its own, so stamp NSCameraUsageDescription directly onto the bundle
# (this is the fix that got the webcam working in v1).
APP_PLIST="$PROJECT_DIR/src-tauri/target/release/bundle/macos/Eddy.app/Contents/Info.plist"
if [ -f "$APP_PLIST" ]; then
  CAM_MSG="Eddy uses the camera to capture tray photos and count organisms with a live view."
  /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string '$CAM_MSG'" "$APP_PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSCameraUsageDescription '$CAM_MSG'" "$APP_PLIST"
  echo "Camera permission stamped into Eddy.app"
else
  echo "WARNING: Eddy.app not found at expected path — camera permission NOT stamped." >&2
fi

echo ""
echo "Done. Find your app here:"
echo "  $PROJECT_DIR/src-tauri/target/release/bundle/dmg/   (Eddy.dmg)"
echo "  $PROJECT_DIR/src-tauri/target/release/bundle/macos/  (Eddy.app)"
