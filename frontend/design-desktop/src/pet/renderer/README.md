# Bounded companion renderer

This renderer uses the upstream Nomi `neutral.png` artwork under its declared MIT
license, with original Futureox Canvas 2D transforms. It does **not** include or
claim to reproduce Nomi's layered 43-action sprite engine, Rive runtime, AI,
voice, physics, model store, or network services.

`idle` is a small bob; `work` rocks gently; `nod` compresses the whole image;
`celebrate` bounces; `puzzled` tilts; `wave` sways the whole image. These names
describe simple reactions, not articulated face or limb animation. Non-work
reactions return to idle after 1.8 seconds.

The host preload provides only `window.nomiPet.onState(callback)` (returning an
unsubscribe function) and `window.nomiPet.ready()`. State has `mode` (`active`,
`quiet`, or `off`), Boolean `paused`, `action`, and a monotonically increasing
nonnegative safe-integer `sequence`. Invalid and stale states are ignored;
unsupported actions become idle. The ready signal follows local artwork load,
so the host can replay its current state without timers or polling.

There is at most one pending requestAnimationFrame callback. Paints are capped
at 30 per second; callbacks on faster displays may skip paint. Hidden or off
states cancel scheduling completely. Quiet, paused and reduced-motion states
render a static pose without scheduling. Visibility changes, resize and host
state events are event-driven. Disposal cancels pending work and removes event
listeners and the IPC subscription.

DPR is capped at 1.5 and logical canvas dimensions at 640 × 720. This bounds the
backing store at 960 × 1080 pixels, but is not a measured GPU or process-memory
budget. Canvas 2D and window compositing can still share Chromium GPU resources.

The HTML has an inline-free, local-only CSP with `connect-src 'none'`. Artwork
and notices are in `assets/`, with exact source paths, pinned commit and SHA-256
hashes in `assets/provenance.json`. No upstream executable code is included.
Pure Node scheduler and asset-integrity tests are in
`test/pet-renderer.test.mjs`. Real window loading, visual appearance, performance
and compositor behavior still require explicitly authorized GUI validation.
