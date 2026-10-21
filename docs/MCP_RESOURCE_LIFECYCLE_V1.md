# MCP cached export lifecycle, local v1

## Contract

An authorized export produces an immutable snapshot at the returned document/session/revision. Existing resource URLs are not live reads and never acquire a later document. This increment tightens the **server-side** cache lifetime to the intersection of MCP session and its associated terminal backend authorization lifetime. It does not revoke, erase or recall bytes already delivered, handed to stdout, or saved independently by a client. A resource response is accepted when its immutable result is constructed while the terminal checks pass. Responses already computed/accepted before the observed terminal event are not retroactively removed from the later promise/stdout pipeline.

The socket backend already treats every `fail()` as permanent: `closed=true`, pending requests reject, socket destroyed, no automatic reconnect. Its private AbortController now exposes only a read-only terminalSignal. The JSON-RPC client supplies neither controller nor signal, and there is no new credential/token/URI permission system. Only the server bound to that backend subscribes. Backends without this optional trusted-host signal keep their current MCP-session-only lifetime.

On terminal signal, the server synchronously clears its own ArtifactResources cache. Subsequent resources/list and resources/read, including the capabilities resource, return JSON-RPC -32000 with an ended-authorization message, not success with empty content. Unknown/evicted URIs while live still return -32002. A backend result completing after termination cannot be projected into fresh resources. Discovery rechecks the signal after awaiting the backend. MCP remains open for explicit errors and ping, without restoring design authority. MCP close unregisters the signal listener and retains its existing clear/abort/close lifecycle. A newly authorized backend/server starts empty; prior URIs do not transfer.

The boundary begins when the local backend observes its terminal socket event. It is not a synchronous cross-process revocation guarantee and cannot withdraw already emitted output. No changes to desktop grant logic, request schemas, scopes, expected-revision fences, mutation/retry semantics, rendering, native model, OS clipboard, remote exposure or authentication are included.

## Source chain

- frontend/design-client/src/automation/bridge.ts: document/session replacement clears renderer-local artifacts and updates registered editor identity.
- frontend/design-desktop/src/automation-bridge.mjs: setEditor detects document/session changes; close synchronously drops active authority, aborts pending requests and destroys associated sockets. Disable/window shutdown also use this close lifecycle.
- frontend/design-mcp/src/socket-backend.mjs: socket end/close/error and protocol failures all reach the same terminal fail path.
- frontend/design-mcp/src/server.mjs: one optional signal subscription; own-cache clear; resource/discovery guards; post-await, pre-projection late-result guard.

## Evidence boundary

The dedicated resource-lifecycle test uses the actual LocalAutomationBridge authentication/revocation implementation, actual SocketDesignBackend, actual DesignMcpServer, NDJSON and paired in-memory byte streams. The injected transport avoids OS socket creation and is explicitly not evidence for Unix permissions, Windows/macOS named pipes, native confirmation UI or external AI-client interoperability. Export payloads are inert synthetic text, not renderer output.

The same executable negative controls can load an untouched baseline through RESOURCE_LIFECYCLE_MODULE_ROOT; they print exact canonical source paths and SHA-256 hashes. Baseline failures are retained, not converted to skips. Normal resource bytes must remain identical. Follow-up coverage includes already-terminal construction, late backend completion, capabilities await, server isolation/re-authorization, listener cleanup, repeated terminal/close calls and optional-backend compatibility. Executed results belong in the accompanying verification records; source coverage alone is not a runtime acceptance claim.
