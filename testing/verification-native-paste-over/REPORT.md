# Native Paste Over Selection integration

## Delivered change

- Shift+Cmd+V on macOS and Shift+Ctrl+V on Windows/Linux now route the named `paste-over-selection` editor command through the existing native input boundary.
- Edit → Paste Over Selection owns `CmdOrCtrl+Shift+V`. Paste in Place remains a separate menu command with no conflicting accelerator. Paste to Replace retains Shift+Mod+R; ordinary Paste retains Mod+V.
- The sandboxed preload's fixed command allowlist admits the new command. No raw IPC, arbitrary channel, or new renderer-to-host command method was added.
- Existing Center Selection menu/allowlist entries are preserved and covered. Its profile-specific keys remain renderer-owned.
- Existing repeat, IME, AltGraph/extra-modifier, keyup, and page-zoom policies are unchanged. Only three production modules changed in this increment. No client, Rust, GPU, minimap, or automation implementation was edited by this increment.

## Verification

All runs used Node v24.19.0 on Linux. The three platform labels represent policy parameters, not native OS runs.

- Immediate preimage baseline: 57/57 existing focused tests passed.
- Current focused production tests: 66/66 passed, 0 skipped.
- Updated tests against exact preimage production modules: 13 expected behavioral failures, 53 passes, 0 skipped. Failures include old native shortcut routing, absent menu entry, registered host forwarding, and preload rejection of the new command. This is a real old-code failure, not a source-text expectation.
- Broader `desktop-contracts`: 157/157 passed, 0 skipped. This includes the focused tests; do not add the counts together.
- Syntax checks for all three modified production modules and scoped `git diff --check` passed.

The host tests execute the actual main module with Electron/OS/stdio boundaries replaced. The preload tests execute the actual sandboxed preload in a VM, check its frozen narrow API, reject invalid/near-match/object/array command payloads, strip IPC events, and clean up listeners. Existing main tests remain intact before the appended cases; existing preload automation tests remain byte-for-byte intact.

## Reproduce

Run from the repository root:

```sh
node testing/verification-native-paste-over/verify.mjs
node testing/verify-local.mjs --suites desktop-contracts --output /tmp/native-paste-over-desktop-contracts
node --check frontend/design-desktop/src/main.mjs
node --check frontend/design-desktop/src/preload.cjs
node --check frontend/design-desktop/src/keyboard-shortcuts.mjs
```

The focused verification script first verifies the six scoped final file hashes, runs current tests, then creates an isolated copy with the three exact old production modules and requires the 13 named failures. It does not replace working-tree sources. It also records SHA-256 hashes and zero-skip counts in `results.json`. It sanitizes output locations, preserves fresh raw logs in an external temporary directory, and regenerates the recursive folder-local `publication.sha256` after updating evidence. The broader runner command above writes fresh raw outputs outside this publication folder.

## Provenance and local publication

- Checkout HEAD: `71d32153e6f55b3723c99708b4c4c49ac7342e67`.
- Prior delivered archive identity is recorded in `testing/verification-performance-review2/baseline-provenance.json` as SHA-256 `a9fb36a1ae40b3b30aa68a0aa5a7f2d3440c600697ab1ddae43ef0380c12c051`.
- This increment uses the three immediate pre-edit production files under `before/`, including existing unshipped work and the companion Center Selection change. Neither Git HEAD nor the prior delivered archive alone is treated as the current worktree baseline.
- `source-manifest.json` records exact preimage and final hashes for the six scoped source/test files.
- `native-paste-over.patch` is the incremental patch against those exact preimages.
- This evidence folder is the sole local publication bundle. `publication.sha256` covers every intended report, patch, log, manifest, reproduction script, and required preimage fixture using paths relative to this folder; it excludes itself. Final source/test files remain at their repository paths, identified by `source-manifest.json`; redundant copies were removed from the evidence bundle. Original raw logs and redundant source/test copies were preserved outside the checkout. No ZIP was produced by this scoped task.
- Published logs/results replace private absolute checkout/home locations with neutral placeholders. Test outcomes, failures, commands, source hashes, and stated OS/mock limitations are retained.

## Limits

No Electron GUI, actual OS clipboard/dialog, OS socket, GPU, packaged app, Rust build, WASM build, or native backend runtime was launched. These tests do not establish Figma/Sketch feature equivalence or native macOS/Windows behavior. Renderer graph semantics and focused editable/modal handling are covered separately by the companion client change; native routing deliberately delegates those decisions to the existing renderer policy.
