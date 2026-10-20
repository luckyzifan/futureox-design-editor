# Canvas frame, input and grid diagnostics

These fields contain only numbers, enumerations, counters and expected-match flags. No document text, labels, author identity, geometry dumps or screenshots are added. Existing terminal diagnostic enablement controls collection. No GPU fence/readback or per-frame console call is added by the measurement collector.

## Meaning and limits

`frame-window` summarizes visible windows of at least 1 second. `windowMs` is actual elapsed duration (capped at 120000 for export). `windowCapped` explicitly marks a truncated window duration. Counts/rates are non-negative. Fixed histograms have 10 buckets with upper bounds 8, 16.7, 25, 34, 50, 100, 250, 1000, 5000, 120000 milliseconds. P95 fields are bucket upper bounds, not exact quantiles. Max/age fields cap at 120000, with explicit `uiIntervalCapped`, `submitIntervalCapped`, `inputPresentCapped`, and `pendingInputAgeCapped` flags. A capped P95/max is not an exact maximum; values may be larger. Histograms consume constant memory; camera-request correlation retains at most 256 scalar records. No percentile array grows with frame count.

- `uiFrames`, `uiFps`: callbacks on the main UI requestAnimationFrame loop. Not physical display FPS.
- `uiIntervalP95Ms`, `uiIntervalMaxMs`: callback intervals. `uiLongFrames` counts gaps >50ms; `uiStalls` counts gaps >250ms. A fully blocked main thread reports the gap only after it resumes.
- `softwareSubmits`: count of resident compositor queue.submit observations received in this main-thread summary window. Delayed IPC can bunch this count; it is not a rate.
- `softwareSubmitHz`: cadence from strictly increasing worker submission epochs: 1000 × `submitIntervalCount` / actual worker elapsed interval span. It is independent of IPC arrival timing. `softwareRateValid` is 1 only when at least one positive interval exists; otherwise the rate is unavailable (encoded as 0, not an idle/failure assertion). `submitSampleSpanMs` describes the worker sample span, which may differ from `windowMs` and may span receipt-window boundaries; `submitSpanCapped` marks its 120000ms export clamp. Rate uses the uncapped span. Duplicate or decreasing epochs do not contribute to the rate or move its timestamp baseline backwards. Idle gaps can legitimately lower sampled cadence.
- Neither submission count nor cadence is GPU completion, scanout, or novel-content FPS. Messages transport timestamps without adding a separate IPC per frame.
- `submitIntervalP95Ms`, `submitIntervalMaxMs`: intervals between worker queue submission timestamps, not message-arrival intervals. Idle unchanged canvases legitimately have zero submissions and long gaps. These are not failure flags.
- `inputPresentCount`, `inputPresentP95Ms`, `inputPresentMaxMs`: distinct accepted wheel/pinch sequences matched by exact camera identity to a requested frame and then software submission. Time origins align worker/main clocks. Repeated submissions for one input are counted once. These are not device-input-to-photon latency.
- `pendingInputAgeMs`: age of an accepted input not yet matched to submission, including accepted inputs that never produce a frame request. No pending input is 0.
- `staleCameraSubmits`: submitted request sequence older than the most recently requested sequence. `outOfOrderSubmits`: lower than the highest previously observed sequence. `uncorrelatedSubmits`: missing/evicted/reset correlation. None is itself proof of visible jitter.
- `transformMismatch`: submitted camera differs from the exact requested camera stored for that sequence. `phaseChanges`: fractional device translation changed from previous submission. Phase changes can be expected during pan/zoom.
- `sameCameraSubmits`, `changedCameraSubmits`: camera value comparison only. Same camera does not mean same frame/content; changing texture contents cannot be inferred from it.
- `windowResetReason`: 0 periodic, 1 hiding, 2 becoming visible, 3 reset/unbind/dispose. Hidden windows are not emitted; becoming visible starts a fresh window, so code 2 need not produce a row. Hidden/reset correlation is cleared; first callback/submission starts a new interval baseline.

## Grid observations

`grid-state` emits at most one latest sample per known grid kind per second (maximum five). It is a sampled observation, not a complete change history. Fields are optional when unproven.

- `gridKind`: 1 background raster-request expectation, 2 SVG pixel grid committed UI state, 3 solved layout cells committed UI state, 4 authored layout bands committed UI state, 5 GPU pixel grid software submission.
- `gridVisible`: 0/1 expected visibility at that observation boundary. Kind 1 uses the actual Rust background predicate: grid on, non-transparent, zoom >0.13. It is request evidence, not completed background rendering.
- `gridSpacingClass`: 0 unknown/not applicable, 1 below pixel threshold, 2 zoom >=4 (one world-unit pixel grid), 3 fixed 32-world-unit background spacing. This does not export actual document grid tracks.
- `gridRedrawReason`: 0 initial/unknown, 1 camera, 2 toggle/content/request, 3 size/DPR. Use only supported classifications.
- `gridPhaseMatch`, `gridAlignmentMatch`: expected agreement flags, not a pixel measurement. Omit when not checked.
- `gridStale`: target camera versus displayed camera mismatch flag. Omitted where unavailable.
- `gridCount`: number of already computed grid cells/bands, without positions or style/content. `dpr`: backing/device scale where known.

The SVG world-integer pixel grid and GPU screen-space grid formulas are tested for phase agreement across negative/fractional translations and DPR. The grid helper tests phase equivalence only; it does not sample raster output.

## Coverage and uncovered cases

Production hooks: KernelClient bind/unbind and visibility lifecycle; accepted wheel/pinch input trace; requested camera sequence; explicit resident wire projection; ResidentPresenter immediately after queue.submit; worker report transport; background raster-request predicate. The Canvas cohort owns SVG and layout-grid commit hooks.

Not covered as actual software-submission FPS: non-resident fallback surfaces, browser compositing, physical monitor output, GPU execution/completion, screenshots, all visual correctness. Pointer drag input uses existing interaction trace, not the wheel/pinch input correlation collector. No new-content/same-content assertion is made. Grid samples do not prove backend raster success, correct opacity/color, absence of flicker, or every grid path's visual alignment. Good FPS does not mean frames are correct.
