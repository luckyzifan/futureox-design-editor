# Local error diagnostics

Both Web and Electron use the same bounded error schema, capture hooks, and Settings → 错误日志 interface. The performance trace remains a separate opt-in in-memory tool.

- Records: timestamp, error/warning severity, allowlisted component and classification, application-generated local diagnostic request ID. Original error messages, stacks, document content, URLs, tokens, and file paths are never retained by this pipeline. IDs correlate local diagnostic records only; they are not backend transport request IDs.
- Capture: window errors/unhandled rejections, React root errors, and handled failures from the existing desktop invoke bridge. Other handled failures can call `recordLocalError(component, error, fallbackCode)` explicitly. Not every caught operation failure is automatically captured; console output is not intercepted.
- Web: current origin's `forma-local-errors-v1` localStorage entry. Browser settings can deny persistence or clear it. Multiple tabs use last-writer snapshots, not transactional merging.
- Electron: app profile's diagnostics/local-errors-v1.json, fixed-path IPC with the existing trusted-main-frame sender check. Files are atomically replaced from sanitized bounded snapshots. No renderer-selected filesystem path and no remote upload.
- 256 newest records, dropped-record counter; 128 KiB input ceiling; one pending timer and at most one in-flight write. New errors during a slow write collapse into one latest bounded snapshot. Write failures do not recursively log or automatically retry forever; a later error triggers another attempt.
- Writes are coalesced after 250 ms. Page hide requests a flush but does not guarantee delivery on crash or process termination. The last batch can be lost. Existing unrelated logs are untouched.
- Invalid/oversized old diagnostic data is rejected, exposes session-only status, and a subsequent error can replace it with a valid snapshot. No arbitrary text from corrupt records appears in export.
- JSON export is a user gesture using the current bounded memory snapshot; it includes dropped count. Download completion is not asserted.

Validation: Node CPU tests use real temporary files for persistence/recreation/oversize/privacy, mocked browser Storage/EventTarget boundaries for Web, and a VM mock for the sandbox preload. React UI is exercised in jsdom with the download boundary mocked. None of these tests assert GPU, native GUI, native download dialog, actual Electron restart, or socket behavior.
