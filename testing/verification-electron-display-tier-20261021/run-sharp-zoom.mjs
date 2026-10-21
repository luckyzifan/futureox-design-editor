// Fresh native Electron wheel input and actual compositor acknowledgements.
// No product files, CSP policy, document mutation or external process control.
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node testing/verification-electron-display-tier-20261021/run-sharp-zoom.mjs FIXTURE OUT [--expected-sharp] [--visual-audit] [--profile] [--interval-ms=16]');
  process.exit(0);
}
const [fixtureArg, outputArg, ...flags] = argv;
if (!fixtureArg || !outputArg || flags.some(flag => !['--expected-sharp', '--visual-audit', '--profile'].includes(flag) && !/^--interval-ms=\d+(\.\d+)?$/.test(flag)))
  throw Error('Expected FIXTURE OUT and documented flags; use --help');
const root = process.cwd(), fixture = path.resolve(fixtureArg), out = path.resolve(outputArg);
const desktop = path.resolve(process.env.DESIGN_DESKTOP_ROOT || path.join(root, 'frontend/design-desktop'));
const require = createRequire(path.join(root, 'frontend/design-client/package.json'));
const { _electron, expect } = require('@playwright/test');
const expectedSharp = flags.includes('--expected-sharp'), visualAudit = flags.includes('--visual-audit'), profile = flags.includes('--profile');
const intervalMs = Number(flags.find(flag => flag.startsWith('--interval-ms='))?.split('=')[1] || 16);
if (!(intervalMs >= 1 && intervalMs <= 1000)) throw Error('Input interval must be 1..1000 ms');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(out, { recursive: false }); await mkdir(path.join(out, 'profiles'));
const report = { status: 'running', startedAt: new Date().toISOString(), fixture: path.basename(fixture),
  fixtureSha256: hash(await readFile(fixture)), harnessSha256: hash(await readFile(new URL(import.meta.url))),
  runtime: { node: process.version, v8: process.versions.v8 }, mode: visualAudit ? 'visual-audit' : 'latency', profile,
  profileScope: profile ? 'renderer-only CDP CPU profile; no worker or native sampler' : 'disabled',
  scope: 'Owned fresh Electron session. Real Control-wheel through Playwright. Worker presentation messages are submission acknowledgements, not GPU-completion or photon/FPS measurements. No rAF rate is used.',
  instrumentation: 'A Worker constructor Proxy delegates Reflect.construct without changing arguments/prototype/postMessage. A separate message listener copies numeric presentation metadata only. The visual-only RPC uses existing display-capture-content and consumes only its own negative-ID replies.',
  workload: { startZoom: 1, checkpoints: [7, 32], reverseTo: 1, wheelGain: .003, maximumDelta: 12, intervalMs,
    cadenceMeaning: 'Requested input pacing, not a display refresh-rate claim. Actual trusted event timestamps are retained.' },
  gate: { expectedSharp, maxAckLagMs: 80, tolerance: 1e-7, passed: false, violations: [],
    meaning: '80 ms is an explicit candidate native-input-to-submission-ACK goal. Camera-request lag is also retained. Missing quality measurements, undersampling, holes, missing handles or unacknowledged inputs cannot pass.' },
  errors: [], stages: [], visual: [] };
await writeFile(path.join(out, 'build-manifest.json'), await readFile(path.join(desktop, 'dist/build-manifest.json')));
const artifacts = {};
for (const name of await readdir(path.join(desktop, 'dist/renderer/assets'))) {
  const file = path.join(desktop, 'dist/renderer/assets', name);
  artifacts[name] = hash(await readFile(file));
}
await writeFile(path.join(out, 'runtime-artifacts.json'), JSON.stringify({ captured: 'before launch', artifacts }, null, 2));
const save = () => writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const logWrites = [];
let app, page, ownedPid, phase = 'startup', tracing = false;

