#!/bin/bash
# Build + เซ็นด้วย self-signed cert ที่ identity คงที่ + ทำ DMG
# ใช้ cert เดิมทุกครั้ง → สิทธิ์ Screen Recording/Input Monitoring ไม่หลุดเวลาอัปเดต
set -e
cd "$(dirname "$0")/.."

IDENTITY="${ZOOMCUT_SIGN_IDENTITY:-ZoomCut Beta Self-Signed}"
VERSION=$(node -p "require('./package.json').version")
DMG="dist/ZoomCut-${VERSION}-arm64.dmg"

echo "▶ building…"
npm run qa
npm run stage:runtime-tools
npm run dist:mac >/dev/null 2>&1 || npm run dist:mac

echo "▶ signing with stable identity: $IDENTITY"
SIGN_ARGS=(--deep --force --options runtime --entitlements electron/entitlements.mac.plist --sign "$IDENTITY")
if [[ "$IDENTITY" != "ZoomCut Beta Self-Signed" ]]; then SIGN_ARGS+=(--timestamp); fi
codesign "${SIGN_ARGS[@]}" "dist/mac-arm64/ZoomCut.app"
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
fi

echo "✅ $DMG"
codesign -d --requirements - "dist/mac-arm64/ZoomCut.app" 2>&1 | grep designated || true
