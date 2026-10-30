# Exact prepared-baseline bytes certificate

## Scope and cause

The 565 lifecycle trace showed two different serialization roles, not duplicate work on the same snapshot. The first recovery after an edit may serialize the previously adopted baseline, then the current edited generation. The current generation must still be encoded independently. The final derived-validation step already creates JSON.stringify(prepared); this change retains those exact bytes as a private one-use ownership certificate instead of encoding that old baseline again.

## Safety boundary

- Capture happens only after final layout and successful native derived validation. That native validation enforces the 32 MiB UTF-8 document limit. No additional stringify or validation pass is added.
- A WeakMap binds the certificate to an unexposed PreparedDocument owner. Snapshot copies and structurally similar objects cannot forge it.
- DesktopSession uses it only for a persisted document, after Editor.load succeeds and adopts the identical owner. A false return or font-rebind throw leaves the old baseline unchanged.
- The installed frozen preload codec advertises json-stringify-v1. The local fallback is also JSON.stringify. Unknown/custom codecs still encode their own baseline and current bytes. The marker is a trusted host codec contract, not a claim about arbitrary encoders.
- UUID forks consume the original token and deliberately discard its certificate. Font rebinding does not change authored JSON.
- Current snapshot encoding still fences generation and document identity; same-root versioned mutations and edits during an in-flight encode cannot reuse stale current bytes. Undo-to-saved still uses exact-byte equality.
- Event 215 is a paired numeric baselineReuse span, with sourceCodeUnits only. It carries no document text, IDs or paths. It does not represent a new persistence acknowledgement.

## Initial validation before the reentrant-adoption follow-up

- Seven focused Vitest files: 110/110 tests passed, no skips, one concurrent worker, 8.93 seconds.
- TypeScript 7.0.2: tsc --noEmit passed. Node v24.19.0, Vitest 5.0.1.
- Twelve certificate cases cover native-codec reuse, unknown reordered codec fallback, no-codec fallback, false adoption, font rebind failure/retry, same-root version mutation, concurrent revision changes, undo, private one-use ownership/fork invalidation, structured-clone transport, actual persistent Node codec worker exact bytes, and installed frozen preload routing.
- The actual Node worker comparison covers blank and authored rectangle documents with Unicode, escaping, exponent-sized numbers, negative zero normalization, numeric-key ordering, nested metadata and null/boolean arrays. This proves exact output strings, not merely parsed-JSON equality.
- Existing DesktopSession, workspace, prepared-document, switch-ownership, asynchronous-review and lifecycle-diagnostics suites all passed. Workspace tests use their existing bridge doubles; they are not new physical SQLite durability tests. Font-rebind rejection is deliberately injected through a VectorEngine spy. Preload is evaluated with mocked Electron IPC, while codec serialization runs in the real Node worker.
- Initial failures are retained in evidence: unsupported Vitest --minWorkers argument caused zero tests to run; the next run passed 109 cases but exposed a relative dynamic-import resolution error in the candidate test. That test now resolves its module with import.meta.url. The final full focused rerun and typecheck both passed. That initial review required no production correction; the subsequently requested adversarial reentrant test did reveal the separate defect described below.

## Limits and cost

This is a targeted CPU/WASM correctness gate, not a full application test suite, production Electron IPC/GUI test, real-device GPU acceptance, Rust rebuild, large-file benchmark or measured switching-speed claim. Existing shared portable WASM was reused without rebuilding; its hash is recorded in MANIFEST.json. The change removes one proven old-baseline codec invocation, not the required newer-revision invocation and not the remaining synchronous preparation stall. It retains one validated JSON string earlier, until the saved baseline changes; transient encoding and snapshot memory remain possible.

## Reentrant-adoption guard: implementation and targeted comparison

A synchronous Editor.load subscriber can edit the newly adopted root while DesktopSession suppresses ordinary observations. The original 565 source and the first certificate candidate unconditionally marked that final generation clean. Prepared-token identity alone does not prove that its validated bytes remain current.

The guarded candidate captures editor version, editor session and DesktopSession generation immediately before load. After load returns, it requires exactly one expected editor version/session transition, unchanged session generation, and the same prepared owner before claiming a persisted baseline. A changed owner, reentrant version, nested session or draft generation invalidates the clean/pristine claim. The newer current document is preserved, but baselineGeneration, baselineJson and baselineDocument remain unset until its own persistence acknowledgement. No serialization is added to this fence.

- The same portable regression ran against untouched 565 source through a separate symlinked harness: all three cases failed specifically because session.dirty was false after the synchronous mutation. Baseline files were not edited.
- Initial guarded verification: 15/15 cases passed in 2 files (the 12 certificate cases plus 3 new reentrancy cases), 2.63 seconds, one concurrent worker, zero skips. TypeScript tsc --noEmit passed again.
- Reentrancy cases: versioned mutation of the same root, replacement root without another public revision increment, and a nested Editor.load with owner/revision restored to isolate the editor-session fence. Each case verifies that no encoding occurred while setting the dirty state, and that later recovery encodes/persists the edited content once.
- The earlier 110-case result is pre-guard evidence only. The separate 15-case run overlaps the final 113-case run below and is not an additional 15 unique tests.
- This is a targeted correctness comparison, not a benchmark. Existing GUI, GPU, real SQLite and large-file performance limits above still apply.

