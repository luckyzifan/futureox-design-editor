# CPU-only browser validation (prepared, not executed)

This is a bounded real Chromium / React / Rust-WASM smoke. The desktop capability
bridge is a test double with actual writes to one temporary `.forma` file. It is
not Electron, native IPC, native dialog, Rust-sidecar, or ordinary-web IndexedDB
validation. No browser launch/build/install was performed when preparing it.

## Central runtime owner's commands

Use existing installed Node 24+, Vite and Playwright, Chromium, and the centrally
rebuilt CPU WASM artifact. This command does **not** run `dev`, `build`, Cargo,
GPU tests, dependency installation, or Playwright browser installation.

```sh
cd /workspace/shared/core/frontend/design-client
node --check scripts/check-cpu-browser.mjs
# Run only after the central build/test owner grants the execution slot.
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-cpu-browser.mjs
```

Optional `DESIGN_TEST_OUTPUT=/absolute/owned/evidence-directory` selects where to
retain evidence. Otherwise stdout reports a new `/tmp/forma-cpu-browser-*` run
folder containing `evidence/`. Preserve its `Owned.forma`, screenshots and results.
The script deletes only its newly created Chromium profile after normal cleanup.

- Vite binds `127.0.0.1` to an OS-assigned exclusive port (`port: 0`), with HMR off.
- Chromium uses an owned fresh profile and its normal sandbox. Never append
  `--no-sandbox` or disable the setuid sandbox to work around a launch failure.
- Total deadline is 180 seconds, with a five-second forced-exit cleanup budget.
  UI waits are 15 seconds, startup 45 seconds, CPU render evidence 30 seconds.
- Browser/server handles are closed in `finally`; no shared process, port,
  database, user profile, toolchain, log or test binary is removed.
- Requests outside the exact loopback origin, `/api/`, `/health`, and runtime
  `/kernel/gpu/` and color-presenter imports are blocked and cause failure. Service workers are off,
  Chromium background networking is disabled, and non-loopback DNS is disabled.
  This is application network containment, not an OS network-namespace guarantee.

## Policy before application initialization

Chromium launch disables hardware acceleration, software rasterizers, WebGL,
WebGPU/Vulkan features and accelerated 2D canvas. Before any page application
module evaluates, `addInitScript` installs a frozen `coreDesktop.renderPolicy`
with `cpuOnly: true`. `KernelClient` snapshots that trusted launch policy at
module initialization; worker envelopes and CPU responses are checked.

The script never calls `requestAdapter`, WebGL, GPU compilation or GPU tests.
Passive guards fail if application code accesses graphics APIs. The worker's
existing immutable execution policy prevents GPU candidates; runtime GPU module
fetches are blocked. Successful evidence requires actual CPU worker output with
`backend: 'cpu'` and zero GPU compile time, before and after reload. Canvas 2D
CPU rasterization and screenshot capture remain allowed.

## Covered flows

1. Real React startup and CPU/WASM rendering.
2. Initial blank document, draw a rectangle, rename and save to owned disk bytes.
3. New document, explicit discard, reopen previous bytes.
4. Cancelled/malformed open preserves the current unsaved document.
5. Injected file-save failure preserves edits and previous disk bytes.
6. Repeated save/save-as is coalesced during a delayed save; an edit made during
   that save remains dirty after the older acknowledgement.
7. Save again, destroy the React session by reloading, reopen from disk.
8. Screenshots: `error-preserves-session.png`, `cpu-react-reopened.png`; JSON
   outcome and renderer evidence in `results.json`. Failure captures `failure.png`.

## Separately blocked Electron GUI stage

`frontend/design-desktop/scripts/smoke.mjs` requires an installed Electron runtime,
working display and sandbox, packaged renderer assets and native Rust sidecar.
At preparation time `/usr/bin/chromium` and installed Playwright/Vite were found;
`Xvfb` was absent and `frontend/design-desktop/node_modules/electron` was absent.
This does not establish whether a runtime is available elsewhere: the central
owner must resolve and verify it before any native launch. Do not install or
launch Electron as an implicit fallback. Existing native smoke invokes
`--desktop-smoke --core-cpu-only`; its comment explicitly excludes the current
cloud GPU-ban cohort. Thus no runnable Electron command is authorized here.

Do not run the older `check-desktop-lifecycle.ts` unchanged in this cohort: its
browser launch lacks CPU flags and its final ordinary web page defaults to auto
rendering. Browser smoke success must be reported separately from native
Electron/Rust filesystem coverage and must not be called a full test pass.

## Cloud attempt, 2026-10-09 18:59 UTC

The owned Chromium attempt stopped during browser startup: process singleton socket creation returned `Operation not permitted`. The application was not exercised, so this is blocked/unrun browser acceptance, not a rendering test pass. The external controller verified that its Node process was reaped, owned descendants were gone and the loopback listener was closed; no forced cleanup was needed. Chromium sandbox was not disabled and no bypass retry was made.

The startup log also showed Playwright's default `--enable-unsafe-swiftshader`. The script now explicitly excludes that default (and the default DevTools self-XSS warning bypass); existing GPU/WebGL/software-rasterizer disable flags remain. This source correction has not been validated by another browser launch. Native CPU and WASM/TypeScript test results remain separate from browser acceptance.
