# Opt-in native render FRB1 transport

## Selection and compatibility

The desktop defaults to the existing JSON-lines protocol and still chooses the existing rendering backend. Only `CORE_NATIVE_RENDER_PROTOCOL=frb1` makes the active desktop host pass `--serve-protocol frb1` to `design-render`. An unknown explicit value fails closed. The binary accepts `--serve-protocol json` explicitly as well. This transport setting does not select the native renderer or change the normal canvas renderer.

The legacy TypeScript Electron helpers remain JSON clients. No change is made to Electron main/preload registration, preparation/FPR1 allocation, GPU shaders, geometry, sampling, color, readback, resource pooling, or resource lifetimes.

## Commands

Commands remain UTF-8 JSON with one final LF. In FRB1 mode every command additionally contains:

- `session`: 1–64 ASCII letters/digits/hyphens; the desktop generates one UUID for each owned child process
- `id`: positive JavaScript-safe integer, strictly increasing within that session

The Rust process rejects absent/invalid/session-changing/replayed identities and truncated or oversized lines. A maximum 64 MiB command (excluding its final LF) matches the desktop request cap. There is no cross-session state or automatic protocol fallback. An older binary that does not understand the explicit option exits, causing pending work to reject.

Existing load/frame/stats arguments and frame pan/damage behavior are preserved. This change does not introduce a new document version or scene fingerprint. A subsequent load stays in the same process session but has a later request ID, and FIFO serialization preserves ownership.

## Responses

Each reply is exactly:

1. Four ASCII bytes `FRB1`
2. A little-endian u32 JSON metadata byte length
3. A little-endian u32 pixel byte length
4. UTF-8 JSON metadata
5. Raw RGBA8 bytes, for frame success only

Metadata is nonempty and at most 64 KiB. Pixels are at most 48 MiB. A successful frame metadata object contains the unchanged `type`, `width`, `height`, `stats`, plus `session`, `id`, and `encoding: "rgba8"`. The `rgba` field is absent on the wire. Pixel length must exactly equal positive integer width × height × 4. No float quantization, channel conversion, alpha conversion, or color conversion occurs.

Loaded/stats/error metadata preserve their previous fields and add the identity. Their raw payload length is zero and encoding is absent. Application errors remain request-scoped, reject the matching request, and allow the next queued request to proceed. Transport errors (bad magic, version, identity, type, encoding, lengths, or extra bytes) retire the child and reject all outstanding requests.

## Ownership, bounds, cancellation

The desktop retains bounded input chunks until the complete response is available, validates metadata and identity, and then copies pixels into a safe, exact-sized `Uint8Array`. Its byte offset is zero, its backing size is exactly the RGBA length, and it cannot expose unrelated Buffer slab bytes. Input storage and the owned output coexist during decode; this is not a streaming allocation optimization. The chunk count is additionally capped at 65,536.

The existing single-in-flight FIFO, eight-request maximum, 96 MiB aggregate request budget, stdin backpressure, 120-second request deadline, and final-stdout-before-close boundary are preserved. A deadline or stop cancels active and queued requests, drops partial input, and retires the child (SIGTERM followed by the existing SIGKILL fallback). Owner destruction and full navigation continue to retire their child.

Electron `invoke` receives an explicit `encoding: "rgba8"` and the owned typed array. It still uses structured cloning; this is not a zero-copy Electron transport. The client accepts explicit binary or legacy base64 only and verifies dimensions. Real Node Worker transfer/detachment tests establish allocation ownership, not actual Electron context-bridge behavior.

## Evidence boundary

Codec tests, CPU synthetic timings, OS stdio fixtures, and actual `--backend cpu` tests do not demonstrate native GPU execution, GPU readback savings, FPS improvement, browser smoothness, Electron IPC timings, macOS/Windows behavior, or device-loss handling. Native GPU/browser execution remains unrun by design.

Potential future staging/upload pools and persistent curve data could avoid some allocations or rebuilds, but they remain unimplemented and unverified. They require device/fence/cancellation/lifetime and memory-ledger tests plus actual GPU measurements before any performance conclusion.
