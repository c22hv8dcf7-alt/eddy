#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "Node.js is required to build the LStore Mac app." >&2
  exit 1
fi
if [ ! -d "$ROOT/node_modules/express" ] || [ ! -d "$ROOT/node_modules/multer" ]; then
  echo "LStore dependencies are missing. Run: cd \"$ROOT\" && npm install" >&2
  exit 1
fi

mkdir -p "$HOME/Applications"
APP="$HOME/Applications/LStore.app"
if [ -e "$APP" ]; then
  osascript -e 'tell application id "com.eddy.lstore" to quit' >/dev/null 2>&1 || true
  sleep 1
  RUNNING_PID=$(pgrep -f "^$APP/Contents/MacOS/LStore$" || true)
  if [ -n "$RUNNING_PID" ]; then
    echo "Quit LStore before rebuilding its Mac app." >&2
    exit 1
  fi
  BACKUP="$HOME/Applications/.LStore.app.previous.$$"
  mv "$APP" "$BACKUP"
fi

DATA_DIR="$HOME/Library/Application Support/LStore/data"
mkdir -p "$DATA_DIR/releases"
if [ ! -f "$DATA_DIR/apps.json" ] && [ -f "$ROOT/data/apps.json" ]; then
  cp "$ROOT/data/apps.json" "$DATA_DIR/apps.json"
fi
if [ ! -f "$DATA_DIR/admin-token" ] && [ -f "$ROOT/data/admin-token" ]; then
  cp "$ROOT/data/admin-token" "$DATA_DIR/admin-token"
fi
if [ -d "$ROOT/data/releases" ]; then
  ditto "$ROOT/data/releases" "$DATA_DIR/releases"
fi
chmod 700 "$(dirname "$DATA_DIR")" "$DATA_DIR"
if [ -f "$DATA_DIR/admin-token" ]; then chmod 600 "$DATA_DIR/admin-token"; fi
if [ -f "$DATA_DIR/apps.json" ]; then chmod 600 "$DATA_DIR/apps.json"; fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/lstore-app.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT HUP INT TERM
CONTENTS="$STAGING/LStore.app/Contents"
RESOURCES="$CONTENTS/Resources"
SERVER_RESOURCES="$RESOURCES/LStoreServer"
mkdir -p "$CONTENTS/MacOS" "$SERVER_RESOURCES"

cp "$ROOT/server.js" "$SERVER_RESOURCES/server.js"
cp "$ROOT/coding-assistant.js" "$SERVER_RESOURCES/coding-assistant.js"
cp "$ROOT/app-studio.js" "$SERVER_RESOURCES/app-studio.js"
cp "$ROOT/local-vision.js" "$SERVER_RESOURCES/local-vision.js"
cp -R "$ROOT/templates" "$SERVER_RESOURCES/templates"
cp -R "$ROOT/public" "$SERVER_RESOURCES/public"
cp -R "$ROOT/node_modules" "$SERVER_RESOURCES/node_modules"
swiftc -parse-as-library -O -framework AppKit -framework Foundation -framework WebKit \
  -o "$CONTENTS/MacOS/LStore" "$ROOT/desktop/LStoreApp.swift"

ICONSET="$STAGING/LStore.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 64 128 256 512; do
  sips -s format png -z "$SIZE" "$SIZE" "$ROOT/public/lstore-logo.png" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  sips -s format png -z "$DOUBLE" "$DOUBLE" "$ROOT/public/lstore-logo.png" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/LStore.icns"

INFO="$CONTENTS/Info.plist"
cp "$ROOT/desktop/Info.plist" "$INFO"
/usr/libexec/PlistBuddy -c "Set :LStoreNodeExecutable $NODE" "$INFO"
/usr/libexec/PlistBuddy -c "Set :LStoreWorkspaceDirectory $ROOT/.." "$INFO"

codesign --force --deep --sign - --timestamp=none "$STAGING/LStore.app"
if ! ditto "$STAGING/LStore.app" "$APP"; then
  if [ -e "$APP" ]; then rm -r "$APP"; fi
  if [ -n "${BACKUP:-}" ]; then mv "$BACKUP" "$APP"; fi
  exit 1
fi
if ! codesign --verify --deep --strict "$APP"; then
  rm -r "$APP"
  if [ -n "${BACKUP:-}" ]; then mv "$BACKUP" "$APP"; fi
  exit 1
fi
if [ -n "${BACKUP:-}" ]; then rm -r "$BACKUP"; fi
open "$APP"

printf 'Installed LStore at %s\n' "$APP"
printf 'Release data stays in %s\n' "$DATA_DIR"
