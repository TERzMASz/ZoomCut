#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) PLATFORM="darwin-arm64" ;;
  x86_64) PLATFORM="darwin-x64" ;;
  *) echo "Unsupported macOS arch: $ARCH" >&2; exit 1 ;;
esac

DEST="$ROOT/resources/bin/$PLATFORM"
mkdir -p "$DEST"

copy_bin() {
  local name="$1"
  local src="${2:-}"
  if [[ -z "$src" ]]; then src="$(command -v "$name" || true)"; fi
  if [[ -z "$src" || ! -x "$src" ]]; then
    echo "⚠ $name not found; install it on the build machine before packaging"
    return 1
  fi
  cp "$src" "$DEST/$name"
  chmod 755 "$DEST/$name"
  echo "✓ staged $name from $src"
}

copy_homebrew_dylibs() {
  local bin="$1"
  local lib_dest="$DEST/lib"
  mkdir -p "$lib_dest"
  otool -L "$bin" | awk '/\/opt\/homebrew|\/usr\/local/ {print $1}' | while read -r dylib; do
    [[ -f "$dylib" ]] || continue
    cp -n "$dylib" "$lib_dest/" || true
    echo "✓ staged dylib $(basename "$dylib")"
  done
}

copy_scrcpy_server() {
  local prefixes=("/opt/homebrew" "/usr/local")
  for p in "${prefixes[@]}"; do
    local server
    server="$(find "$p" -path '*scrcpy*' -name 'scrcpy-server*' -type f 2>/dev/null | head -1 || true)"
    if [[ -n "$server" ]]; then
      cp "$server" "$DEST/scrcpy-server"
      chmod 644 "$DEST/scrcpy-server"
      echo "✓ staged scrcpy-server from $server"
      return 0
    fi
  done
  echo "⚠ scrcpy-server not found; bundled scrcpy may not run without it"
  return 1
}

copy_bin adb || true
if copy_bin scrcpy; then
  copy_homebrew_dylibs "$DEST/scrcpy" || true
  copy_scrcpy_server || true
fi

echo "Android tool staging complete: $DEST"
