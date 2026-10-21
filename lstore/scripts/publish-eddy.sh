#!/bin/sh
set -eu

VERSION=${1:-}
NOTES=${2:-"Eddy ${1:-} release"}
LSTORE_URL=${LSTORE_URL:-}
LSTORE_ADMIN_TOKEN=${LSTORE_ADMIN_TOKEN:-}

if [ -z "$VERSION" ] || [ -z "$LSTORE_URL" ]; then
  echo "Usage: LSTORE_URL=http://localhost:3000 $0 VERSION \"release notes\"" >&2
  exit 2
fi

case "$LSTORE_URL" in
  https://*) ;;
  http://localhost:*) ;;
  http://127.0.0.1:*) ;;
  *)
    echo "LSTORE_URL must use HTTPS or localhost." >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "$LSTORE_ADMIN_TOKEN" ] && [ -r "$SCRIPT_DIR/../data/admin-token" ]; then
  LSTORE_ADMIN_TOKEN=$(cat "$SCRIPT_DIR/../data/admin-token")
fi
if [ -z "$LSTORE_ADMIN_TOKEN" ]; then
  echo "Start LStore first so its admin token exists, or set LSTORE_ADMIN_TOKEN." >&2
  exit 2
fi

SIGNING_KEY_PATH=${TAURI_SIGNING_PRIVATE_KEY_PATH:-"$HOME/.tauri/eddy.key"}
if [ ! -r "$SIGNING_KEY_PATH" ]; then
  echo "Private signing key not readable at $SIGNING_KEY_PATH." >&2
  exit 2
fi

python3 - "$VERSION" <<'PY'
import re
import sys

if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", sys.argv[1]):
    raise SystemExit("Version must look like 1.2.3 or 1.2.3-beta.1.")
PY

ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

python3 - "$VERSION" <<'PY'
import json
import re
import sys

version = sys.argv[1]
package_path = "package.json"
with open(package_path, encoding="utf-8") as file:
    package = json.load(file)
package["version"] = version
with open(package_path, "w", encoding="utf-8") as file:
    json.dump(package, file, indent=2)
    file.write("\n")

lock_path = "package-lock.json"
with open(lock_path, encoding="utf-8") as file:
    lock = json.load(file)
lock["version"] = version
lock["packages"][""]["version"] = version
with open(lock_path, "w", encoding="utf-8") as file:
    json.dump(lock, file, indent=2)
    file.write("\n")

cargo_path = "src-tauri/Cargo.toml"
with open(cargo_path, encoding="utf-8") as file:
    cargo = file.read()
cargo, count = re.subn(r'(?m)^version = "[^"]+"$', f'version = "{version}"', cargo, count=1)
if count != 1:
    raise SystemExit("Could not update the Eddy version in src-tauri/Cargo.toml.")
with open(cargo_path, "w", encoding="utf-8") as file:
    file.write(cargo)

tauri_path = "src-tauri/tauri.conf.json"
with open(tauri_path, encoding="utf-8") as file:
    tauri = json.load(file)
tauri["version"] = version
with open(tauri_path, "w", encoding="utf-8") as file:
    json.dump(tauri, file, indent=2)
    file.write("\n")
PY

CONFIG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/eddy-tauri-config.XXXXXX")
CONFIG_FILE="$CONFIG_DIR/config.json"
DMG_STAGE=
DMG_MOUNT=
cleanup() {
  if [ -n "$DMG_MOUNT" ]; then
    hdiutil detach "$DMG_MOUNT" >/dev/null 2>&1 || true
  fi
  rm -rf "$CONFIG_DIR"
  if [ -n "$DMG_STAGE" ]; then
    rm -rf "$DMG_STAGE"
  fi
  if [ -n "$DMG_MOUNT" ]; then
    rm -rf "$DMG_MOUNT"
  fi
}
trap cleanup EXIT HUP INT TERM

python3 - "$CONFIG_FILE" "$LSTORE_URL" <<'PY'
import json
import sys

path, base_url = sys.argv[1:]
with open(path, "w", encoding="utf-8") as file:
    json.dump({
        "plugins": {
            "updater": {
                "endpoints": [base_url.rstrip("/") + "/api/apps/eddy/latest.json"]
            }
        }
    }, file)
PY

npm run tauri -- build --target aarch64-apple-darwin --bundles app --no-sign --config "$CONFIG_FILE"

APP_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle/macos"
APP_BUNDLE="$APP_DIR/Eddy.app"
ARTIFACT="$APP_DIR/Eddy.app.tar.gz"
SIGNATURE="${ARTIFACT}.sig"
DMG_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"

if [ ! -d "$APP_BUNDLE" ]; then
  echo "Tauri did not produce Eddy.app." >&2
  exit 1
fi

codesign --force --deep --sign - --timestamp=none "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"

rm -f "$ARTIFACT" "$SIGNATURE"
tar -czf "$ARTIFACT" -C "$APP_DIR" Eddy.app
npm run tauri -- signer sign --private-key-path "$SIGNING_KEY_PATH" \
  --app-version "$VERSION" "$ARTIFACT"

if [ ! -f "$ARTIFACT" ] || [ ! -f "$SIGNATURE" ]; then
  echo "Tauri did not produce the signed updater archive and signature." >&2
  exit 1
fi

mkdir -p "$DMG_DIR"
INSTALLER="$DMG_DIR/Eddy_${VERSION}_aarch64.dmg"
DMG_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/eddy-dmg-stage.XXXXXX")
DMG_MOUNT=$(mktemp -d "${TMPDIR:-/tmp}/eddy-dmg-mount.XXXXXX")
ditto "$APP_BUNDLE" "$DMG_STAGE/Eddy.app"
ln -s /Applications "$DMG_STAGE/Applications"
rm -f "$INSTALLER"
hdiutil create -volname "Eddy $VERSION" -srcfolder "$DMG_STAGE" \
  -format UDZO -ov "$INSTALLER"
hdiutil attach "$INSTALLER" -nobrowse -readonly -mountpoint "$DMG_MOUNT" >/dev/null
if ! CODESIGN_STATUS=$(codesign --verify --deep --strict "$DMG_MOUNT/Eddy.app" 2>&1); then
  echo "Eddy.app inside the installer did not pass macOS code-signature validation: $CODESIGN_STATUS" >&2
  exit 1
fi
hdiutil detach "$DMG_MOUNT" >/dev/null
rm -rf "$DMG_MOUNT"
DMG_MOUNT=

if [ -n "$INSTALLER" ]; then
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $LSTORE_ADMIN_TOKEN" \
    -F "appId=eddy" \
    -F "version=$VERSION" \
    --form-string "notes=$NOTES" \
    -F "platform=darwin-aarch64" \
    --form-string "signature=$(cat "$SIGNATURE")" \
    -F "artifact=@$ARTIFACT;type=application/gzip" \
    -F "installer=@$INSTALLER;type=application/x-apple-diskimage" \
    "$LSTORE_URL/api/releases"
else
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $LSTORE_ADMIN_TOKEN" \
    -F "appId=eddy" \
    -F "version=$VERSION" \
    --form-string "notes=$NOTES" \
    -F "platform=darwin-aarch64" \
    --form-string "signature=$(cat "$SIGNATURE")" \
    -F "artifact=@$ARTIFACT;type=application/gzip" \
    "$LSTORE_URL/api/releases"
fi

printf '\nPublished Eddy %s to %s\n' "$VERSION" "$LSTORE_URL"
