# ZoomCut release security

## Beta distribution

Internal beta builds may use the stable `ZoomCut Beta Self-Signed` identity so macOS permission grants survive upgrades. These builds are for known testers and are not notarized. Because a self-signed certificate has no Apple Team ID, this track uses `entitlements.beta.plist` to permit Electron's nested libraries.

Public beta builds must use an Apple Developer ID Application certificate and notarization:

```bash
ZOOMCUT_PUBLIC_RELEASE=1 \
ZOOMCUT_SIGN_IDENTITY="Developer ID Application: ..." \
ZOOMCUT_NOTARIZE=1 \
APPLE_ID="..." APPLE_APP_SPECIFIC_PASSWORD="..." APPLE_TEAM_ID="..." \
bash electron/build-signed.sh
```

The build script rejects a public release that uses the self-signed identity or skips notarization.
Developer ID builds use `entitlements.mac.plist`, which keeps library validation enabled.

## Mac App Store

The direct-download build is not currently a Mac App Store build. ZoomCut uses global input monitoring and the `screencapture` executable for click tracking and screen recording. A Mac App Store build requires App Sandbox and should replace those paths with sandbox-compatible Apple frameworks before submission. Do not submit the direct-download build as-is.

## Privacy

Recordings, projects, camera clips, voice-over audio, and click metadata stay on the user's Mac. ZoomCut does not upload them or include analytics. `resources/PrivacyInfo.xcprivacy` declares that no data is collected or used for tracking. Update the manifest before adding analytics, crash reporting, accounts, cloud storage, or networking that transfers user content.
