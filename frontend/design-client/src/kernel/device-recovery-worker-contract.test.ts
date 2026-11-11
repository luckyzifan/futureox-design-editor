import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { beginDeviceRecovery, deviceDiagnosticFields, deviceLifecyclePhase, registerDeviceDiagnosticOwner } from './gpu/device-lifecycle-diagnostics'
import { setGpuDiagnosticSink } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { recoverFailedTileRenderer } from './tile-failure'
import { recoverPreviewBudget } from './preview-budget-recovery'
import { DisplayCommandOrder } from './display-command-order'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('./render-worker.ts', import.meta.url), 'utf8')
afterEach(() => setGpuDiagnosticSink(undefined))
// Execute the actual worker recovery boundaries with the actual recovery helpers;
// no worker bootstrap, WASM, or GPU is needed for failure-lineage coverage.
for (const kind of ['tile', 'preview'] as const) test(`${kind} recovery failure retains predecessor identity for recreation`, async () => {
  const rows: any[] = [], original = Error('original abort failure')
  let disposals = 0, invalidations = 0
  const abort = async () => { throw original }
  const gpu = { driver: { abortFrameAndReleaseFilterScratch: abort }, abortFrameAndReleaseFilterScratch: abort, dispose() { disposals++ } }
  const identity = registerDeviceDiagnosticOwner(gpu.driver, {}, 1)
  setGpuDiagnosticSink((event, fields) => rows.push({ event, ...fields as object }))
  const note = source.slice(source.indexOf('function noteRetiredDevice('), source.indexOf('let displayCanvas:'))
    .replace('renderer: GpuRenderer | undefined', 'renderer')
  const tile = source.slice(source.indexOf('async function recoverTileFailure('), source.indexOf('let preference:'))
    .replace('error:unknown', 'error')
  const preview = source.slice(source.indexOf('const observation = beginDeviceRecovery(gpu?.driver, 3'),
    source.indexOf('\n          if (preservedPreview &&'))
    .replace(/\n\s*}\s*$/, '')
  const run = new Function('gpu', 'error', 'beginDeviceRecovery', 'deviceDiagnosticFields', 'deviceLifecyclePhase',
    'recoverFailedTileRenderer', 'recoverPreviewBudget', 'invalidateTileCache', `
      let previousDeviceDiagnostic = {}, diagnosticRequestId = 74, displayCanvas = {}, preservedPreview = false;
      const failureAttempt = (_stage, work) => work();
      ${note}
      ${kind === 'tile' ? tile : ''}
      return (async () => {
        let failure;
        try { ${kind === 'tile' ? 'await recoverTileFailure(error)' : preview} } catch (e) { failure = e }
        beginDeviceRecovery(undefined, 1, 75, previousDeviceDiagnostic).end(deviceLifecyclePhase.recoveryFailed);
        return { failure, gpu };
      })();`)
  const result = await run(gpu, Error('GPU 表面内存预算超限'), beginDeviceRecovery, deviceDiagnosticFields,
    deviceLifecyclePhase, recoverFailedTileRenderer, recoverPreviewBudget, () => invalidations++)
  expect(result.gpu).toBeUndefined(); expect(result.failure.cause).toBe(original)
  expect(disposals).toBe(1); expect(invalidations).toBe(1)
  expect(rows.find(row => row.deviceRecoveryKind === 1)).toMatchObject({
    requestId: 75, devicePreviousIncarnation: identity.deviceIncarnation, devicePhase: deviceLifecyclePhase.recoveryStart,
  })
})

test('a parked raster driver still receives the displayed bitmap receipt and the latest camera', () => {
  const presentFrame = vi.fn()
  const acceptPresentation = vi.fn()
  const driver = { attachPresenter: vi.fn(), presentFrame, acceptPresentation }
  const scheduled: Array<() => void> = []
  class TestMessageChannel {
    port1 = { onmessage: () => {} }
    port2 = { postMessage: () => scheduled.push(() => this.port1.onmessage()) }
  }
  const displayState = source.slice(source.indexOf('let displayCanvas:'), source.indexOf('const navigationJournal ='))
  const attach = source.slice(source.indexOf('let reportedResidentAttachment'), source.indexOf('async function recoverTileFailure'))
  const commands = source.slice(source.indexOf("  if(request.command==='display-accept')"), source.indexOf("  if(request.command==='display-read-pixel'"))
  const { code } = transformSync(`function createControl(driver, MessageChannel, DisplayCommandOrder, reportDisplay) {
    let gpu = { driver }
    const navigationJournal = { recording: false }
    const displayedOverlayAffines = () => undefined
    let poseSession
    ${displayState}
    ${attach}
    displayCanvas = {}
    prepareDisplay()
    return { parkRaster: () => { gpu = undefined }, dispatch: request => { ${commands} } }
  }`, { loader: 'ts', target: 'es2022' })
  const createControl = new Function(`${code}\nreturn createControl`)()
  const control = createControl(driver, TestMessageChannel, DisplayCommandOrder, vi.fn())

  const previous = { view: { x: 0, y: 0, zoom: .56 } }
  control.dispatch({ command: 'display-frame', sequence: 1, frame: previous })
  scheduled.shift()?.()
  expect(presentFrame).toHaveBeenCalledWith(previous)

  control.parkRaster()
  control.dispatch({ command: 'display-accept', token: 103, accepted: true })
  expect(acceptPresentation).toHaveBeenCalledExactlyOnceWith(103, true)
  const current = { view: { x: -10, y: -20, zoom: 1 } }
  control.dispatch({ command: 'display-frame', sequence: 2, frame: current })
  scheduled.shift()?.()
  expect(presentFrame).toHaveBeenLastCalledWith(current)
})
