# Work log

- Baseline: 2276 build inputs frozen, existing dirty workspace preserved. Five
  targeted files: 75 tests passed. Native scene-plan filtered tests passed.
- Rust now emits sparse consecutive opaque runs and bounded-normal-paint parent
  proofs. The browser rejects overlapping/reordered ranges and uses private GPU
  program receipts. Mixed execution starts with owned transparent planes and
  preserves intervening ordinary leaves and all four phases.
- Independent constant coverage, finite bounded gradient fusion and per-category
  pixel/rejection diagnostics added behind separate opt-ins.
- Portable release WASM rebuilt successfully. The first frontend candidate had
  one fixture error: its wide colour omitted the compiled scene colour table;
  this was corrected rather than weakening production colour parsing. Then all
  86 targeted tests passed. Numeric host diagnostics passed.
- Whole-project typecheck exposed the pre-existing missing nativeSource props in
  Canvas.tsx. Both Canvas.tsx and App.tsx hashes matched the frozen baseline.
- Hardware infrastructure v1 initially crashed on a missing favicon because the
  HTTP handler sent headers before reading a file. The server now reads first.
  The next attempt rejected a fixture without the required colour-management
  schema; schema 20 and the actual `kind` field are now used.
- Hardware v2: Apple/Metal-3 non-fallback adapter. Constant fixture raw output was
  bit-identical (196608 words), but the optimization was NOT exercised. Inspection
  found the general node-source path still called mask() directly. It now routes
  through the independent constant proof only when that candidate is enabled;
  general gradient fills also reach the fused path. v2 timings are not acceptance.

Further hardware, default-policy and application results follow in README.md.

- v3 hardware: ten cases, each 196608 raw f32 words, zero differing words.
  The mixed case reduced 527 draws to 23. Initial constant coverage reduced peak
  storage but rebuilt its one-pixel mask each frame; it now uses the existing
  immutable material cache. The gradient field now carries a private upload-bound
  finite/index proof; foreign/malformed fields take the original two-pass path.
- Resumed after user interruption: 88 targeted tests passed. A wider GPU run had
  1755 passes, 7 TODO and one existing transparent-zero fixture failure. The frozen
  blur code read scene.integratedBlur before its zero identity return. Moving that
  read after the identity fixes the genuine ordering issue without changing any
  nonzero filter path. A second full GPU run passed 1756 tests, 7 TODO.
- Restored the already-requested native source Canvas integration (the App was
  passing source props that Canvas did not accept). Actual surface selection,
  global scroll bounds, fit and hand-mode material opening are wired; mounted
  event/Editor tests and existing source-workspace tests passed. Whole-project
  typecheck passed. This is a baseline integration repair, not a renderer speedup.
- Real FIG inputs retain the analytic profile and original colour semantics;
  the existing file is not converted to another profile to manufacture a fast-path
  hit. The first 117 probe selected a nested same-name object; root frame selection
  was corrected, and the failed run retained.
- The gradient regional pass now shares the original normal-over writable ring
  and saved bilinear halo. This preserves destination zero/NaN boundary behavior
  instead of treating geometric bounds as the entire composition footprint.
- Diagnostics classification v2 accounts for opacity/knockout merges and resolve
  work, includes measured rectangle pixels and explicitly unmeasured draw counts,
  and distinguishes cache key misses, exact-word misses and capacity refusals.

- The initial mixed-effect candidate regressed from 41.9 to 64.2 ms (including a
  144 ms candidate sample). Added coarse scene screening for singleton gradients
  and groups with no executable batch, retaining the failed report. The original
  immutable shader fields, binary coverage, private target and budget proofs still
  decide pixel eligibility; the coarse screen is only a cost filter.
- Actual managed upload allocation review found that generic uploadRgba8 expands
  to RGBA32F. Constant coverage now has a dedicated four-byte RGBA8 allocator and
  upload test. Final all-candidate hardware checks were bit-exact, but constant
  warm latency missed the frozen 5% target (27.3 -> 34.5 ms), so its flag was
  returned to strict opt-in. The default decision was not made by relaxing the
  performance threshold.
- Final default hardware: 10 synthetic, 4 real-view and 7 edge cases; 6,381,568
  compared u32 float words, zero differences. 117 overview: 7136 -> 4056 draws,
  443.7 -> 335.9 ms median wall/render+readback. FIG, wide-colour and effect-heavy
  unchanged workloads are explicitly not claimed as stable improvements.
- Final default typecheck, 118 affected integration tests, 1759 GPU regressions
  (7 existing TODO), five host diagnostics and isolated desktop build passed.
  The earlier GUI build imported/rendered 117 and undid an opacity edit; its
  identity remains separate from the final default build, not a final GUI replay.
- Recorded 18 task-owned source/test/rule files against the dirty baseline.
  The tile diagnostic backup had been captured after its edit; its original was
  reconstructed and verified against the frozen input hash. The untracked host
  diagnostic test original is explicitly marked reconstructed, not pre-frozen.
  Removed 312 task-created identical backups only after byte comparison. Kept
  unrelated NativeSourceSurface and canvas-fallback-submission changes intact.
