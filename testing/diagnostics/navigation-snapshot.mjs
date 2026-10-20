/** Call via page.evaluate(navigationSnapshot) in an already-authorized test.
 * A bounded DOM snapshot only: no pixel readback, no rendering, no user content.
 * Capture deployed build revision and launch flags separately in the test report.
 */
export function navigationSnapshot() {
  const surface = document.querySelector('.kernel-tiles')
  const compositor = document.querySelector('[data-compositor="webgpu-resident"]')
  const fields = (element, keys) => Object.fromEntries(keys.map(key => [key, element?.dataset[key] ?? null]))
  return {
    at: performance.now(), timeOrigin: performance.timeOrigin, visibility: document.visibilityState, dpr: devicePixelRatio,
    webgpuApi: !!navigator.gpu, offscreenTransfer: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    surface: fields(surface, ['residentEligible', 'residentReason', 'navigationZoomActive', 'navigationZoomSequence',
      'navigationPendingAgeMs', 'previewActive', 'framePublication', 'revision', 'requestedCameraX', 'requestedCameraY',
      'requestedCameraZoom', 'progressiveTiles', 'viewportPreviewTiles']),
    compositor: fields(compositor, ['residentAttached', 'residentAttachmentReason', 'compositorFrames',
      'compositorCaptures', 'compositorUploads', 'presentedCamera', 'contentSequence']),
    semantics: { compositorFrames: 'GPU queue submissions, not scanout', contentSequence: 'object interaction input only; not camera refresh',
      viewportPreviewTiles: 'resident preview count, not update rate', presentedCamera: 'DEV-only submitted camera acknowledgement' },
  }
}

/** Run through page.evaluate(navigationTimeline, {action:'start'}), perform the
 * authorized gesture, then {action:'stop'}. No product hooks or pixel readback.
 * All timestamps are MAIN-THREAD OBSERVATION times, not worker/GPU/scanout times.
 * A missing transition cannot establish that the worker did not submit it.
 */
export function navigationTimeline(options = {}) {
  const key = '__coreNavigationDiagnosticTimeline'
  const action = options.action || 'snapshot'
  if (action !== 'start') {
    const current = globalThis[key]
    if (!current) return { recording: false, error: 'No navigation capture has been started' }
    if (action === 'stop') current.stop()
    return current.report()
  }
  globalThis[key]?.stop()
  const capacity = Number.isInteger(options.capacity) ? Math.min(4096, Math.max(16, options.capacity)) : 2048
  const durationMs = Number.isFinite(options.durationMs) ? Math.min(30000, Math.max(100, options.durationMs)) : 10000
  const ring = new Array(capacity)
  let count = 0, total = 0, head = 0, raf = 0, stopped = false, rafSamples = 0, mutationBatches = 0
  const start = performance.now(), origin = performance.timeOrigin
  const previous = new Map()
  const add = (stage, values) => {
    const row = { sequence: ++total, at: performance.now(), stage, ...values }
    ring[head] = row; head = (head + 1) % capacity; count = Math.min(count + 1, capacity)
  }
  const numeric = (data, fields) => Object.fromEntries(fields.map(name => {
    const raw = data?.[name], value = raw === undefined || raw === '' ? NaN : Number(raw)
    return [name, Number.isFinite(value) ? value : null]
  }))
  const changed = (stage, values) => {
    const signature = JSON.stringify(values)
    if (previous.get(stage) !== signature) { previous.set(stage, signature); add(stage, values) }
  }
  const observe = () => {
    if (stopped) return
    const surface = document.querySelector('.kernel-tiles')?.dataset
    const compositor = document.querySelector('[data-compositor="webgpu-resident"]')?.dataset
    changed('requested-camera-observed', numeric(surface, ['requestedCameraX', 'requestedCameraY', 'requestedCameraZoom']))
    changed('zoom-raster-target-observed', numeric(surface, ['navigationZoomSequence']))
    changed('raster-result-observed', numeric(surface, ['tilesRendered', 'cacheHits', 'compileMs', 'graphMs', 'finishMs', 'checkpointMs']))
    changed('publication-state-observed', { ...numeric(surface, ['revision', 'progressiveTiles', 'viewportPreviewTiles']),
      complete: surface?.framePublication === 'complete', detailReady: surface?.detailReady === 'true' })
    // These counters reach the main thread after a worker queue.submit. They
    // cannot supply that submission's exact timestamp or establish scanout.
    let camera = null
    const text = compositor?.presentedCamera
    if (text && text.length <= 256) {
      try {
        const parsed = JSON.parse(text)
        if (parsed && ['x', 'y', 'zoom'].every(k => typeof parsed[k] === 'number' && Number.isFinite(parsed[k])))
          camera = { x: parsed.x, y: parsed.y, zoom: parsed.zoom }
      } catch { /* Missing/malformed diagnostic data remains unknown. */ }
    }
    changed('resident-ack-observed', { ...numeric(compositor, ['compositorFrames', 'compositorUploads', 'compositorCaptures', 'contentSequence']), camera })
  }
  const frame = () => { if (!stopped) { rafSamples++; observe(); raf = requestAnimationFrame(frame) } }
  const input = event => { if (!stopped) add('input-event-observed', { type: event.type }) }
  const visibility = () => { if (!stopped) add('visibility', { visible: document.visibilityState === 'visible' }) }
  const root = document.querySelector('#design-canvas-view') || document.body
  const observer = new MutationObserver(() => { mutationBatches++; observe() })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [
    'data-requested-camera-x', 'data-requested-camera-y', 'data-requested-camera-zoom',
    'data-navigation-zoom-sequence', 'data-tiles-rendered', 'data-cache-hits', 'data-compile-ms',
    'data-graph-ms', 'data-finish-ms', 'data-checkpoint-ms', 'data-revision', 'data-progressive-tiles',
    'data-viewport-preview-tiles', 'data-frame-publication', 'data-detail-ready', 'data-compositor-frames',
    'data-compositor-uploads', 'data-compositor-captures', 'data-content-sequence', 'data-presented-camera',
  ] })
  const types = ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel']
  types.forEach(type => root.addEventListener(type, input, { passive: true }))
  document.addEventListener('visibilitychange', visibility)
  const timer = setTimeout(() => capture.stop(), durationMs)
  const capture = {
    stop() {
      if (stopped) return
      observe(); add('capture-stop', {}); stopped = true
      cancelAnimationFrame(raf); clearTimeout(timer); observer.disconnect()
      types.forEach(type => root.removeEventListener(type, input))
      document.removeEventListener('visibilitychange', visibility)
    },
    report() {
      const events = Array.from({ length: count }, (_, i) => ring[(head - count + i + capacity) % capacity])
      return { schema: 1, recording: !stopped, capacity, durationMs, dropped: Math.max(0, total - capacity),
        start, timeOrigin: origin, clock: 'main performance.now(); absolute = timeOrigin + at',
        observation: 'rAF and batched DOM mutations; not individual worker events, GPU duration or scanout',
        missingStages: ['actual worker raster admission', 'compile start/end timestamps', 'worker queue.submit timestamp', 'scanout'],
        semantics: { zoomRasterTarget: 'sample sequence, not actual raster start', rasterResult: 'aggregate durations/counters, not compile start/end',
          publication: 'state/count transitions; not a unique raster publication ID', residentAck: 'main observation of submission acknowledgement; intermediate updates can coalesce',
          contentSequence: 'object input only, not camera sequence', presentedCamera: 'DEV only; absent means unknown' },
        rafSamples, mutationBatches, events }
    },
  }
  globalThis[key] = capture
  add('capture-start', { visible: document.visibilityState === 'visible' }); observe()
  raf = requestAnimationFrame(frame)
  return capture.report()
}


