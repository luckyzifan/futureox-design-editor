# Bounded navigation capture (NEXT diagnostic)

This capture separates CPU scheduling stages. It does not measure GPU execution, browser scanout, or input-to-photon latency. The externally reported 9.8–9.9 Hz observation has not been verified here. Keep its exact capture script, capture intervals, launch flags, deployed revision, visibility, adapter/backend and timestamp definition alongside this report.

## Run on the already-authorized development page

`navigationWorkerTimeline` imports the existing Vite source module `/src/kernel/client.ts`. This route is for a development server only. A production bundle may not expose it; do not substitute or guess a different module or claim that an unavailable capture succeeded.

Import these functions in the existing Playwright harness (no new server is required):

```js
import { navigationTimeline, navigationWorkerTimeline, navigationSnapshot } from './testing/diagnostics/navigation-snapshot.mjs'
const before = await page.evaluate(navigationSnapshot)
await page.evaluate(navigationTimeline, { action: 'start', capacity: 2048, durationMs: 10000 })
await page.evaluate(navigationWorkerTimeline, { action: 'start', capacity: 2048, durationMs: 10000 })
// Perform the same authorized pan/zoom gesture used by the external test.
const workerAndMain = await page.evaluate(navigationWorkerTimeline, { action: 'stop' })
const mainObserved = await page.evaluate(navigationTimeline, { action: 'stop' })
const after = await page.evaluate(navigationSnapshot)
// Save { before, workerAndMain, mainObserved, after } with the original capture.
```

Default capacity is 2048 events per journal, maximum 4096. Default automatic stop is 10 seconds, maximum 30 seconds. A maximum of eight active clients may be captured. Journals retain only numeric allowlisted metadata and counters; no document/node strings, source payloads, font/image data or pixels. The DOM collector retains only the explicitly named diagnostic fields and event types. Stop disconnects observers/listeners. Repeating start resets the previous capture. Worker reset/device loss may prevent retrieval of that worker's journal; an unavailable result is not an empty-success trace.

There is no new per-frame IPC: worker events stay in its ring until an explicit snapshot/stop pull. The normal existing presentation messages are unchanged. No GPU fence, screenshot, framebuffer readback or synthetic raster operation is added. Disabled journals perform no clock reads. Recording necessarily adds bounded CPU bookkeeping, so compare otherwise identical capture-on/off runs if testing fine-grained overhead.

## Stage meanings

| Stage | Clock | Meaning |
| --- | --- | --- |
| 1 | Main | Raster request sent; numeric requestId and requested camera |
| 2 | Main | Resident camera message sent; numeric display sequence |
| 3 | Worker | Raster task admitted by RenderWorkQueue |
| 4 / 5 | Worker | Compile await begins / ends; paired by local compile sequence |
| 6 | Worker | Display message received; pair with stage 2 sequence |
| 7 | Worker | Resident report immediately after queue.submit; frames counter |
| 8 | Main | Raster result received; requestId and existing duration statistics |
| 9 | Main | Resident submission acknowledgement received; frames counter |
| 10 | Worker | Preview cancellation control received |

Stage 4–5 includes cache/preparation IPC/native compilation and is not exclusive CPU compile time. Its sequence is independent of requestId; do not invent per-request joins. A compile completed after a capture restart cannot enter the new capture. Cancellation need not end a currently useful compile, so an end event after stage 10 can be legitimate.

Stage 7's `sequence` changes when the submitted texture-ID list changes, and `tiles` is that list's count. The internal comparison is limited to 4096 numeric IDs, which are not exported. This distinguishes submitted raster-set changes from camera-only submissions, but is not proof of changed pixels, native detail, GPU completion or scanout. Ordering changes can also change the list. Stage 8 alone is receipt, not publication. Stage 9 confirms the main thread received the submission report, not that the browser displayed it.

For main-observed requested camera, navigation sample, aggregate raster result, publication-state and resident acknowledgement transitions, inspect `mainObserved.events`. These are MutationObserver/rAF observations; DOM mutation batches can coalesce several internal events. `compositorFrames` increments are much more meaningful than counting observer callbacks. `framePublication` is a state, not a unique publication ID. `presentedCamera` is DEV-only; absent is unknown. Object `contentSequence` is not a camera sequence.

## Align and distinguish

For each event compute `report.timeOrigin + event.at`. Main and worker may have different performance time origins. Preserve original values, timer-precision limitations, dropped counts and visibility. Do not subtract raw main `at` from raw worker `at`.

- Stage 2 high-rate but stage 6 ~10 Hz: worker event delivery or event-loop occupancy.
- Stage 6 high-rate but stage 7 ~10 Hz: presentation task/CPU work or downstream submission limitation.
- Stages 7 and 9 high-rate but independent captured images ~10 Hz: investigate the external capture cadence and browser/GPU presentation stage. This still does not prove scanout.
- Stage 7 frames high-rate but texture-list sequence slow: resident camera transforms can refresh faster than raster publication; inspect camera and raster-set separately.
- Zoom raster target sequence near 160 ms is current policy; default quiet is also 160 ms. Adaptive 48 ms is experimental opt-in.
- Stationary cached content should not redraw just to maintain a nominal FPS counter.

A CPU-only control test in `testing/verification-ten-hertz-scheduling-20261020/scheduling.test.ts` demonstrates that observing a 16 ms-changing source once every 100 ms produces an apparent 10 Hz ceiling. This establishes a possible measurement confound, not the external script's actual behavior.
