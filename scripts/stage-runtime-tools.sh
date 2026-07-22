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
LIB_DEST="$DEST/lib"
mkdir -p "$DEST" "$LIB_DEST"

missing=0
copy_tool() {
  local name="$1" src
  src="$(command -v "$name" || true)"
  if [[ -z "$src" || ! -x "$src" ]]; then
    echo "WARN: $name is not installed on the build machine"
    missing=$((missing + 1))
    return
  fi
  cp "$src" "$DEST/$name"
  chmod 755 "$DEST/$name"
  echo "staged $name from $src"
}

copy_dependencies() {
  local item="$1" dependency target
  [[ -f "$item" ]] || return
  while IFS= read -r dependency; do
    [[ "$dependency" == /opt/homebrew/* || "$dependency" == /usr/local/* ]] || continue
    [[ -f "$dependency" ]] || continue
    target="$LIB_DEST/$(basename "$dependency")"
    if [[ ! -f "$target" ]]; then
      cp "$dependency" "$target"
      chmod 755 "$target"
      copy_dependencies "$dependency"
    fi
  done < <(otool -L "$item" | tail -n +2 | awk '{print $1}')
}

copy_tool ffmpeg
copy_tool ffprobe
bash "$ROOT/scripts/stage-android-tools.sh"

for tool in ffmpeg ffprobe adb scrcpy; do
  [[ -f "$DEST/$tool" ]] && copy_dependencies "$DEST/$tool"
done
for library in "$LIB_DEST"/*; do
  [[ -f "$library" ]] && copy_dependencies "$library"
done

rewrite_dependencies() {
  local item="$1" dependency replacement
  [[ -f "$item" ]] || return
  while IFS= read -r dependency; do
    [[ "$dependency" == /opt/homebrew/* || "$dependency" == /usr/local/* ]] || continue
    if [[ "$item" == "$LIB_DEST/"* ]]; then replacement="@loader_path/$(basename "$dependency")";
    else replacement="@loader_path/lib/$(basename "$dependency")"; fi
    install_name_tool -change "$dependency" "$replacement" "$item" 2>/dev/null
  done < <(otool -L "$item" | tail -n +2 | awk '{print $1}')
}
for tool in ffmpeg ffprobe adb scrcpy; do
  [[ -f "$DEST/$tool" ]] && rewrite_dependencies "$DEST/$tool"
done
for library in "$LIB_DEST"/*; do
  [[ -f "$library" ]] && rewrite_dependencies "$library"
done
for item in "$DEST/ffmpeg" "$DEST/ffprobe" "$DEST/adb" "$DEST/scrcpy" "$LIB_DEST"/*; do
  [[ -f "$item" ]] && codesign --force --sign - "$item" >/dev/null 2>&1
done

manifest="$ROOT/resources/runtime-manifest.txt"
{
  echo "ZoomCut bundled runtime manifest"
  echo "platform=$PLATFORM"
  echo "generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  find "$DEST" -type f -print0 | sort -z | while IFS= read -r -d '' file; do
    echo "$(shasum -a 256 "$file" | awk '{print $1}')  ${file#$ROOT/resources/}"
  done
} > "$manifest"

if [[ "${ZOOMCUT_REQUIRE_RUNTIME_TOOLS:-0}" == "1" ]]; then
  for required in ffmpeg ffprobe adb scrcpy scrcpy-server; do
    if [[ ! -f "$DEST/$required" ]]; then echo "ERROR: required bundled tool missing: $required" >&2; exit 1; fi
  done
fi
echo "Runtime staging complete: $DEST"