function quantile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : null; }
function sameCamera(a, b) { return !!a && !!b && ['x', 'y', 'zoom'].every(key => Number.isFinite(a[key]) && Number.isFinite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-7); }
function assess(trace) {
  const failures = [], firstInput = trace.inputs[0]?.at, lastInput = trace.inputs.at(-1)?.at;
  const acks = trace.acks.filter(ack => ack.at >= firstInput), requests = trace.requests.filter(request => request.inputSequence > 0);
  const lags = [], inputLags = [], pending = [];
  for (const [index, ack] of acks.entries()) {
    const matched = requests.findLastIndex(request => request.at <= ack.at && sameCamera(request.camera, ack.camera));
    const wanted = requests.findLastIndex(request => request.at <= ack.at);
    const earliestPending = requests.slice(Math.max(0, matched + 1), wanted + 1)[0];
    pending.push({ acknowledgement: index, latestRequest: wanted, matchingRequest: matched,
      pendingLagMs: earliestPending ? Math.max(0, ack.at - earliestPending.at) : 0 });
    if (!ack.qualityFresh || !Number.isFinite(ack.coverageAt)) failures.push({ kind: 'quality-not-fresh', acknowledgement: index });
    if (ack.pixelCoverageComplete !== true || ack.nativeCoverageComplete !== true || ack.coverage !== 1 || ack.sharpCoverage !== 1)
      failures.push({ kind: 'incomplete-or-under-density', acknowledgement: index, coverage: ack.coverage, sharp: ack.sharpCoverage,
        pixelComplete: ack.pixelCoverageComplete, nativeComplete: ack.nativeCoverageComplete });
    if (!Number.isFinite(ack.maxUpscale) || ack.maxUpscale > 1 + report.gate.tolerance)
      failures.push({ kind: 'upscaled-content', acknowledgement: index, maxUpscale: ack.maxUpscale });
    if (ack.missingTextureCount !== 0) failures.push({ kind: 'missing-texture', acknowledgement: index, count: ack.missingTextureCount });
  }
  // Newer camera ACKs may supersede intermediate inputs. They do not erase the
  // earlier input's waiting time, nor allow a frozen old camera to look fast.
  const ackRequestIndices = acks.map(ack => requests.findLastIndex(request => request.at <= ack.at && sameCamera(request.camera, ack.camera)));
  for (const [index, request] of requests.entries()) {
    const at = acks.findIndex((ack, i) => ack.at >= request.at && ackRequestIndices[i] >= index);
    const lag = at < 0 ? null : acks[at].at - request.at;
    lags.push({ request: index, inputSequence: request.inputSequence, acknowledgement: at, lagMs: lag });
    if (lag === null || lag > report.gate.maxAckLagMs) failures.push({ kind: 'camera-ack-lag', request: index, lagMs: lag, limitMs: 80 });
  }
  for (const input of trace.inputs) {
    const at = acks.findIndex((ack, i) => ack.at >= input.at && ackRequestIndices[i] >= 0 &&
      requests[ackRequestIndices[i]].inputSequence >= input.sequence);
    const lag = at < 0 ? null : acks[at].at - input.at;
    inputLags.push({ inputSequence: input.sequence, acknowledgement: at, lagMs: lag,
      eventDispatchDelayMs: input.observedAt - input.at });
    if (lag === null || lag > report.gate.maxAckLagMs) failures.push({ kind: 'input-ack-lag', inputSequence: input.sequence, lagMs: lag, limitMs: 80 });
  }
  if (!trace.inputs.length || !acks.length || !requests.length) failures.push({ kind: 'missing-input-camera-or-acknowledgement' });
  if (trace.dropped) failures.push({ kind: 'trace-overflow', dropped: trace.dropped });
  if (trace.inputs.some(input => !input.trusted || !input.ctrl || input.mode !== 0)) failures.push({ kind: 'unexpected-input' });
  if (trace.inputs.some(input => !Number.isFinite(input.at) || !Number.isFinite(input.observedAt) || input.observedAt < input.at - 1))
    failures.push({ kind: 'invalid-native-event-clock' });
  if (!(trace.setupMaximumAcknowledgedZoom <= 1 + 1e-7)) failures.push({ kind: 'setup-previsited-high-zoom', zoom: trace.setupMaximumAcknowledgedZoom });
  const zooms = requests.map(request => request.camera.zoom);
  if (Math.max(0, ...zooms) < 32 - 1e-6) failures.push({ kind: 'did-not-request-3200-percent' });
  if (Math.abs((requests.at(-1)?.camera.zoom ?? NaN) - 1) > 1e-6) failures.push({ kind: 'did-not-return-to-100-percent' });
  const gaps = trace.inputs.slice(1).map((input, index) => input.at - trace.inputs[index].at);
  return { violations: failures, pending, requestAcknowledgements: lags, inputAcknowledgements: inputLags, acknowledgementCount: acks.length,
    motionAcknowledgements: acks.filter(ack => ack.at <= lastInput).length,
    settlingAcknowledgements: acks.filter(ack => ack.at > lastInput).length,
    measuredQualityCount: acks.filter(ack => ack.qualityFresh).length,
    minimumSharpCoverage: Math.min(1, ...acks.map(ack => ack.sharpCoverage ?? 0)),
    maximumUpscale: Math.max(1, ...acks.map(ack => ack.maxUpscale ?? Infinity)),
    maximumRequestedZoom: Math.max(0, ...zooms), maximumAcknowledgedZoom: Math.max(0, ...acks.map(ack => ack.camera.zoom || 0)),
    inputToAckMs: { p50: quantile(inputLags.flatMap(row => row.lagMs === null ? [] : [row.lagMs]), .5),
      p95: quantile(inputLags.flatMap(row => row.lagMs === null ? [] : [row.lagMs]), .95),
      max: inputLags.some(row => row.lagMs === null) ? null : Math.max(0, ...inputLags.map(row => row.lagMs)) },
    requestToAckMs: { p50: quantile(lags.flatMap(row => row.lagMs === null ? [] : [row.lagMs]), .5),
      p95: quantile(lags.flatMap(row => row.lagMs === null ? [] : [row.lagMs]), .95),
      max: lags.some(row => row.lagMs === null) ? null : Math.max(0, ...lags.map(row => row.lagMs)) },
    actualInputGapsMs: { p50: quantile(gaps, .5), p95: quantile(gaps, .95), max: Math.max(0, ...gaps) } };
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)));
  const args = [desktop, '--desktop-gui-test', `--desktop-gui-test-owner=${hash(out).slice(0, 16)}`,
    ...(process.env.DESIGN_TEST_PASSIVE === '1' ? ['--disable-features=MacWebContentsOcclusion', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] : [])];
  app = await _electron.launch({ executablePath: require(path.join(desktop, 'node_modules/electron')), args,
    env: { ...env, TMPDIR: path.join(out, 'profiles'), CORE_RENDER_DIAGNOSTICS: 'detail' }, chromiumSandbox: true, timeout: 60000 });
  ownedPid = app.process().pid;
  await writeFile(path.join(out, 'owned-test-process.json'), JSON.stringify({ pid: ownedPid, desktop, args, profile: path.join(out, 'profiles') }, null, 2));
  for (const [name, stream] of [['stdout', app.process().stdout], ['stderr', app.process().stderr]])
    stream?.on('data', bytes => logWrites.push(appendFile(path.join(out, `host-${name}.log`), bytes)));
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push({ phase, error: String(error) }));
  await page.waitForURL(/^design-app:/);
  await page.addInitScript(({ visualAudit }) => {
    const now = () => performance.timeOrigin + performance.now(), numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const state = window.__sharpZoom = { recording: false, phase: 'setup', inputs: [], requests: [], acks: [], dropped: 0,
      visual: [], visualTasks: [], visualMilestones: new Set(), latestAck: undefined, latestWorker: undefined, startAt: 0, endAt: 0,
      trackSetup: false, setupMaximumAcknowledgedZoom: 0 };
    const append = (list, row) => { if (list.length < 20000) list.push(row); else state.dropped++; };
    const camera = view => view && { x: numeric(view.x), y: numeric(view.y), zoom: numeric(view.zoom) };
    const owned = new Map(), observedWorkers = new Set(), workerInfo = new WeakMap(); let rpcId = -900000000;
    const OriginalWorker = window.Worker;
    const watch = worker => worker.addEventListener('message', event => {
      const data = event.data, request = data && owned.get(data.id);
      if (request && request.worker === worker) {
        // This response belongs only to the harness's read-only command. Letting
        // KernelClient treat it as an unknown request would close its bitmap.
        event.stopImmediatePropagation(); owned.delete(data.id); clearTimeout(request.timer); request.resolve(data); return;
      }
      const p = data?.presentation, shown = p?.presented;
      if (!shown?.view || p.compositor !== 'webgpu-resident') return;
      const info = workerInfo.get(worker);
      if (info) { info.protocol = 'render'; info.presentationObserved = true; }
      const ack = { at: now(), phase: state.phase, submittedEpoch: numeric(p.submittedEpoch),
        diagnosticSequence: numeric(p.diagnosticSequence), compositorFrames: numeric(p.compositorFrames),
        presentationId: typeof shown.presentationId === 'string' ? shown.presentationId : null,
        camera: camera(shown.view), width: numeric(shown.width), height: numeric(shown.height), dpr: numeric(shown.dpr),
        ids: Array.isArray(shown.ids) ? shown.ids.filter(Number.isSafeInteger) : [], interaction: shown.interaction === true,
        coverage: numeric(p.coverage), sharpCoverage: numeric(p.sharpCoverage), nativePhaseCoverage: numeric(p.nativePhaseCoverage),
        maxUpscale: numeric(p.maxUpscale), missingTextureCount: numeric(p.missingTextureCount),
        pixelCoverageComplete: p.pixelCoverageComplete === true, nativeCoverageComplete: p.nativeCoverageComplete === true,
        qualityFresh: p.coverageMeasured === true, coverageAt: numeric(p.coverageAt),
        owner: { worker: numeric(p.deviceWorkerScope), incarnation: numeric(p.deviceIncarnation), owner: numeric(p.deviceOwner) } };
      state.latestAck = ack; state.latestWorker = worker;
      if (state.trackSetup && !state.recording) state.setupMaximumAcknowledgedZoom = Math.max(state.setupMaximumAcknowledgedZoom, ack.camera.zoom || 0);
      if (state.recording) append(state.acks, ack);
      if (!visualAudit || !state.recording) return;
      const targets = [state.phase.startsWith('up-') && ack.camera.zoom >= 6.9 ? 'up-near-700' : undefined,
        state.phase.startsWith('up-') && ack.camera.zoom >= 31 ? 'up-near-3200' : undefined,
        state.phase === 'down-to-100' && ack.camera.zoom <= 7 && ack.camera.zoom >= 1.01 ? 'down-below-700' : undefined];
      for (const target of targets) if (target && !state.visualMilestones.has(target)) {
        state.visualMilestones.add(target); state.enqueueCapture(target);
      }
    });
    // Reflect preserves native construction/newTarget, prototype and method
    // behavior. No document/options payload is inspected or copied here.
    window.Worker = new Proxy(OriginalWorker, { construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      let script = null, protocol = 'unknown';
      try {
        // Inspect only the already-used script URL, never a document message.
        if (typeof args[0] === 'string' || args[0] instanceof URL) {
          const url = new URL(args[0], location.href);
          if (['design-app:', 'http:', 'https:', 'file:'].includes(url.protocol)) {
            const name = url.pathname.split('/').at(-1);
            if (name && name.length <= 256) script = name;
          }
        }
        if (/^render-worker(?:[-.]|$)/.test(script || '')) protocol = 'render';
        else if (/^import-worker(?:[-.]|$)/.test(script || '')) protocol = 'import';
        else if (/^geometry-worker(?:[-.]|$)/.test(script || '')) protocol = 'geometry';
        else if (/^preparation-worker(?:[-.]|$)/.test(script || '')) protocol = 'preparation';
      } catch { /* Unknown protocol is reported; it is never probed speculatively. */ }
      workerInfo.set(worker, { workerIndex: observedWorkers.size, script, protocol, presentationObserved: false });
      observedWorkers.add(worker); watch(worker); return worker;
    } });
    const ownedRead = (worker, command, timeoutMs = 15000) => {
      if (!worker || !['display-capture-content', 'gpu-memory'].includes(command))
        return Promise.reject(Error('Owned read-only worker command unavailable'));
      const id = --rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { owned.delete(id); reject(Error('Owned ' + command + ' request timed out')); }, timeoutMs);
        owned.set(id, { worker, resolve, timer });
        try { worker.postMessage({ command, id }); }
        catch (error) { owned.delete(id); clearTimeout(timer); reject(error); }
      });
    };
    state.readGpuMemoryWorkers = async () => {
      if (state.recording) throw Error('GPU memory observation cannot overlap the measured zoom interval');
      const rows = [], workers = [...observedWorkers];
      for (const worker of workers) {
        const info = workerInfo.get(worker), requestedAt = now();
        const row = { ...info, role: info.protocol === 'render'
          ? info.presentationObserved ? 'render-compositor' : 'render-raster' : info.protocol,
          latestCompositorWorker: worker === state.latestWorker, requestedAt, response: null };
        if (info.protocol !== 'render') {
          rows.push({ ...row, status: 'unsupported-role', completedAt: now() }); continue;
        }
        try {
          // Sequential and bounded: an old terminated render worker may never
          // answer. Preserve that error and still inspect the remaining owners.
          const response = await ownedRead(worker, 'gpu-memory', 3000);
          rows.push({ ...row, response, status: response.error || !response.gpuMemory ? 'error' : 'ok',
            ...(response.error || !response.gpuMemory ? { error: String(response.error || 'Missing GPU memory observation') } : {}), completedAt: now() });
        } catch (error) { rows.push({ ...row, status: 'error', error: String(error), completedAt: now() }); }
      }
      return rows;
    };
    state.capture = async label => {
      const worker = state.latestWorker, startedAt = now();
      if (!worker) { state.visual.push({ label, error: 'No observed compositor worker' }); return; }
      let bitmap;
      try {
        const result = await ownedRead(worker, 'display-capture-content');
        bitmap = result.bitmap;
        if (result.error || !bitmap || !result.contentFrame) throw Error(result.error || 'Missing actual content snapshot');
        const frame = result.contentFrame, canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); if (!context) throw Error('Content PNG canvas unavailable');
        context.drawImage(bitmap, 0, 0);
        const matched = state.acks.findLastIndex(ack => ack.presentationId === (frame.presentationId ?? null) &&
          ack.camera.x === frame.view.x && ack.camera.y === frame.view.y && ack.camera.zoom === frame.view.zoom &&
          ack.width === frame.width && ack.height === frame.height && ack.dpr === frame.dpr &&
          ack.ids.length === frame.ids.length && ack.ids.every((id, i) => id === frame.ids[i]));
        state.visual.push({ label, startedAt, completedAt: now(), frame, matchedAcknowledgement: matched,
          width: bitmap.width, height: bitmap.height, png: canvas.toDataURL('image/png'),
          source: 'Existing GPU backbuffer capture, before overlay; worker waited for submitted GPU work.' });
      } catch (error) { state.visual.push({ label, startedAt, completedAt: now(), error: String(error) }); }
      finally { bitmap?.close(); }
    };
    let visualChain = Promise.resolve();
    state.enqueueCapture = label => { const task = visualChain.then(() => state.capture(label));
      visualChain = task; state.visualTasks.push(task); };
    window.addEventListener('wheel', event => {
      if (!state.recording) return;
      const observedAt = now(), at = event.timeStamp > 1e12 ? event.timeStamp : performance.timeOrigin + event.timeStamp;
      append(state.inputs, { sequence: state.inputs.length + 1, at, observedAt, eventTimeStamp: event.timeStamp,
        phase: state.phase, trusted: event.isTrusted,
        x: event.deltaX, y: event.deltaY, mode: event.deltaMode, ctrl: event.ctrlKey, clientX: event.clientX, clientY: event.clientY });
    }, { capture: true, passive: true });
    state.readRequest = () => {
      const data = document.querySelector('.kernel-presentation')?.dataset;
      if (!data) return;
      const value = { x: Number(data.requestedCameraX), y: Number(data.requestedCameraY), zoom: Number(data.requestedCameraZoom) };
      if (!Object.values(value).every(Number.isFinite)) return;
      const previous = state.requests.at(-1)?.camera;
      if (previous && Object.keys(value).every(key => value[key] === previous[key])) return;
      append(state.requests, { at: now(), phase: state.phase, inputSequence: state.inputs.length, camera: value });
    };
    new MutationObserver(() => { if (state.recording) state.readRequest(); }).observe(document, {
      subtree: true, attributes: true, attributeFilter: ['data-requested-camera-x', 'data-requested-camera-y', 'data-requested-camera-zoom'] });
  }, { visualAudit });
  // Reload only this new, still-unimported test window, so worker observation
  // starts before renderer creation. No user session or other app is touched.
  await page.reload(); await page.waitForURL(/^design-app:/);
  report.host = await app.evaluate(async ({ app, BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 960); w.webContents.setBackgroundThrottling(false);
    if (process.env.DESIGN_TEST_PASSIVE === '1') {
      if (process.platform === 'darwin') app.setActivationPolicy('accessory');
      w.setFocusable(false); w.setIgnoreMouseEvents(true); w.setOpacity(.01); w.showInactive(); w.blur();
    } else { w.show(); w.focus(); }
    return { versions: process.versions, prefs: w.webContents.getLastWebPreferences(), profile: app.getPath('userData'),
      visible: w.isVisible(), opacity: w.getOpacity(), backgroundThrottling: w.webContents.getBackgroundThrottling(),
      display: screen.getDisplayMatching(w.getBounds()), gpu: await app.getGPUInfo('basic') };
  });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 120000 });
  const resume = page.getByRole('button', { name: /^继续编辑 · / }); if (await resume.isVisible()) await resume.click();
  await expect(page.locator('.local-home')).toHaveCount(0);
  const settle = async () => {
    await page.waitForFunction(() => document.querySelector('.kernel-status.error') ||
      document.querySelector('.kernel-presentation')?.dataset.presentationReady === 'true' &&
      document.querySelector('.kernel-presentation')?.dataset.previewActive === 'false' &&
      document.querySelector('.kernel-tiles')?.dataset.detailReady === 'true', null, { timeout: 120000 });
    const snapshot = await page.evaluate(() => ({ at: performance.timeOrigin + performance.now(),
      presentation: { ...document.querySelector('.kernel-presentation')?.dataset },
      compositor: { ...document.querySelector('.kernel-compositor')?.dataset },
      errors: [...document.querySelectorAll('.kernel-status.error')].map(element => element.textContent) }));
    if (snapshot.errors.length || snapshot.presentation.fallbackPhase !== 'none') throw Error('Canvas failed: ' + JSON.stringify(snapshot));
    return snapshot;
  };
  phase = 'import';
  await page.evaluate(() => { window.__sharpZoom.trackSetup = true; });
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture);
  const documentName = path.basename(fixture).replace(/\.(sketch|fig|fd)$/i, '');
  await expect(page.getByLabel('文档名称', { exact: true })).toHaveValue(documentName, { timeout: 120000 });
  await expect(page.locator('.document-transition')).toHaveCount(0, { timeout: 120000 });
  await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 120000 });
  await settle();
  const stored = () => page.evaluate(async name => {
    const bridge = window.coreDesktop.workspace, list = await bridge.list();
    if (list.status !== 'ok') throw Error('workspace.list: ' + JSON.stringify({ status: list.status, code: list.code, message: list.message }));
    const item = list.documents.find(item => item.name === name && !item.deleted);
    if (!item) throw Error('Owned imported document missing');
    const result = await bridge.open({ id: item.id });
    if (result.status !== 'ok') throw Error('workspace.open: ' + JSON.stringify({ status: result.status, code: result.code, message: result.message }));
    return JSON.parse(result.documentJson);
  }, documentName);
  const document = await stored(); report.documentSha256 = hash(JSON.stringify(document));
  const candidates = [], walk = id => { const node = document.nodes[id]; if (!node || node.visible === false) return; candidates.push(node); node.children.forEach(walk); };
  document.pages[0].children.forEach(walk);
  const requestedAnchor = (process.env.DESIGN_ANCHOR_ID && candidates.find(node => node.id === process.env.DESIGN_ANCHOR_ID)) ||
    (process.env.DESIGN_ANCHOR_NAME && candidates.find(node => node.name === process.env.DESIGN_ANCHOR_NAME));
  if ((process.env.DESIGN_ANCHOR_ID || process.env.DESIGN_ANCHOR_NAME) && !requestedAnchor) throw Error('Requested original anchor is absent');
  const selected = requestedAnchor ||
    candidates.find(node => node.name === '组合 51') || candidates.find(node => node.kind === 'text') || candidates[0];
  if (!selected) throw Error('No visible original anchor');
  const notice = page.getByRole('complementary', { name: '导入兼容提示' }); if (await notice.count()) await notice.getByRole('button', { name: '关闭导入提示' }).click();
  await page.getByLabel('搜索图层', { exact: true }).fill(selected.name);
  await page.getByTestId(`layer-${selected.id}`).click(); await page.getByLabel('搜索图层', { exact: true }).fill('');
  await page.getByLabel('缩放与视图设置', { exact: true }).click();
  const zoomInput = page.getByLabel('缩放比例', { exact: true }); await zoomInput.fill('100'); await zoomInput.press('Enter');
  if (await zoomInput.isVisible()) await page.getByLabel('缩放与视图设置', { exact: true }).click();
  await settle();
  // Center the original anchor by real panning at 100%, never by Shift+2 or a
  // high-zoom fit that could prepopulate the very cache being measured.
  const canvas = page.getByTestId('canvas'); report.anchor = { id: selected.id, name: selected.name, pans: [] };
  await canvas.focus(); await page.keyboard.press('v');
  for (let attempt = 0; attempt < 24; attempt++) {
    const geometry = await page.getByTestId('canvas-selection-outline').evaluate(element => {
      const matrix = element.getScreenCTM(), points = (element.getAttribute('points') || '').trim().split(/\s+/).map(pair => pair.split(',').map(Number));
      if (!matrix || !points.length) throw Error('Original selection geometry unavailable');
      const transformed = points.map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
      const left = Math.min(...transformed.map(point => point.x)), top = Math.min(...transformed.map(point => point.y));
      const right = Math.max(...transformed.map(point => point.x)), bottom = Math.max(...transformed.map(point => point.y));
      return { x: left + (right - left) * .59, y: top + (bottom - top) * .42 };
    });
    const box = await canvas.boundingBox(); if (!box) throw Error('Canvas bounds unavailable');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const dx = center.x - geometry.x, dy = center.y - geometry.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) { report.anchor.pointer = geometry; break; }
    const move = { x: Math.max(-box.width * .35, Math.min(box.width * .35, dx)), y: Math.max(-box.height * .35, Math.min(box.height * .35, dy)) };
    await canvas.focus(); await page.keyboard.down('Space');
    try { await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(center.x + move.x, center.y + move.y, { steps: 8 }); await page.mouse.up(); }
    finally { await page.keyboard.up('Space'); }
    report.anchor.pans.push(move); await settle();
  }
  if (!report.anchor.pointer) throw Error('Could not center the original anchor using bounded 100% pans');
  const before = await settle();
  if (Number(before.presentation.requestedCameraZoom) !== 1) throw Error('Fresh sweep must begin at exactly 100%');
  report.before = before;
  if (profile) await app.evaluate(async ({ BrowserWindow }) => {
    const debug = BrowserWindow.getAllWindows()[0].webContents.debugger; debug.attach('1.3');
    globalThis.__sharpZoomProfiler = debug; await debug.sendCommand('Profiler.enable');
    await debug.sendCommand('Profiler.setSamplingInterval', { interval: 1000 }); await debug.sendCommand('Profiler.start');
  });
  await page.evaluate(() => { const s = window.__sharpZoom; s.inputs = []; s.requests = []; s.acks = []; s.recording = true;
    s.phase = 'up-to-700'; s.startAt = performance.timeOrigin + performance.now(); s.readRequest(); });
  tracing = true; const scripted = []; let nextEventAt = performance.now();
  await canvas.focus(); await page.mouse.move(report.anchor.pointer.x, report.anchor.pointer.y); await page.keyboard.down('Control');
  try {
    for (const [name, start, target] of [['up-to-700', 1, 7], ['up-to-3200', 7, 32], ['down-to-100', 32, 1]]) {
      phase = name; await page.evaluate(name => { window.__sharpZoom.phase = name; }, name);
      const began = Date.now(), total = -Math.log(target / start) / .003, count = Math.ceil(Math.abs(total) / 12);
      for (let i = 0; i < count; i++) {
        const delta = i === count - 1 ? total - Math.sign(total) * 12 * (count - 1) : Math.sign(total) * 12;
        const wait = nextEventAt - performance.now(); if (wait > 0) await delay(wait);
        const sentAt = Date.now(); await page.mouse.wheel(0, delta);
        scripted.push({ phase: name, delta, sentAt, returnedAt: Date.now() }); nextEventAt += intervalMs;
      }
      report.stages.push({ name, from: start, to: target, inputCount: count, wallStart: began, wallEnd: Date.now(), settledBetweenStages: false });
    }
  } finally { await page.keyboard.up('Control'); }
  phase = 'settling'; await page.evaluate(() => { window.__sharpZoom.phase = 'settling'; });
  await page.waitForFunction(count => window.__sharpZoom.inputs.length === count &&
    Math.abs(Number(document.querySelector('.kernel-presentation')?.dataset.requestedCameraZoom) - 1) < 1e-6,
  scripted.length, { timeout: 20000 });
  report.after = await settle();
  if (profile) {
    const result = await app.evaluate(async () => { const debug = globalThis.__sharpZoomProfiler; const result = await debug.sendCommand('Profiler.stop'); debug.detach(); return result; });
    await writeFile(path.join(out, 'renderer.cpuprofile'), JSON.stringify(result.profile));
  }
  if (visualAudit) await page.evaluate(async () => { const s = window.__sharpZoom; s.enqueueCapture('settled-return-100'); await Promise.all(s.visualTasks); });
  const trace = await page.evaluate(() => { const s = window.__sharpZoom; s.recording = false; s.endAt = performance.timeOrigin + performance.now();
    return { startAt: s.startAt, endAt: s.endAt, inputs: s.inputs, requests: s.requests, acks: s.acks, dropped: s.dropped,
      setupMaximumAcknowledgedZoom: s.setupMaximumAcknowledgedZoom }; });
  tracing = false;
  await writeFile(path.join(out, 'zoom-trace.json'), JSON.stringify({ scripted, ...trace }, null, 2));
  const actual = trace.inputs;
  if (actual.length !== scripted.length || actual.some((input, i) => Math.abs(input.y - scripted[i].delta) > 1e-7 || input.x !== 0))
    report.errors.push({ phase: 'input-validation', error: 'Actual native wheel sequence differs from scripted input' });
  const assessment = assess(trace); report.gate = { ...report.gate, ...assessment, passed: assessment.violations.length === 0 };
  if (visualAudit) {
    for (const [i, capture] of (await page.evaluate(() => window.__sharpZoom.visual)).entries()) {
      const { png, ...metadata } = capture;
      if (png) { const file = `visual-${i}-${capture.label}.png`; const bytes = Buffer.from(png.split(',')[1], 'base64'); await writeFile(path.join(out, file), bytes); metadata.file = file; metadata.sha256 = hash(bytes); }
      report.visual.push(metadata);
      if (metadata.error || metadata.matchedAcknowledgement < 0) report.errors.push({ phase: 'visual-audit', error: metadata.error || 'GPU content snapshot has no matching observed ACK' });
    }
    for (const label of ['up-near-700', 'up-near-3200', 'down-below-700', 'settled-return-100'])
      if (!report.visual.some(capture => capture.label === label && capture.file))
        report.errors.push({ phase: 'visual-audit', error: 'No bound GPU content capture for ' + label });
    report.visualLimit = 'A few bound GPU snapshots audit appearance; they do not prove every pixel of every intermediate frame. ACK coverage/density checks still cover every observed content submission.';
  }
  // Trace recording already ended above. This existing read-only command may
  // queue behind GPU work; none of its latency enters the motion/ACK metrics.
  report.gpuMemoryWorkers = await page.evaluate(() => window.__sharpZoom.readGpuMemoryWorkers());
  const compositorMemory = report.gpuMemoryWorkers.find(row => row.latestCompositorWorker && row.status === 'ok');
  report.gpuMemory = compositorMemory?.response.gpuMemory ?? null;
  report.gpuMemoryObservation = { afterTraceEndAt: trace.endAt,
    observedWorkers: report.gpuMemoryWorkers.length, queriedRenderWorkers: report.gpuMemoryWorkers.filter(row => row.protocol === 'render').length,
    errors: report.gpuMemoryWorkers.filter(row => row.status === 'error').map(row => ({ workerIndex: row.workerIndex, role: row.role, error: row.error })) };
  report.documentPreserved = hash(JSON.stringify(await stored())) === report.documentSha256;
  report.sourceFilePreserved = hash(await readFile(fixture)) === report.fixtureSha256;
  if (!report.documentPreserved || !report.sourceFilePreserved) report.errors.push({ phase: 'preservation', error: 'Navigation changed persisted document or source fixture' });
  report.status = report.errors.length || expectedSharp && !report.gate.passed ? 'failed' : 'completed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ phase, error: String(error) });
} finally {
  if (page && !page.isClosed() && tracing) {
    const trace = await page.evaluate(() => { const s = window.__sharpZoom; s.recording = false;
      return { startAt: s.startAt, endAt: performance.timeOrigin + performance.now(), inputs: s.inputs, requests: s.requests, acks: s.acks, dropped: s.dropped,
        setupMaximumAcknowledgedZoom: s.setupMaximumAcknowledgedZoom }; }).catch(() => undefined);
    if (trace) { await writeFile(path.join(out, 'interrupted-zoom-trace.json'), JSON.stringify(trace, null, 2)); report.gate = { ...report.gate, ...assess(trace), passed: false }; }
  }
  if (app) {
    const child = app.process(); let timer;
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned app close timed out')), 15000); })]); }
    catch (error) {
      report.status = 'failed'; report.errors.push({ phase: 'close', error: String(error) });
      if (child.pid === ownedPid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); report.ownedCloseEscalated = true; }
    } finally { clearTimeout(timer); }
  }
  await Promise.allSettled(logWrites); report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, expectedSharp, sharpGatePassed: report.gate.passed,
    violations: report.gate.violations.length, acknowledgementCount: report.gate.acknowledgementCount, output: out }));
  if (report.status !== 'completed') process.exitCode = 1;
}
