# Causal diagnostics and document-switch preparation repair

This narrow cumulative increment retains delivered 554 and adds only bounded tile-cost diagnostics, device-lifecycle correlation and document-switch preparation reuse. It does not include the pending Home, locale, presets, page-retention, color or navigation-intent cohorts. The five reported problem families are not all repaired.

## Capture

From frontend/design-desktop, run:

    CORE_RENDER_DIAGNOSTICS=detail bun run dev 2>&1 | tee core-render-detail.log

Reproduce document switching, zoom/pan and the visible failure. Preserve the complete terminal log and note the source package used. Review logs for private local paths before sharing. New numeric diagnostic fields exclude document text, names, colors and geometry coordinates. Existing camera/request records can still contain coordinates, and terminal output can contain local paths.

## What changed

Tile-cost records report bounded packet/effect visits, output/source pixel areas, support expansion, encoded pass pixels and material-field accounting. Sampling is capped at 2048 observations and scans are bounded. Unavailable and capped flags prevent missing values being interpreted as zero. Graph non-checkpoint elapsed time is not pure encoding time or GPU execution time. No readback, added fence or effect-quality reduction is introduced.

Device lifecycle records distinguish worker scope, device incarnation, owner, stale callbacks, disposal and recovery phases. Identifiers are ephemeral correlation values, not hardware identifiers or completion proofs. This is instrumentation, not a device-loss or memory-lifetime repair.

Document switching now reuses a private, one-use prepared-document token after successful preparation instead of decoding and preparing the same adopted document repeatedly. Validation and ownership guards remain. Read/decode/admission/layout/adoption spans are numeric, overlapping wall-clock measurements, not additive durations.

Independent CPU fixtures found decode count 2 to 1 and preparation count 3 to 1, with identical adopted JSON hashes. In the scoped fixtures, archived Sketch median workspace-switch time in the CPU/WASM harness was about 4.88 s versus 1.71 s; imported FIG about 23.68 s versus 7.70 s. These are local CPU measurements, not Electron end-to-end or GPU presentation guarantees. Raw user documents are not included.

The separate UI/navigation experiment exposed regression tests and is explicitly excluded. No claim of full Figma parity, all-operation coverage, physical FPS, global VRAM bounds or complete architectural repair is made.
