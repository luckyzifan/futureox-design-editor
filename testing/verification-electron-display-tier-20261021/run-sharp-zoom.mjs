// Fresh native Electron wheel input and actual compositor acknowledgements.
// No product files, CSP policy, document mutation or external process control.
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import visualClassifier from './visual-omission.cjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node testing/verification-electron-display-tier-20261021/run-sharp-zoom.mjs FIXTURE OUT [--expected-sharp] [--visual-audit] [--profile] [--stress] [--cycles=3] [--interval-ms=16] [--reference-budget-mib=1024]');
  console.log('--reference-budget-mib requires --visual-audit and changes only the independent after-trace reference Worker GPU working budget (integer 256..4096 MiB). The actual app policy is unchanged.');
  process.exit(0);
}
const [fixtureArg, outputArg, ...flags] = argv;
if (!fixtureArg || !outputArg || flags.some(flag => !['--expected-sharp', '--visual-audit', '--profile', '--stress'].includes(flag) && !/^--(?:interval-ms=\d+(\.\d+)?|cycles=[1-6]|reference-budget-mib=\d+)$/.test(flag)))
  throw Error('Expected FIXTURE OUT and documented flags; use --help');
const root = process.cwd(), fixture = path.resolve(fixtureArg), out = path.resolve(outputArg);
const desktop = path.resolve(process.env.DESIGN_DESKTOP_ROOT || path.join(root, 'frontend/design-desktop'));
const require = createRequire(path.join(root, 'frontend/design-client/package.json'));
const { _electron, expect } = require('@playwright/test');
const expectedSharp = flags.includes('--expected-sharp'), visualAudit = flags.includes('--visual-audit'), profile = flags.includes('--profile');
const stress = flags.includes('--stress'), cycles = Number(flags.find(flag => flag.startsWith('--cycles='))?.split('=')[1] || 3);
if (!stress && flags.some(flag => flag.startsWith('--cycles='))) throw Error('--cycles requires --stress');
const referenceBudgetFlags = flags.filter(flag => flag.startsWith('--reference-budget-mib='));
if (referenceBudgetFlags.length > 1 || referenceBudgetFlags.length && !visualAudit)
  throw Error('A single --reference-budget-mib requires --visual-audit');
const referenceBudgetMiB = visualClassifier.validateReferenceBudgetMiB(referenceBudgetFlags.length
  ? Number(referenceBudgetFlags[0].split('=')[1]) : undefined);
// Fixed before any capture/reference is observed. This is a sampled missing-
// content detector, not a general pixel-equality or perceptual-quality gate.
const visualThresholds = Object.freeze({ nearWhiteMin: 250, transparentMaxAlpha: 4, referenceOpaqueMinAlpha: 240,
  backgroundTolerance: 4, referenceContentContrast: 32, referenceInteriorRadius: 1, minimumDifference: 32,
  componentMinPixels: 256, componentMinSide: 8, reportedComponentLimit: 32 });