/** Development-server entry point for real worker/main CPU event journals.
 * Use only on the authorized Core page. Production bundles do not expose this
 * Vite source URL: report unsupported rather than guessing another module.
 * Start before the measured gesture and stop afterward. Auto-stop is bounded.
 */
export async function navigationWorkerTimeline(options = {}) {
  const action = options.action || 'snapshot'
  if (!['start','stop','snapshot'].includes(action)) throw Error('Invalid navigation diagnostic action')
  const key = '__coreNavigationDiagnosticClients'
  if (action === 'start') {
    if (globalThis[key]) await Promise.allSettled(globalThis[key].map(client => client.navigationCapture('stop')))
    const {activeKernelClients} = await import('/src/kernel/client.ts')
    const clients = activeKernelClients()
    if (clients.length > 8) throw Error('Too many active render clients for bounded capture')
    globalThis[key] = [...clients]
  }
  const clients = globalThis[key] || []
  const results = await Promise.allSettled(clients.map(client => client.navigationCapture(action, action === 'start' ? {
    ...(options.capacity === undefined ? {} : {capacity:options.capacity}),
    ...(options.durationMs === undefined ? {} : {durationMs:options.durationMs}),
  } : undefined)))
  return { scope:'CPU scheduling; no GPU completion or scanout measurement',
    stageNames:{1:'main-raster-request-sent',2:'main-resident-camera-sent',3:'worker-raster-queue-admitted',
      4:'worker-compile-await-start',5:'worker-compile-await-end',6:'worker-display-message-received',
      7:'worker-resident-post-submit',8:'main-raster-result-received',9:'main-resident-ack-received',10:'worker-preview-cancel-received'},
    compileSemantics:'Await interval includes preparation IPC/cache/native compile; no claim of exclusive CPU compile time. Compile sequence is separate from request IDs.',
    publicationSemantics:'Stage 7 sequence changes when the bounded submitted texture-ID list changes; tiles is its count. This is resident raster-set publication, not new-pixel or scanout proof. Stage 8 is raster receipt only. Correlate with navigationTimeline publication-state observations.',
    alignment:'Within each client, compare main.timeOrigin + event.at with worker.timeOrigin + event.at; timer precision may be reduced.',
    clients:results.map((result,index)=>result.status==='fulfilled'?{index,...result.value}:{index,unavailable:true})}
}
