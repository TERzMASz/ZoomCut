# ADR-001: Durable projects and bounded export I/O

**Status:** Accepted
**Date:** 2026-07-22

## Context

ZoomCut previously kept the complete edit in renderer memory and sent the complete MediaRecorder export to the local server as a Buffer. Closing the app lost the edit, while long or high-resolution exports could exhaust memory.

## Decision

- Store editable state in a versioned `.zoomcut` JSON document.
- Keep imported media as filesystem references and content-address recorded voice/camera assets under Electron `userData`.
- Autosave atomically and offer recovery plus missing-media relink.
- Keep pure project/timeline rules in `shared/editor-core.js` for browser and Node tests.
- Stream export uploads to a private temporary file, run FFmpeg against files, and stream or write the result directly to the user-selected destination.
- Protect local APIs with a per-launch random token and protect filesystem access with opaque media/export registries.

## Consequences

- Projects remain small and recoverable, but moving source media requires relinking.
- Export memory no longer scales with the encoded file size in the backend.
- Recorded camera/voice assets remain managed application data until a future project-package format is introduced.
- The current canvas renderer is still real-time; a fully deterministic frame server can replace it later without changing the project schema.