## Intermediate guarded broad focused gate, 2026-10-20T10:33Z

- All eight requested Vitest files ran together against the final guarded source: 113 unique tests passed, zero failures and zero skips, maxWorkers=1, 10.10 seconds. This is the observed total, not a sum of prior overlapping runs. The command started at 10:33:12 UTC and exited successfully at 10:33:22 UTC.
- TypeScript tsc --noEmit passed from 10:33:22 to 10:33:25 UTC.
- Coverage includes DesktopSession (62), workspace (13), prepared ownership (4), switch ownership (12), asynchronous review (5), exact baseline certificate (12), reentrant adoption (3), and numeric lifecycle diagnostics (2).
- At this intermediate checkpoint, production and test source hashes were identical to the earlier guarded package. This checkpoint preceded the all-owner correction below and is not the final source gate.
- The full application suite, production Electron GUI, real-device GPU and large-file performance remain unrun for this independent certificate increment. Async authoring worker changes are not included.
- Both earlier archives are preserved unchanged, with their original SHA-256 values recorded in MANIFEST.json.

## All-owner correction and final 117-case gate, 2026-10-20T10:38Z

The intermediate guard still lacked an owner certificate when saveCopy adopted a plain DesignDocument. A same-version replacement listener could therefore claim the newly changed copy was saved. Two real saveCopy regressions reproduced this with both the advertised native encoder and an unknown reordered custom encoder: the stored copy was correct, but the changed current root incorrectly reported clean. Their expected failing run is retained in evidence.

- ensurePreparedDocument now normalizes every DesktopSession.load input through the existing private ownership boundary. It returns an existing live token unchanged or prepares a plain document once; Editor.load consumes that token instead of preparing again. Forged structural tokens and consumed tokens cannot bypass admission.
- preparedDocumentAdoptionOwner is an independent private WeakMap witness, separate from optional exact JSON bytes. Every successful load must prove the consumed token's identical owner, as well as the existing version/session/generation fences, before claiming a saved baseline or pristine blank. Forked tokens without validatedJson are covered.
- No extra prepare, stringify or native-validation pass is added. Tests assert one preparation for ordinary prepared open and each plain saveCopy, and zero additional preparation when adopting an already prepared fork. Unknown/custom codecs retain their own encoding path.
- Final source: 117 unique tests passed in all eight focused files, zero failures and zero skips, maxWorkers=1, 9.90 seconds. The command ran from 10:38:04 to 10:38:15 UTC; tsc --noEmit passed from 10:38:15 to 10:38:17 UTC. Evidence filenames retain the planned 1036 slot label, while their embedded timestamps record the actual run.
- Observed coverage is DesktopSession 62, workspace 13, prepared ownership 4, switch ownership 12, asynchronous review 5, certificate/all-owner 16, reentrant adoption 3, and numeric lifecycle diagnostics 2. Earlier 110, 15 and 113 results overlap and are not additive.
- Relative to the 113-case checkpoint, source changes are limited to prepared-document.ts, DesktopSession.load, four new certificate tests plus a prepare-count assertion, and this verification document. The baseline patch still affects nine paths in total.
- No production/test code changed after this final run. All three earlier archives remain preserved by hash. The final patch applies cleanly to unchanged 565 before hashes and its applied result matches every manifest after hash.
- This remains an independent certificate/ownership correctness increment, not async-worker approval, a full application suite, GUI/GPU acceptance or a large-file performance measurement.

## Current import snapshot and renderer reuse

The real Electron FIG profile subsequently showed that a nonpersisted import still encoded its first recovery snapshot through the desktop bridge, and the render client separately sent the same large document object across the native preparation bridge to obtain JSON. The exact post-layout bytes were already available, but baseline reuse alone did not cover these consumers.

- DesktopSession now seeds its current generation's encoding cache after the same successful owner/version/session/generation adoption fences. This applies to imports as well as persisted opens. Imports remain dirty until their own storage acknowledgement; certified bytes are not a save receipt. Unknown custom codecs and ID forks without a certificate keep the existing encoder path.
- Editor.load normalizes a plain value through the existing prepared owner exactly once. Only a consumed private token can register its exact JSON for rendering. Registration binds the adopted document identity, editor revision and session; synchronous reentrant edits cannot register stale bytes.
- KernelClient reuses that string only for full document synchronization and requested full-document fallbacks. Patch generation, native submission ordering, mutation acknowledgements and validation remain unchanged. An unregistered object, structural clone, expired owner or historical snapshot takes the existing serialization path.
- Editor.set revokes the old certificate when its document or revision changes, including a versioned mutation of the same root. Disposal revokes it too. The getter independently checks the captured identity/revision/session. This both prevents stale reuse and releases the retained wire bytes even when editing history still holds an old document.
- Numeric lifecycle event 216 records current snapshot reuse without names, paths or document content. It does not imply that storage succeeded.

This removes proven repeated serialization/structured-clone work; it does not remove admission, component resolution, layout or derived validation. Those synchronous stages still require separate latency measurement. No asynchronous preparation Worker default is enabled by this change.
