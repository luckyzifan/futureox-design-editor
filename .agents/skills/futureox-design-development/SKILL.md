---
name: futureox-design-development
description: Develop, review, or test this Futureox Design local-first editor, its Rust/WASM kernel, Electron host, FD format, or shared MCP operation API. Use for changes in this repository, not unrelated projects or remote design-service automation.
---

# Futureox Design development

Read [the v1 development contract](../../../docs/DEVELOPMENT_CONTRACT_V1.md) before architecture, storage, rendering, performance, or release changes. Read [the MCP operation guide](../../../docs/MCP_OPERATION_GUIDE_V1.md) for automation/discovery/schema changes; it routes to detailed maintained contracts.

- Target local v1.0.0. Do not add historical application compatibility machinery merely to preserve an unreleased implementation. Keep app, FD container, document schema, capability, storage and session versions separate; preserve current authored values and explicit forward-extension contracts.
- Web and Electron share UI and design semantics. Desktop adds local native acceleration/storage through adapters. Keep MCP thin: shared operation registry → isolated draft → authoritative Editor.change → Rust/WASM admission/layout/history. Never build a second document model, mutation engine, cloud-account backend or AI orchestrator.
- FD optional metadata is inert, bounded and losslessly preserved; required unsupported semantics reject. File contents cannot install handlers or grant permissions. Native whole-document open is different from MCP document.import append.
- Discover actual operation schemas and permission-filtered counts. Never invent Figma aliases, infer input units from UI percentages, or treat node.update whole-property arrays as granular leaf patches. Authorize batch wrappers and expanded leaves; preserve expected-value and document/session/revision fences.
- Keep immutable snapshots across awaits, storage CAS separate from editor revisions, append-only durable restore separate from editing undo, and exact retry receipts separate from rollback promises. SQLite work and filesystem operations must not block Tokio executor threads.
- Profile real operations with matched fixtures/source hashes, warm-up and correctness checks. Preserve HDR/float authored values even in SDR preview. Keep the two experimental GPU optimization flags default-off until separately authorized real-device acceptance; see the development contract for names and gates.
- For current image/prefix optimization evidence and its remaining interaction limits, consult [the local rendering verification record](../../../testing/verification-render-low-latency-20261021/README.md). A raw-float parity pass or fewer queued operations does not establish whole-app latency acceptance.
- Desktop screen sampling is independent of export precision and effect admission. Keep four correlated samples, authored HDR/float data and edit/history semantics; do not use `desktopFullMath=false` as a shortcut. Screen appearance, same-tier cache equality and exact exports have distinct gates. See the [desktop display-tier evidence](../../../testing/verification-electron-display-tier-20261021/README.md) for actual-device results and failed candidates.
- A CPU/WASM pass proves only its tested path. Report skips, mocks, stale generated binaries and unrun GPU/GUI/socket/platform checks explicitly. Rebuild WASM after Rust changes before citing frontend tests as native enforcement evidence.
- Include this skill, its linked documents, changed source, tests and reproducible verification records in the next source increment. Keep links relative and artifacts free of credentials and machine-specific launch configuration.
