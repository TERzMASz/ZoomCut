# ZoomCut Security and Release Notes

## Local security boundary

- Electron uses `contextIsolation`, sandboxing, no Node integration, and a narrow preload bridge.
- Production packaging flips Electron fuses to disable RunAsNode, NODE_OPTIONS, and CLI inspect, and enables embedded ASAR integrity validation. Cookie encryption is disabled because ZoomCut does not persist cookies and the macOS implementation otherwise prompts for Keychain access on first launch.
- IPC handlers accept calls only from the main ZoomCut webContents.
- The HTTP server binds to `127.0.0.1` and every `/api/*` request requires a random per-launch token.
- Media and export paths are represented by random one-time registry IDs; renderer input cannot choose arbitrary output paths.
- Static paths use resolved containment checks, not string-prefix checks.
- JSON and export request bodies have limits. Export data streams to disk instead of being buffered completely in RAM.
- CSP, nosniff, same-origin resource policy, and restrictive permission handlers are enabled.
- Screen recording presents a persistent macOS menu-bar indicator with a Stop Recording command.

## Release gates

1. Run `npm run qa` and `npm audit`.
2. Run `ZOOMCUT_REQUIRE_RUNTIME_TOOLS=1 npm run stage:runtime-tools` on the release machine.
3. Verify `runtime-manifest.txt`, execute the staged tools, and scan the final app with `codesign --verify --deep --strict`.
4. For public distribution, sign with Apple Developer ID and notarize using `ZOOMCUT_NOTARIZE=1` plus the Apple credentials documented in `electron/build-signed.sh`.
5. Validate on a clean Apple Silicon Mac. Build and validate a separate x64 artifact for Intel support.
6. Review redistribution obligations for the exact FFmpeg build and Android Platform Tools. The Homebrew FFmpeg build currently staged on the development machine has GPL components enabled and is not an approved Mac App Store dependency.

## Known residual risks

- Canvas export still renders in real time and retains MediaRecorder chunks in renderer memory before streaming to the backend.
- Recorded voice/camera chunks are initially held by MediaRecorder before being persisted as content-addressed assets.
- Android touch capture needs real-device QA across vendors, rotation, disconnect, and permission changes.
- Self-signed beta builds are not notarized and will be rejected by Gatekeeper assessment.
- Mac App Store sandbox compatibility has not been established; global input monitoring, child executables, and external recording tools require a separate distribution decision.

Report security issues privately to the project owner. Do not include recordings, project files, or access tokens in public reports.
