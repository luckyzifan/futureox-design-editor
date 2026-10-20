# Opt-in input-stage instrumentation

Diagnostic-only changes; wheel gain, camera math, rAF scheduling, rendering request payloads and worker message count are unchanged.

The Canvas accepted wheel handler calls a renderer-owner-scoped sink after calculating its next camera and before scheduling the camera write. No raw DOM event is retained. In disabled mode the sink does not read clocks or input fields. Active trace records numeric stage1 in the existing bounded NavigationJournal and camera-input in the existing rate-bounded terminal collector. Only the latest camera object and scalar correlation are retained by the trace; disabled sinks and unmounted/paused renderers do not capture. Sink failures cannot throw into the input handler.

Fields: inputSequence (per-client), inputAt (performance.now at accepted handler observation), inputTimeOrigin, inputKind (1 wheel,2 classified native pinch; not a physical-device identifier), original deltaMode, deltaX/Y normalized to CSS pixels before Shift-axis remapping, accepted x/y/zoom. camera-request/stage2 receives inputSequence,inputAt,inputTimeOrigin,inputAgeMs only for the exact same accepted camera object. Equal-valued restored/programmatic cameras and prior journal generations do not inherit a correlation. CPU ReferenceSurface can record input, but stage2 denotes resident client.present only. This is accepted-handler CPU-to-client timing, not physical input-to-photon/scanout.

Validation:
- Five input/journal/Canvas/camera suites:88 passed,1 skipped.
- Full client suite:17 passed, including actual KernelClient stage1→stage2 correlation and exact display-frame payload equality.
- TypeScript noEmit passes in isolated tree with unchanged dependencies/fixtures linked from baseline.
- Mounted Canvas real WheelEvent tests:1/10/120 events reach identical2× zoom, exact pointer anchor, one first-frame notification, stable doc/version/panel snapshot; new bound sink observes all accepted events before rAF.
- Disabled zero-clock, finite whitelist, owner isolation, generation/reset, output cap10000→16 journal events and10 baseline terminal records, sink-exception containment tested.

The renderer itself is mocked in mounted Canvas tests; no GPU/FPS/scanout claim is made.
