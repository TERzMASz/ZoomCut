#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="4.0"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    PLATFORM="darwin-arm64"
    RELEASE_ARCH="aarch64"
    SHA256="f5167fe047fe4a2ae2c2ea8634c7145a4d64d0b6005f24bb45639a965b8c60d4"
    ;;
  x86_64)
    PLATFORM="darwin-x64"
    RELEASE_ARCH="x86_64"
    SHA256="b83169f856d7022ed0e4428d98acea18dde2d63f49611b52ea137577ce4efe6b"
    ;;
  *) echo "Unsupported macOS arch: $ARCH" >&2; exit 1 ;;
esac

NAME="scrcpy-macos-${RELEASE_ARCH}-v${VERSION}"
URL="https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/${NAME}.tar.gz"
CACHE_DIR="${ZOOMCUT_RUNTIME_CACHE:-$ROOT/.cache/runtime}"
ARCHIVE="${ZOOMCUT_ANDROID_ARCHIVE:-$CACHE_DIR/${NAME}.tar.gz}"
DEST="$ROOT/resources/bin/$PLATFORM"
mkdir -p "$CACHE_DIR" "$DEST"

verify_archive() {
  [[ -f "$ARCHIVE" ]] && [[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" == "$SHA256" ]]
}

if ! verify_archive; then
  [[ -z "${ZOOMCUT_ANDROID_ARCHIVE:-}" ]] || { echo "Android runtime archive checksum mismatch: $ARCHIVE" >&2; exit 1; }
  download="$ARCHIVE.download"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "$download" "$URL"
  actual="$(shasum -a 256 "$download" | awk '{print $1}')"
  [[ "$actual" == "$SHA256" ]] || { echo "Android runtime checksum mismatch: expected $SHA256, got $actual" >&2; exit 1; }
  mv "$download" "$ARCHIVE"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/zoomcut-android-tools.XXXXXX")"
trap 'rm -rf "$work"' EXIT
tar -xzf "$ARCHIVE" -C "$work"
source_dir="$work/$NAME"
for required in adb scrcpy scrcpy-server; do
  [[ -f "$source_dir/$required" ]] || { echo "Official scrcpy archive is missing $required" >&2; exit 1; }
  cp "$source_dir/$required" "$DEST/$required"
done
for asset in scrcpy.png disconnected.png; do
  [[ -f "$source_dir/$asset" ]] && cp "$source_dir/$asset" "$DEST/$asset"
done
chmod 755 "$DEST/adb" "$DEST/scrcpy"
chmod 644 "$DEST/scrcpy-server" "$DEST"/*.png 2>/dev/null || true

"$DEST/adb" version >/dev/null
"$DEST/scrcpy" --version >/dev/null
echo "Staged official scrcpy $VERSION portable runtime for $PLATFORM (SHA-256 verified)"
