---
name: futureox-design-development
description: Develop, review, or test this Futureox Design local-first editor, its Rust/WASM kernel, Electron host, FD format, or shared MCP operation API. Use for changes in this repository, not unrelated projects or remote design-service automation.
---

# Futureox Design development

Read [the v1 development contract](../../../docs/DEVELOPMENT_CONTRACT_V1.md) before architecture, storage, rendering, performance, or release changes. Read [the MCP operation guide](../../../docs/MCP_OPERATION_GUIDE_V1.md) for automation/discovery/schema changes; it routes to detailed maintained contracts.

- Target local v1.0.0. Do not add historical application compatibility machinery merely to preserve an unreleased implementation. Keep app, FD container, document schema, capability, storage and session versions separate; preserve current authored values and explicit forward-extension contracts.
- Web and Electron share UI and design semantics. Desktop adds local native acceleration/storage through adapters. Keep MCP thin: shared operation registry → isolated draft → authoritative Editor.change → Rust/WASM admission/layout/history. Never build a second document model, mutation engine, cloud-account backend or AI orchestrator.
- The Web app and PostgreSQL collaboration service live in the independent `futureox-desgin-server` repository. Electron starts in local mode and uses an opt-in host connection. Its local backend owns local file and SQLite operations. Keep server revisions and network calls outside the editor transaction.
- FD optional metadata is inert, bounded and losslessly preserved; required unsupported semantics reject. File contents cannot install handlers or grant permissions. Native whole-document open is different from MCP document.import append.
- Discover actual operation schemas and permission-filtered counts. Never invent Figma aliases, infer input units from UI percentages, or treat node.update whole-property arrays as granular leaf patches. Authorize batch wrappers and expanded leaves; preserve expected-value and document/session/revision fences.
- Keep immutable snapshots across awaits, storage CAS separate from editor revisions, append-only durable restore separate from editing undo, and exact retry receipts separate from rollback promises. SQLite work and filesystem operations must not block Tokio executor threads.
- Profile real operations with matched fixtures/source hashes, warm-up and correctness checks. Preserve HDR/float authored values even in SDR preview. Preserve existing default-off experiments; see the development contract for names and acceptance gates.
- Desktop screen sampling, same-tier cache equality and exact exports have distinct gates. Preserve four correlated samples, authored HDR/float data and edit/history semantics; do not use `desktopFullMath=false` as a shortcut.
- GPU working-set budgets are trusted launch policy, never document metadata. Preserve existing device limits, safe Number arithmetic, independent cache budgets and source/resource ownership.
- CPU/WASM, mock, software GPU, hardware GPU, GUI, sockets and packaged applications prove different boundaries. Report failures, skips and unrun checks explicitly. Rebuild WASM after Rust changes before citing frontend tests as native enforcement evidence.
- Keep source increments limited to changed files and related tests. Check relative links and keep credentials, machine-specific launch configuration and generated reports out of commits.

Rendering work follows [the rendering-first skill](../futureox-rendering-first/SKILL.md). Find maintained feature and interface contracts in [the documentation index](../../../docs/README.md); use [the testing guide](../../../docs/TESTING_CONTRIBUTIONS.zh-CN.md) for test requirements. Historical package results do not establish acceptance of the current source.
