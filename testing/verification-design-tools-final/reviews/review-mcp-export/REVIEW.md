# Independent MCP/export boundary review

## Outcome

Three defects were independently reproduced, fixed, and retested. No unresolved blocker was identified within this review's non-GUI scope. The active backend is schema v5; cancelled Rust AI/schema6 work was excluded. The source is the unshipped working tree following delivered ZIP c11eb9.

## Findings and verification

1. **High: accepted mutation IDs could disable later manual saves.** JS accepted `save:1`, while Rust rejected it. DesktopSession retained the permanently invalid request as uncertain state, so normal Save retried it and failed. The owner aligned the public schema and runtime validation with Rust's ASCII grammar and clears explicitly known pre-write validation rejection. A real Editor/DesktopSession + production Sidecar + temporary SQLite test now rejects early and normal Save succeeds.
2. **Medium: history failed after 100 revisions.** The facade rejected v5's 101–1000-row response. The owner now exposes 100-row pages with the exclusive continuation boundary taken from the actual returned tail. The independent final test created and enumerated all 1001 durable SQLite revisions with no duplicate or missing revision.
3. **Medium: late cancelled/closed exports could mutate resource retention.** A backend completion after `close()` recreated already-cleared cached resources, and cancelled completions could evict prior resources. Root authorized this reviewer to add the narrow server post-await closed/AbortSignal guard. Four external regression tests verify no publication/eviction after cancellation/close, normal error behavior, and exact successful resource/image bytes.

Original failing evidence is retained in initial-independent.log and second-independent.log. The cancellation-probe.mjs script was executed before the fix and observed closed=true/resourcesAfterClose=1; it is intentionally a historical reproducer, not part of the passing suite.

## Passed verification

- Independent external adversarial suites: 9 tests, plus 4 lifecycle tests
- Existing Node MCP/native-host suites: 109 tests, no skips
- Production Sidecar/stdin-stdout MCP/temporary SQLite reopen durability: 1 test, no skips
- Existing client suites: 92 tests, including real product CPU/WASM preview, emitted-app JSDOM execution, bridge/scope/settings/dirty-draft behavior, and effective-grant UI
- Full client TypeScript check: exit 0
- Total: **215 passed tests**

Exact commands are recoverable from the log filenames and tests; independent tests live wholly in this directory. Source hashes and the backend hash are in source-manifest.json. Review tests do not modify production fixtures. The only reviewer production edit is the narrow server.mjs lifecycle guard authorized by root; workspace fixes were made by their owner.

## Important boundaries

- Grant isolation, opaque root/document/revision handles, CAS domains, mutation receipt retention, stale navigation revocation, dirty/pending input, cancellation uncertainty, bounded history, metadata-only results, and exact resource bytes were covered by source inspection and real implementation tests.
- Settings explicitly return atomicDurability=false with per-group persistence. No atomic multi-key localStorage durability is claimed.
- The App wiring regression executes the actual extracted App.tsx effect body with actual factories, Editor and DesktopSession. Only effect scheduling and native IPC are substituted; this is not a full GUI mount. Existing main tests execute actual main callbacks with Electron/OS/stdio boundaries replaced.
- CPU preview tests use the real product raster/export/WASM path with an in-process Worker messaging adapter. No GPU/display equivalence is claimed.
- Generated-app tests exercise actual emitted HTML/JavaScript in JSDOM, injection-looking text, descriptor/prototype validation, storage typing/schema/namespace, exact preview CSP hashes, and persisted-data budgets. A near-limit state action may remain active only in the tab; oversized persistence preserves old saved bytes and displays a warning.
- The enabled UI says current-document read-only, then separately lists workspace/settings grants. Native approval lists the independent scopes. The shorthand enable-button text could be made more explicit, but the effective enabled-status wording does not call the whole connection read-only.
- No browser UI/CSP enforcement, actual OS socket binding, native GUI confirmation, real restart, GPU path, or pixel-equivalence test was attempted. These paths were outside the permitted review.
- Mutation receipts do not create an exactly-once transaction spanning Editor, native transport, and SQLite.
- Later source edits, including startup extraction, require affected reruns against their final hashes.

## Key SHA-256 values

- Backend v5: 3f1e93319cb0e4022071592c04ef70783f1a489547b7726ca9833e5b0a5fd624
- frontend/design-mcp/src/server.mjs: d4b44d79d77db20f127d74ed3463d5d3ff845d63b2f2ed640adb2da9c3cfd4c7
- frontend/design-desktop/src/workspace-automation.mjs: f6138706dee95dc0090774d90e8d7d178ac12cf68f7cfe8bef2372f89dd3f5e6
- frontend/design-client/src/desktop-session.ts: 1f44e87ee810798a1df38e211a82bd2d63604cb080014db58f8144107151f792
- frontend/design-client/src/App.tsx: 41c5ea79894d1104ad50e5ed4c3461d494f0b8bbb22c69d5d856498779300f50
- frontend/design-client/src/automation/app-export.ts: 8f5a8808c2394540d3a915e08195cadd3027b56a4b190c1e676f229c7f42219c
- frontend/design-client/src/automation/bridge.ts: 9a279d5e283f1498632d3a861dec92f211a6beaa0f2c59df4d03e8be995cfd26
