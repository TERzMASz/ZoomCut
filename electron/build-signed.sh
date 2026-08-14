#!/bin/bash
# Build + เซ็นด้วย self-signed cert ที่ identity คงที่ + ทำ DMG
# ใช้ cert เดิมทุกครั้ง → สิทธิ์ Screen Recording/Input Monitoring ไม่หลุดเวลาอัปเดต
set -e
cd "$(dirname "$0")/.."

IDENTITY="${ZOOMCUT_SIGN_IDENTITY:-ZoomCut Beta Self-Signed}"
VERSION=$(node -p "require('./package.json').version")
DMG="dist/ZoomCut-${VERSION}-arm64.dmg"
ENTITLEMENTS="electron/entitlements.mac.plist"
if [[ "$IDENTITY" == "ZoomCut Beta Self-Signed" ]]; then ENTITLEMENTS="electron/entitlements.beta.plist"; fi

if [[ "${ZOOMCUT_PUBLIC_RELEASE:-0}" == "1" ]]; then
  if [[ "$IDENTITY" == "ZoomCut Beta Self-Signed" ]]; then
    echo "Public releases require an Apple Developer ID Application identity" >&2
    exit 1
  fi
  if [[ "${ZOOMCUT_NOTARIZE:-0}" != "1" ]]; then
    echo "Public releases require ZOOMCUT_NOTARIZE=1" >&2
    exit 1
  fi
fi

echo "▶ building…"
npm run qa
ZOOMCUT_REQUIRE_RUNTIME_TOOLS=1 npm run stage:runtime-tools
npm run dist:mac >/dev/null 2>&1 || npm run dist:mac

echo "▶ signing with stable identity: $IDENTITY"
APP="dist/mac-arm64/ZoomCut.app"
BASE_SIGN_ARGS=(--force --options runtime --sign "$IDENTITY")
if [[ "$IDENTITY" != "ZoomCut Beta Self-Signed" ]]; then BASE_SIGN_ARGS+=(--timestamp); fi

# Sign every nested executable with the same identity before sealing its bundle.
# This lets us keep library validation enabled without inheriting Electron's upstream Team ID.
while IFS= read -r -d '' binary; do
  if file "$binary" | grep -q 'Mach-O'; then codesign "${BASE_SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$binary"; fi
done < <(find "$APP/Contents" -type f -print0)

while IFS= read -r bundle; do
  codesign "${BASE_SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$bundle"
done < <(find "$APP/Contents" \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -type d | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)

codesign "${BASE_SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict "dist/mac-arm64/ZoomCut.app"

echo "▶ packaging DMG…"
rm -f "$DMG"*
STAGE=$(mktemp -d)
cp -R "dist/mac-arm64/ZoomCut.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "ZoomCut" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
DMG_SIGN_ARGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != "ZoomCut Beta Self-Signed" ]]; then DMG_SIGN_ARGS+=(--timestamp); fi
codesign "${DMG_SIGN_ARGS[@]}" "$DMG"

if [[ "${ZOOMCUT_NOTARIZE:-0}" == "1" ]]; then
  : "${APPLE_ID:?APPLE_ID is required}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature -v "$DMG"
fi

echo "✅ $DMG"
codesign -d --requirements - "dist/mac-arm64/ZoomCut.app" 2>&1 | grep designated || true