const intervalMs = Number(flags.find(flag => flag.startsWith('--interval-ms='))?.split('=')[1] || 16);
if (!(intervalMs >= 1 && intervalMs <= 1000)) throw Error('Input interval must be 1..1000 ms');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(out, { recursive: false }); await mkdir(path.join(out, 'profiles'));
const report = { status: 'running', startedAt: new Date().toISOString(), fixture: path.basename(fixture),
  fixtureSha256: hash(await readFile(fixture)), harnessSha256: hash(await readFile(new URL(import.meta.url))),
  runtime: { node: process.version, v8: process.versions.v8 }, mode: visualAudit ? 'visual-audit' : 'latency', profile,
  profileScope: profile ? 'Actual renderer and CDP-auto-attached worker CPU profiles around the same motion trace; no native sampler' : 'disabled',
  latencyTimingComparable: !visualAudit && !profile,
  ...(visualAudit ? { visualThresholds, visualClassifierVersion: 2,
    visualClassifierSha256: hash(await readFile(new URL('./visual-omission.cjs', import.meta.url))),
    referenceBudgetPolicy: { requestedOverrideMiB: referenceBudgetMiB ?? null, actualAppPolicyUnchanged: true,
      scope: 'Only the independent OriginalWorker created after the motion trace receives this optional GPU working-budget override. Readback, precision, samples, viewport and pixel thresholds are unchanged. Reference memory allowance is not product working-budget acceptance.' },
    visualTimingScope: 'Separate correctness run with bound content captures (additional mixed-pan samples in stress mode). Its timing must not be used as a latency comparison. References execute only after trace recording stops.' } : {}),
  scope: 'Owned fresh Electron session. Real Control-wheel through Playwright. Worker presentation messages are submission acknowledgements, not GPU-completion or photon/FPS measurements. No rAF rate is used.',
  instrumentation: 'A Worker constructor Proxy delegates Reflect.construct without changing constructor arguments/prototype. Its postMessage observer delegates unchanged arguments and retains only the six boolean execution-policy fields and optional integer gpuWorkingBudgetMiB (256..4096) already supplied by the host. A separate listener copies numeric presentation metadata. Owned read-only RPCs consume only their own negative-ID replies; GPU memory queries send the observed policy without weakening worker validation.',
  workload: { startZoom: 1, checkpoints: stress ? [32, .25, 16, 32] : [7, 32], reverseTo: 1, wheelGain: .003,
    maximumDelta: stress ? 96 : 12, intervalMs, stress, cycles: stress ? cycles : 1,
    ...(stress ? { mixedPans: 'Ten real Space-drag gestures per cycle at 3200%, 25%, 1600% and 100%; repeated forward/reverse exposures, no settle between actions.',
      wheelAnchors: [[.18, .20], [.82, .78], [.50, .50]], anchorPolicy: 'One fixed canvas-space wheel anchor within each whole round trip; different spatial regions across cycles.',
      ...(visualAudit ? { extraVisualSampling: 'Two reserved captures per cycle: first bound ACK during pan-32-out and pan-0.25-return, each at most once. Readbacks are serialized and add overhead; this audit is not a clean latency comparison.',
        expectedExtraVisualLabels: visualClassifier.stressVisualCaptureLabels(cycles) } : {}) } : {}),
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
let app, page, ownedPid, phase = 'startup', tracing = false, profilerAttached = false, profilerStopped = false;

const stopProfiles = async interrupted => {
  if (!profile || !profilerAttached || profilerStopped || !app) return;
  profilerStopped = true;
  try {
    const result = await app.evaluate(async () => {
      const state = globalThis.__sharpZoomProfiler;
      if (!state) throw Error('Owned CPU profiler state unavailable');
      state.active = false; state.stopping = true;
      await state.drain();
      // Capture the started sessions after pending attachment/start operations
      // settled. A later attachment must not be mistaken for a sampled target.
      const entries = [state.main, ...state.sessions.values()].filter(entry => entry.started && !entry.stopped);
      const profiles = await Promise.all(entries.map(async entry => {
        const stopCommandAt = Date.now();
        try {
          const result = await state.debug.sendCommand('Profiler.stop', {}, entry.sessionId);
          entry.stopped = true;
          return { target: entry.target, sessionId: entry.sessionId ?? null, startedAt: entry.startedAt,
            stopCommandAt, stoppedAt: Date.now(), sourceURLs: [...new Set(result.profile.nodes
              .map(node => node.callFrame?.url).filter(url => typeof url === 'string' && url.length))], profile: result.profile };
        } catch (error) {
          state.errors.push({ operation: 'Profiler.stop', target: entry.target, sessionId: entry.sessionId ?? null, error: String(error) });
          return null;
        }
      }));
      try { await state.debug.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }); }
      catch (error) { state.errors.push({ operation: 'Target.setAutoAttach(false)', error: String(error) }); }
      finally { state.debug.removeListener('message', state.onMessage); if (state.debug.isAttached()) state.debug.detach(); }
      return { profiles: profiles.filter(Boolean), errors: state.errors, targets: state.targets, events: state.events,
        activeSessionsAtStop: entries.map(entry => ({ target: entry.target, sessionId: entry.sessionId ?? null })) };
    });
    const targets = [];
    for (const [index, row] of result.profiles.entries()) {
      const { profile: data, ...metadata } = row, file = `continuous-wheel-${index}.cpuprofile`;
      await writeFile(path.join(out, file), JSON.stringify(data)); targets.push({ ...metadata, file });
      if (row.target.type === 'page') await writeFile(path.join(out, 'renderer.cpuprofile'), JSON.stringify(data));
    }
    await writeFile(path.join(out, 'continuous-wheel-targets.json'), JSON.stringify(targets, null, 2));
    report.cpuProfiles = { interrupted, ...result, profiles: undefined, files: targets,
      capturedWorkerProfiles: targets.filter(row => row.target.type === 'worker').length,
      capturedRenderWorkerProfiles: targets.filter(row => row.target.type === 'worker' && /(?:^|\/)render-worker(?:[-.]|$)/.test(row.target.url)).length };
    for (const error of result.errors) report.errors.push({ phase: 'cpu-profile', ...error });
    if (!report.cpuProfiles.capturedRenderWorkerProfiles)
      report.errors.push({ phase: 'cpu-profile', error: 'No actual render-worker CPU profile was retrieved; inspect continuous-wheel-targets.json and attachment errors' });
  } catch (error) { report.errors.push({ phase: 'cpu-profile-stop', error: String(error) }); }
};

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
  const panLags = (trace.panInputs || []).map(input => {
    const index = acks.findIndex((ack, i) => ack.at >= input.at && ackRequestIndices[i] >= 0 &&
      requests[ackRequestIndices[i]].panInputSequence >= input.sequence);
    return { panInputSequence: input.sequence, acknowledgement: index, lagMs: index < 0 ? null : acks[index].at - input.at };
  });
  for (const row of panLags) if (row.lagMs === null || row.lagMs > report.gate.maxAckLagMs)
    failures.push({ kind: 'pan-input-ack-lag', ...row, limitMs: 80 });
  if ((trace.panInputs || []).some(input => !input.trusted || input.ctrl || input.buttons !== 1))
    failures.push({ kind: 'unexpected-pan-input' });
  return { violations: failures, pending, requestAcknowledgements: lags, inputAcknowledgements: inputLags,
    panInputAcknowledgements: panLags, panInputCount: panLags.length, acknowledgementCount: acks.length,
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
  await page.addInitScript({ path: fileURLToPath(new URL('./visual-omission.cjs', import.meta.url)) });
  await page.addInitScript(({ visualAudit, visualThresholds, stress, cycles, referenceBudgetMiB }) => {
    const now = () => performance.timeOrigin + performance.now(), numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const state = window.__sharpZoom = { recording: false, phase: 'setup', inputs: [], panInputs: [], requests: [], acks: [], dropped: 0,
      visual: [], visualTasks: [], visualMilestones: new Set(), latestAck: undefined, latestWorker: undefined, startAt: 0, endAt: 0,
      trackSetup: false, setupMaximumAcknowledgedZoom: 0, spaceHeld: false, stressCaptureLabels: new Set(), stressCapturePending: false };
    const append = (list, row) => { if (list.length < 20000) list.push(row); else state.dropped++; };
    const camera = view => view && { x: numeric(view.x), y: numeric(view.y), zoom: numeric(view.zoom) };
    const owned = new Map(), observedWorkers = new Set(), workerInfo = new WeakMap(), workerLaunch = new WeakMap(); let rpcId = -900000000;
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
        workerIndex: info?.workerIndex,
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
        (state.phase === 'down-to-100' || stress && state.phase.startsWith('down-')) && ack.camera.zoom <= 7 && ack.camera.zoom >= 1.01 ? 'down-below-700' : undefined];
      for (const target of targets) if (target && !state.visualMilestones.has(target)) {
        state.visualMilestones.add(target); state.enqueueCapture(target);
      }
      const stressLabel = stress && window.__sharpNextStressVisualCapture(state.phase, cycles,
        state.stressCaptureLabels, state.stressCapturePending);
      if (stressLabel) {
        state.stressCaptureLabels.add(stressLabel); state.stressCapturePending = true;
        state.enqueueCapture(stressLabel)
          .finally(() => { state.stressCapturePending = false; });
      }
    });
    // Reflect preserves native construction/newTarget and prototype. The
    // method observer delegates all arguments unchanged and copies only the
    // six boolean host-policy fields and optional validated working-budget
    // metadata; never document or options payloads. An omitted budget stays
    // omitted, matching the exact policy envelope rather than a guessed default.
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
      workerLaunch.set(worker, { url: args[0], options: args[1] });
      const originalPost = worker.postMessage;
      worker.postMessage = function (...messageArgs) {
        const info = workerInfo.get(this), message = messageArgs[0], policy = message?.executionPolicy;
        const keys = ['cpuOnly', 'hdrCompositing', 'imageMips', 'imageAtlas', 'desktopFullMath', 'desktopDisplay'];
        const budget = policy?.gpuWorkingBudgetMiB;
        if (info?.protocol === 'render' && policy && keys.every(key => typeof policy[key] === 'boolean') &&
            (budget === undefined || Number.isInteger(budget) && budget >= 256 && budget <= 4096)) {
          info.executionPolicy = { ...Object.fromEntries(keys.map(key => [key, policy[key]])),
            ...(budget === undefined ? {} : { gpuWorkingBudgetMiB: budget }) };
        }
        return Reflect.apply(originalPost, this, messageArgs);
      };
      observedWorkers.add(worker); watch(worker); return worker;
    } });
    const ownedRead = (worker, command, timeoutMs = 15000) => {
      if (!worker || !['display-capture-content', 'gpu-memory'].includes(command))
        return Promise.reject(Error('Owned read-only worker command unavailable'));
      const executionPolicy = command === 'gpu-memory' ? workerInfo.get(worker)?.executionPolicy : undefined;
      if (command === 'gpu-memory' && !executionPolicy)
        return Promise.reject(Error('No observed host execution policy for GPU memory query'));
      const id = --rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { owned.delete(id); reject(Error('Owned ' + command + ' request timed out')); }, timeoutMs);
        owned.set(id, { worker, resolve, timer });
        try { worker.postMessage({ command, id, ...(executionPolicy ? { executionPolicy } : {}) }); }
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
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) throw Error('Content PNG canvas unavailable');
        context.drawImage(bitmap, 0, 0);
        const workerIndex = workerInfo.get(worker)?.workerIndex;
        const matched = state.acks.findLastIndex(ack => Number.isSafeInteger(workerIndex) && ack.workerIndex === workerIndex &&
          ack.presentationId === (frame.presentationId ?? null) &&
          ack.camera.x === frame.view.x && ack.camera.y === frame.view.y && ack.camera.zoom === frame.view.zoom &&
          ack.width === frame.width && ack.height === frame.height && ack.dpr === frame.dpr &&
          ack.ids.length === frame.ids.length && ack.ids.every((id, i) => id === frame.ids[i]));
        const acknowledgement = state.acks[matched];
        state.visual.push({ label, startedAt, completedAt: now(), frame, matchedAcknowledgement: matched,
          workerIndex, nativeContentFrameHasDeviceOwner: false,
          ownerBinding: 'Device owner tags are derived from the matching ACK of this same observed Worker. Native contentFrame directly supplies frame/camera/DPR/texture IDs, not device-owner tags.',
          acknowledgement: acknowledgement ? { owner: acknowledgement.owner, qualityFresh: acknowledgement.qualityFresh,
            coverage: acknowledgement.coverage, sharpCoverage: acknowledgement.sharpCoverage,
            maxUpscale: acknowledgement.maxUpscale, missingTextureCount: acknowledgement.missingTextureCount,
            pixelCoverageComplete: acknowledgement.pixelCoverageComplete, nativeCoverageComplete: acknowledgement.nativeCoverageComplete } : null,
          pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
          width: bitmap.width, height: bitmap.height, png: canvas.toDataURL('image/png'),
          source: 'Existing GPU backbuffer capture, before overlay; worker waited for submitted GPU work.' });
      } catch (error) { state.visual.push({ label, startedAt, completedAt: now(), error: String(error) }); }
      finally { bitmap?.close(); }
    };
    let visualChain = Promise.resolve();
    state.enqueueCapture = label => { const task = visualChain.then(() => state.capture(label));
      visualChain = task; state.visualTasks.push(task); return task; };
    state.referenceVisuals = async ({ documentJson, pageId }) => {
      if (state.recording) throw Error('Reference rendering cannot overlap the motion trace');
      await Promise.all(state.visualTasks);
      const source = JSON.parse(documentJson), fonts = Object.values(source.fonts || {}), imageSources = new Set();
      let invalidFontPayloads = 0, invalidImagePayloads = 0;
      let pageBackground;
      const background = source.pages?.find(page => page.id === pageId)?.background;
      if (typeof background === 'string' && CSS.supports('color', background)) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (context) { context.clearRect(0, 0, 1, 1); context.fillStyle = background; context.fillRect(0, 0, 1, 1);
          pageBackground = [...context.getImageData(0, 0, 1, 1).data]; }
      }
      for (const font of fonts) if (typeof font.data !== 'string' || !font.data.length) invalidFontPayloads++;
      for (const node of Object.values(source.nodes || {})) for (const paint of [
        ...(node.fills || []), ...(node.strokes || []).map(stroke => stroke.paint),
      ]) if (paint?.visible !== false && paint?.kind === 'image') {
        if (typeof paint.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(paint.image)) invalidImagePayloads++;
        else imageSources.add(paint.image);
      }
      const worker = state.latestWorker, info = workerInfo.get(worker), launch = workerLaunch.get(worker);
      const observedExecutionPolicy = info?.executionPolicy ? { ...info.executionPolicy } : null;
      const metadata = { afterTrace: true, fontPayloadCount: fonts.length, imageSourceCount: imageSources.size,
        invalidFontPayloads, invalidImagePayloads, sourceWorkerIndex: info?.workerIndex,
        ownerBinding: 'Actual capture matched an ACK from the same Worker; native contentFrame does not itself certify device-owner tags.',
        ...(pageBackground ? { pageBackgroundRGBA: pageBackground } : {}),
        observedExecutionPolicy, referenceExecutionPolicy: null, requestedOverrideMiB: referenceBudgetMiB ?? null,
        actualAppPolicyUnchanged: true, rasterProfile: 'figmaSubpixel', readback: true,
        referenceBudgetMeaning: 'A reference-only working-budget override is not a product budget or latency pass.',
        method: 'Independent original render worker; exact readback at each captured camera and physical DPR, existing previewTileFallback only.' };
      let reference;
      const pending = new Map(); let next = 0;
      const unavailable = message => { for (const capture of state.visual) if (!capture.error)
        capture.reference = { available: false, error: message, ...metadata }; };
      try {
        if (!launch || !info?.executionPolicy || invalidFontPayloads || invalidImagePayloads)
          throw Error('Reference source, font/image payloads or observed execution policy unavailable');
        const referencePolicy = window.__sharpReferenceExecutionPolicy(observedExecutionPolicy, referenceBudgetMiB);
        metadata.referenceExecutionPolicy = referencePolicy;
        // Legacy metadata alias; the actual app policy is recorded separately.
        metadata.executionPolicy = referencePolicy;
        // Reuse the actual worker URL and clone its observed policy. Only this
        // independent after-trace worker may receive the explicit budget
        // override; the app Worker and its observed policy are never changed.
        reference = new OriginalWorker(launch.url, { ...launch.options, name: 'owned-sharp-screen-reference' });
        reference.onmessage = event => {
          const data = event.data, request = pending.get(data?.id);
          if (!request) { data?.bitmap?.close?.(); return; }
          if (!data.error && !data.backend && !(data.buffer instanceof ArrayBuffer) && !data.gpuMemory) return;
          pending.delete(data.id); clearTimeout(request.timer); request.resolve(data);
        };
        reference.onerror = () => { for (const request of pending.values()) {
          clearTimeout(request.timer); request.reject(Error('Independent reference worker failed'));
        } pending.clear(); };
        const request = payload => new Promise((resolve, reject) => {
          const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('Independent reference timed out')); }, 120000);
          pending.set(id, { resolve, reject, timer });
          try { reference.postMessage({ id, ...payload, executionPolicy: referencePolicy }); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
        for (const capture of state.visual) {
          if (capture.error) continue;
          let referenceBitmap, resultMemory = null;
          try {
            if (capture.matchedAcknowledgement < 0 || !capture.acknowledgement || !capture.pixels)
              throw Error('Actual content pixels are not bound to an observed owner/camera acknowledgement');
            if (!['worker', 'incarnation', 'owner'].every(key => Number.isFinite(capture.acknowledgement.owner?.[key])))
              throw Error('Actual content snapshot lacks complete observed GPU owner tags');
            const frame = capture.frame, dpr = frame.dpr, width = capture.width, height = capture.height;
            if (![dpr, frame.view.x, frame.view.y, frame.view.zoom].every(Number.isFinite) || dpr <= 0 ||
                width !== Math.round(frame.width * dpr) || height !== Math.round(frame.height * dpr))
              throw Error('Capture physical dimensions or camera are invalid');
            const startedAt = now(), result = await request({
              document: documentJson, documentRevision: 1, backend: 'webgpu', readback: true, png: false,
              options: { pageId, width, height, view: { x: frame.view.x * dpr, y: frame.view.y * dpr, zoom: frame.view.zoom * dpr },
                transparent: false, grid: false, checkerboard: false, rasterProfile: 'figmaSubpixel',
                renderIntent: 'preview', livePreview: true, previewTileFallback: true },
            });
            resultMemory = Object.fromEntries(['workingBudgetBytes', 'workingTextureBytes', 'peakTextureBytes', 'finishTransientBytes']
              .map(key => [key, typeof result[key] === 'number' && Number.isFinite(result[key]) ? result[key] : null]));
            referenceBitmap = result.bitmap;
            if (result.error || result.backend !== 'webgpu' || !(result.buffer instanceof ArrayBuffer) || result.buffer.byteLength !== width * height * 4)
              throw Error(result.error || 'Reference did not return complete original GPU RGBA8 pixels');
            const actual = capture.pixels, expected = new Uint8Array(result.buffer), count = width * height;
            const suspect = new Uint8Array(count), contrast = visualThresholds.referenceContentContrast,
              interior = visualThresholds.referenceInteriorRadius, histogram = new Uint32Array(256);
            const difference = new Uint8ClampedArray(count * 4);
            let sum = 0, max = 0, differentPixels = 0, unexpectedTransparent = 0, unexpectedWhite = 0, unexpectedBackground = 0,
              ignoredTransparentPageBackgroundPixels = 0;
            const marked = (at, againstBackground = false) => expected[at * 4 + 3] >= visualThresholds.referenceOpaqueMinAlpha &&
              (againstBackground ? Math.max(...[0, 1, 2].map(ch => Math.abs(expected[at * 4 + ch] - pageBackground[ch]))) >= contrast :
                255 - Math.min(expected[at * 4], expected[at * 4 + 1], expected[at * 4 + 2]) >= contrast);
            for (let at = 0; at < count; at++) {
              const offset = at * 4, x = at % width, y = Math.floor(at / width); let largest = 0;
              for (let ch = 0; ch < 3; ch++) {
                const delta = Math.abs(actual[offset + ch] - expected[offset + ch]);
                sum += delta; histogram[delta]++; max = Math.max(max, delta); largest = Math.max(largest, delta);
                difference[offset + ch] = Math.min(255, delta * 4);
              }
              difference[offset + 3] = 255; if (largest) differentPixels++;
              const transparent = window.__sharpTransparentContentOmission(actual[offset + 3], expected, offset, pageBackground, visualThresholds);
              if (!transparent && actual[offset + 3] <= visualThresholds.transparentMaxAlpha &&
                  expected[offset + 3] >= visualThresholds.referenceOpaqueMinAlpha) ignoredTransparentPageBackgroundPixels++;
              let white = actual[offset + 3] >= visualThresholds.referenceOpaqueMinAlpha &&
                Math.min(actual[offset], actual[offset + 1], actual[offset + 2]) >= visualThresholds.nearWhiteMin &&
                largest >= visualThresholds.minimumDifference && marked(at);
              let clear = !!pageBackground && largest >= visualThresholds.minimumDifference &&
                [0, 1, 2, 3].every(ch => Math.abs(actual[offset + ch] - pageBackground[ch]) <= visualThresholds.backgroundTolerance) && marked(at, true);
              for (let delta = 1; (white || clear) && delta <= interior; delta++) {
                if (x < delta || x + delta >= width || y < delta || y + delta >= height) { white = clear = false; break; }
                const neighbors = [at - delta, at + delta, at - width * delta, at + width * delta];
                if (white && !neighbors.every(neighbor => marked(neighbor))) white = false;
                if (clear && !neighbors.every(neighbor => marked(neighbor, true))) clear = false;
              }
              if (transparent) unexpectedTransparent++;
              if (white) unexpectedWhite++;
              if (clear) unexpectedBackground++;
              if (transparent || white || clear) suspect[at] = 1;
            }
            const queue = new Int32Array(count), components = []; let componentCount = 0, suspiciousComponentCount = 0;
            for (let seed = 0; seed < count; seed++) if (suspect[seed]) {
              let head = 0, tail = 1, left = width, right = -1, top = height, bottom = -1;
              queue[0] = seed; suspect[seed] = 0;
              while (head < tail) {
                const at = queue[head++], x = at % width, y = Math.floor(at / width);
                left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
                for (const neighbor of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
                  y ? at - width : -1, y + 1 < height ? at + width : -1]) if (neighbor >= 0 && suspect[neighbor]) {
                  suspect[neighbor] = 0; queue[tail++] = neighbor;
                }
              }
              componentCount++;
              if (tail >= visualThresholds.componentMinPixels && Math.min(right - left + 1, bottom - top + 1) >= visualThresholds.componentMinSide) {
                suspiciousComponentCount++;
                if (components.length < visualThresholds.reportedComponentLimit)
                  components.push({ pixels: tail, x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
              }
            }
            let cumulative = 0, p99 = 0;
            for (; p99 < 255; p99++) { cumulative += histogram[p99]; if (cumulative >= count * 3 * .99) break; }
            const output = document.createElement('canvas'); output.width = width; output.height = height;
            const context = output.getContext('2d'); if (!context) throw Error('Reference evidence canvas unavailable');
            context.putImageData(new ImageData(new Uint8ClampedArray(expected), width, height), 0, 0);
            const referencePng = output.toDataURL('image/png');
            context.putImageData(new ImageData(difference, width, height), 0, 0);
            context.strokeStyle = '#ff0000'; context.lineWidth = 2;
            for (const component of components) context.strokeRect(component.x, component.y, component.width, component.height);
            capture.reference = { ...metadata, available: true, startedAt, completedAt: now(), targetContentFrame: { ...frame, ids: [...frame.ids] },
              previewTiles: result.previewTiles, previewLane: result.previewLane, resultMemory,
              referencePng, differencePng: output.toDataURL('image/png'),
              comparison: { physicalPixels: count, rgbMeanAbsolute: sum / (count * 3), rgbMaximum: max, rgbP99: p99,
                differentPixels, unexpectedTransparentPixels: unexpectedTransparent, ignoredTransparentPageBackgroundPixels,
                unexpectedWhiteMarkedPixels: unexpectedWhite,
                unexpectedBackgroundMarkedPixels: unexpectedBackground,
                connectedComponents: componentCount, suspiciousComponentCount, reportedComponents: components,
                sampledOmissionPassed: suspiciousComponentCount === 0,
                meaning: 'Only large near-white/transparent/page-background actual regions with contrasting expected content are flagged. Other pixel differences are report-only and may include undersampling/AA/filter differences.' } };
          } catch (error) { capture.reference = { ...metadata, available: false, resultMemory, error: String(error) }; }
          finally { referenceBitmap?.close?.(); delete capture.pixels; }
        }
        try {
          const result = await request({ command: 'gpu-memory' }), memory = result.gpuMemory;
          metadata.referenceFinalMemoryObservation = {
            workingBudgetBytes: Number.isFinite(memory?.rendererPolicy?.workingBudgetBytes) ? memory.rendererPolicy.workingBudgetBytes : null,
            driverTextureBytes: Number.isFinite(memory?.driverStats?.textureBytes) ? memory.driverStats.textureBytes : null,
            backend: memory?.backend ?? null, deviceLost: memory?.deviceLost ?? null,
            error: result.error || (!memory ? 'Reference GPU memory snapshot unavailable' : null),
            meaning: 'Observed only on the independent reference Worker after all samples. Missing fields remain null; this is not the app memory ledger.' };
        } catch (error) { metadata.referenceFinalMemoryObservation = { workingBudgetBytes: null, driverTextureBytes: null,
          backend: null, deviceLost: null, error: String(error) }; }
      } catch (error) { unavailable(String(error)); }
      finally { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Reference worker closed')); }
        pending.clear(); reference?.terminate(); for (const capture of state.visual) delete capture.pixels; }
      return metadata;
    };
    window.addEventListener('wheel', event => {
      if (!state.recording) return;
      const observedAt = now(), at = event.timeStamp > 1e12 ? event.timeStamp : performance.timeOrigin + event.timeStamp;
      append(state.inputs, { sequence: state.inputs.length + 1, at, observedAt, eventTimeStamp: event.timeStamp,
        phase: state.phase, trusted: event.isTrusted,
        x: event.deltaX, y: event.deltaY, mode: event.deltaMode, ctrl: event.ctrlKey, clientX: event.clientX, clientY: event.clientY });
    }, { capture: true, passive: true });
    window.addEventListener('keydown', event => { if (event.code === 'Space') state.spaceHeld = true; }, true);
    window.addEventListener('keyup', event => { if (event.code === 'Space') state.spaceHeld = false; }, true);
    window.addEventListener('pointermove', event => {
      if (!state.recording || !state.spaceHeld || event.buttons !== 1) return;
      const observedAt = now(), at = event.timeStamp > 1e12 ? event.timeStamp : performance.timeOrigin + event.timeStamp;
      append(state.panInputs, { sequence: state.panInputs.length + 1, at, observedAt,
        phase: state.phase, trusted: event.isTrusted, ctrl: event.ctrlKey, buttons: event.buttons,
        clientX: event.clientX, clientY: event.clientY });
    }, { capture: true, passive: true });
    state.readRequest = () => {
      const data = document.querySelector('.kernel-presentation')?.dataset;
      if (!data) return;
      const value = { x: Number(data.requestedCameraX), y: Number(data.requestedCameraY), zoom: Number(data.requestedCameraZoom) };
      if (!Object.values(value).every(Number.isFinite)) return;
      const previous = state.requests.at(-1)?.camera;
      if (previous && Object.keys(value).every(key => value[key] === previous[key])) return;
      append(state.requests, { at: now(), phase: state.phase, inputSequence: state.inputs.length,
        panInputSequence: state.panInputs.length, camera: value });
    };
    new MutationObserver(() => { if (state.recording) state.readRequest(); }).observe(document, {
      subtree: true, attributes: true, attributeFilter: ['data-requested-camera-x', 'data-requested-camera-y', 'data-requested-camera-zoom'] });
  }, { visualAudit, visualThresholds, stress, cycles, referenceBudgetMiB });
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
      tiles: { ...document.querySelector('.kernel-tiles')?.dataset },
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
  if (process.env.DESIGN_CAPTURE_DOCUMENT === '1') await writeFile(path.join(out, 'fixture-document.json'), JSON.stringify(document));
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
  for (let attempt = 0; attempt <= 24; attempt++) {
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
    // The 25th observation checks the result of pan 24 and sends no input.
    if (attempt === 24) break;
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
  if (profile) {
    report.cpuProfileStart = await app.evaluate(async ({ BrowserWindow }) => {
    const debug = BrowserWindow.getAllWindows()[0].webContents.debugger; debug.attach('1.3');
    const state = globalThis.__sharpZoomProfiler = { debug, sessions: new Map(), pending: new Set(), errors: [],
      targets: [], events: [], active: false, stopping: false,
      main: { target: { type: 'page', url: BrowserWindow.getAllWindows()[0].webContents.getURL() }, started: false, stopped: false } };
    const error = (operation, entry, value) => state.errors.push({ operation, target: entry?.target,
      sessionId: entry?.sessionId ?? null, error: String(value) });
    state.drain = async () => { while (state.pending.size) await Promise.allSettled([...state.pending]); };
    state.startEntry = async entry => {
      if (entry.started || entry.starting || !state.active || state.stopping) return entry.starting;
      entry.starting = (async () => { try {
        const startedAt = Date.now(); await debug.sendCommand('Profiler.start', {}, entry.sessionId);
        entry.started = true; entry.startedAt = startedAt;
      } catch (value) { error('Profiler.start', entry, value); } })();
      try { await entry.starting; } finally { delete entry.starting; }
    };
    state.onMessage = (_event, method, params) => {
      if (method === 'Target.targetInfoChanged') {
        for (const entry of state.sessions.values()) if (entry.target.targetId === params.targetInfo.targetId)
          entry.target = params.targetInfo;
      }
      if (method === 'Target.detachedFromTarget') {
        const entry = state.sessions.get(params.sessionId); state.sessions.delete(params.sessionId);
        state.events.push({ method, sessionId: params.sessionId, at: Date.now(), active: state.active });
        if (entry?.started && !entry.stopped) error('Worker detached before profile retrieval', entry, Error('Target exited'));
      }
      if (method !== 'Target.attachedToTarget' || params.targetInfo.type !== 'worker') return;
      const entry = { target: params.targetInfo, sessionId: params.sessionId, started: false, stopped: false };
      state.sessions.set(params.sessionId, entry); state.targets.push({ target: params.targetInfo, sessionId: params.sessionId, attachedAt: Date.now() });
      state.events.push({ method, target: params.targetInfo, sessionId: params.sessionId, at: Date.now(), active: state.active });
      const pending = (async () => { try {
        await debug.sendCommand('Profiler.enable', {}, params.sessionId);
        await debug.sendCommand('Profiler.setSamplingInterval', { interval: 1000 }, params.sessionId);
        await state.startEntry(entry);
      } catch (value) { error('Worker profiler configuration', entry, value); }
      })().finally(() => state.pending.delete(pending)); state.pending.add(pending);
    };
    debug.on('message', state.onMessage);
    await debug.sendCommand('Profiler.enable');
    await debug.sendCommand('Profiler.setSamplingInterval', { interval: 1000 });
    await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await state.drain(); state.active = true;
    const startCommandAt = Date.now();
    await Promise.all([state.startEntry(state.main), ...[...state.sessions.values()].map(entry => state.startEntry(entry))]);
    await state.drain();
    return { startCommandAt, readyAt: Date.now(), workerSessions: state.sessions.size,
      errors: state.errors.slice(), boundary: 'Profiler starts precede trace start; all native sweep inputs occur after all attached targets are started. Stop follows trace end before references.' };
    });
    profilerAttached = true;
  }
  await page.evaluate(() => { const s = window.__sharpZoom; s.inputs = []; s.panInputs = []; s.requests = []; s.acks = []; s.recording = true;
    s.phase = 'up-to-700'; s.startAt = performance.timeOrigin + performance.now(); s.readRequest(); });
  tracing = true; const scripted = [], scriptedPans = []; let nextEventAt = performance.now(), controlHeld = true, stressWheelAnchor;
  await canvas.focus(); await page.mouse.move(report.anchor.pointer.x, report.anchor.pointer.y); await page.keyboard.down('Control');
  const zoomStage = async (name, start, target) => {
    phase = name; await page.evaluate(name => { window.__sharpZoom.phase = name; }, name);
    if (stressWheelAnchor) await page.mouse.move(stressWheelAnchor.x, stressWheelAnchor.y);
    if (!controlHeld) { await page.keyboard.down('Control'); controlHeld = true; }
    if (stress) nextEventAt = performance.now();
    const began = Date.now(), maximumDelta = stress ? 96 : 12, total = -Math.log(target / start) / .003,
      count = Math.ceil(Math.abs(total) / maximumDelta);
    for (let i = 0; i < count; i++) {
      const delta = i === count - 1 ? total - Math.sign(total) * maximumDelta * (count - 1) : Math.sign(total) * maximumDelta;
      const wait = nextEventAt - performance.now(); if (wait > 0) await delay(wait);
      const sentAt = Date.now(); await page.mouse.wheel(0, delta);
      scripted.push({ phase: name, delta, sentAt, returnedAt: Date.now() }); nextEventAt += intervalMs;
    }
    report.stages.push({ name, kind: 'wheel', from: start, to: target, inputCount: count, wallStart: began, wallEnd: Date.now(), settledBetweenStages: false });
  };
  const panStage = async (name, reverse, zoom) => {
    if (controlHeld) { await page.keyboard.up('Control'); controlHeld = false; }
    phase = name; await page.evaluate(name => { window.__sharpZoom.phase = name; }, name);
    const box = await canvas.boundingBox(); if (!box) throw Error('Stress canvas bounds unavailable');
    const from = { x: box.x + box.width * (reverse ? .78 : .22), y: box.y + box.height * (reverse ? .70 : .25) },
      to = { x: box.x + box.width * (reverse ? .22 : .78), y: box.y + box.height * (reverse ? .25 : .70) }, began = Date.now();
    await canvas.focus(); await page.keyboard.down('Space');
    try { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 16 }); await page.mouse.up(); }
    finally { await page.keyboard.up('Space'); }
    scriptedPans.push({ phase: name, from, to, zoom, steps: 16, wallStart: began, wallEnd: Date.now() });
    report.stages.push({ ...scriptedPans.at(-1), name, kind: 'pan', settledBetweenStages: false });
  };
  try {
    if (stress) {
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const box = await canvas.boundingBox(); if (!box) throw Error('Stress wheel canvas bounds unavailable');
        const point = [[.18, .20], [.82, .78], [.50, .50]][(cycle - 1) % 3];
        stressWheelAnchor = { x: box.x + box.width * point[0], y: box.y + box.height * point[1] };
        let previous = 1;
        for (const target of [32, .25, 16, 32, 1]) {
          await zoomStage(`${target > previous ? 'up' : 'down'}-cycle-${cycle}-to-${target}`, previous, target);
          await panStage(`cycle-${cycle}-pan-${target}-out`, false, target);
          await panStage(`cycle-${cycle}-pan-${target}-return`, true, target);
          previous = target;
        }
      }
    } else for (const [name, start, target] of [['up-to-700', 1, 7], ['up-to-3200', 7, 32], ['down-to-100', 32, 1]]) await zoomStage(name, start, target);
  } finally { await page.keyboard.up('Control'); await page.keyboard.up('Space'); }
  phase = 'settling'; await page.evaluate(() => { window.__sharpZoom.phase = 'settling'; });
  await page.waitForFunction(count => window.__sharpZoom.inputs.length === count &&
    Math.abs(Number(document.querySelector('.kernel-presentation')?.dataset.requestedCameraZoom) - 1) < 1e-6,
  scripted.length, { timeout: 20000 });
  report.after = await settle();
  if (visualAudit) await page.evaluate(async () => { const s = window.__sharpZoom; s.enqueueCapture('settled-return-100'); await Promise.all(s.visualTasks); });
  const trace = await page.evaluate(() => { const s = window.__sharpZoom; s.recording = false; s.endAt = performance.timeOrigin + performance.now();
    return { startAt: s.startAt, endAt: s.endAt, inputs: s.inputs, panInputs: s.panInputs, requests: s.requests, acks: s.acks, dropped: s.dropped,
      setupMaximumAcknowledgedZoom: s.setupMaximumAcknowledgedZoom }; });
  tracing = false;
  if (profile) report.cpuProfileTraceBoundary = { startAt: trace.startAt, endAt: trace.endAt, interrupted: false };
  await stopProfiles(false);
  await writeFile(path.join(out, 'zoom-trace.json'), JSON.stringify({ scripted, scriptedPans, ...trace }, null, 2));
  if (stress && (!trace.panInputs.length || scriptedPans.length !== cycles * 10))
    report.errors.push({ phase: 'stress-input-validation', error: 'Mixed native pan inputs or required gesture cycles were not observed' });
  const actual = trace.inputs;
  if (actual.length !== scripted.length || actual.some((input, i) => !visualClassifier.nativeWheelDeltaMatches(scripted[i].delta, input.y) || input.x !== 0))
    report.errors.push({ phase: 'input-validation', error: 'Actual native wheel sequence differs from scripted input' });
  const assessment = assess(trace); report.gate = { ...report.gate, ...assessment, passed: assessment.violations.length === 0 };
  if (visualAudit) {
    // Reference preparation, extra GPU work, comparisons and all PNG artifact
    // writes occur after the motion trace. Never insert these into latency mode.
    phase = 'post-motion-visual-reference';
    const unchanged = hash(JSON.stringify(await stored())) === report.documentSha256;
    if (unchanged) report.visualReference = { ...await page.evaluate(payload => window.__sharpZoom.referenceVisuals(payload),
      { documentJson: JSON.stringify(document), pageId: document.pages[0].id }), documentSha256: report.documentSha256 };
    else {
      report.visualReference = { afterTrace: true, available: false, documentPreservedBeforeReference: false };
      report.errors.push({ phase, error: 'Immutable document changed before screen reference; reference unavailable' });
    }
    const captures = await page.evaluate(() => window.__sharpZoom.visual.map(({ pixels, ...capture }) => capture));
    for (const [i, capture] of captures.entries()) {
      const { png, reference, ...metadata } = capture;
      if (png) { const file = `visual-${i}-${capture.label}.png`; const bytes = Buffer.from(png.split(',')[1], 'base64'); await writeFile(path.join(out, file), bytes); metadata.file = file; metadata.sha256 = hash(bytes); }
      if (reference) {
        const { referencePng, differencePng, ...details } = reference; metadata.reference = details;
        for (const [kind, data] of [['reference', referencePng], ['difference', differencePng]]) if (data) {
          const file = `visual-${i}-${capture.label}-${kind}.png`, bytes = Buffer.from(data.split(',')[1], 'base64');
          await writeFile(path.join(out, file), bytes); details[`${kind}File`] = file; details[`${kind}Sha256`] = hash(bytes);
        }
      }
      report.visual.push(metadata);
      if (metadata.error || metadata.matchedAcknowledgement < 0) report.errors.push({ phase: 'visual-audit', error: metadata.error || 'GPU content snapshot has no matching observed ACK' });
      if (metadata.acknowledgement?.missingTextureCount !== 0)
        report.errors.push({ phase: 'visual-audit', error: 'Bound content ACK reports missing or unavailable texture metadata' });
      if (!metadata.reference?.available) report.errors.push({ phase: 'visual-reference-unavailable',
        error: metadata.reference?.error || 'No complete original GPU screen reference for bound content capture' });
      else if (!metadata.reference.comparison.sampledOmissionPassed) report.errors.push({ phase: 'sampled-visual-inconsistency',
        error: `Large unexpected near-white/transparent/page-background content components in ${capture.label}; inspect actual/reference/difference PNGs` });
    }
    for (const label of visualClassifier.requiredVisualLabels)
      if (!report.visual.some(capture => capture.label === label && capture.file &&
          Number.isSafeInteger(capture.matchedAcknowledgement) && capture.matchedAcknowledgement >= 0 && !capture.error))
        report.errors.push({ phase: 'visual-audit', error: 'No bound GPU content capture for ' + label });
    if (stress) {
      const expectedLabels = visualClassifier.stressVisualCaptureLabels(cycles);
      const capturedLabels = report.visual.filter(capture => expectedLabels.includes(capture.label) && capture.file &&
        Number.isSafeInteger(capture.matchedAcknowledgement) && capture.matchedAcknowledgement >= 0 && !capture.error).map(capture => capture.label);
      const missingLabels = expectedLabels.filter(label => !capturedLabels.includes(label));
      report.stressVisualSampling = { maximumExtraSamples: cycles * 2, expectedLabels, capturedLabels, missingLabels,
        meaning: 'Each cycle reserves a high-zoom outward-pan and a wide-view return-pan capture. Missing bound captures remain failures; no later phase is substituted.' };
      for (const label of missingLabels) report.errors.push({ phase: 'visual-audit', error: 'No bound per-cycle stress capture for ' + label });
    }
    report.visualOmissionGate = { thresholds: visualThresholds,
      ...visualClassifier.assessSampledVisualOmission(report.visual, report.errors) };
    report.visualLimit = 'Four required milestones plus every additional sampled, owner/camera-bound actual content image compared to original fine screen references. References run only after trace end. Normal white reference regions are not missing-content evidence; other differences may be AA/undersampling/filter differences. This neither proves every intermediate frame nor yields comparable latency metrics.';
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
    if (trace) { await writeFile(path.join(out, 'interrupted-zoom-trace.json'), JSON.stringify(trace, null, 2)); report.gate = { ...report.gate, ...assess(trace), passed: false };
      if (profile) report.cpuProfileTraceBoundary = { startAt: trace.startAt, endAt: trace.endAt, interrupted: true }; }
  }
  await stopProfiles(true);
  if (app) {
    const child = app.process(); let timer;
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned app close timed out')), 15000); })]); }
    catch (error) {
      report.status = 'failed'; report.errors.push({ phase: 'close', error: String(error) });
      if (child.pid === ownedPid && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); report.ownedCloseEscalated = true; }
    } finally { clearTimeout(timer); }
  }
  await Promise.allSettled(logWrites);
  if (report.visualOmissionGate) report.visualOmissionGate = { thresholds: visualThresholds,
    ...visualClassifier.assessSampledVisualOmission(report.visual, report.errors) };
  report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, expectedSharp, sharpGatePassed: report.gate.passed,
    violations: report.gate.violations.length, acknowledgementCount: report.gate.acknowledgementCount, output: out }));
  if (report.status !== 'completed') process.exitCode = 1;
}
