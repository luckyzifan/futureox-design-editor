// CPU-only execution of literal harness control flow. No Electron/GPU/model substitute is used as rendering evidence.
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const sharp = await readFile(new URL('./run-sharp-zoom.mjs', import.meta.url), 'utf8');
const display = await readFile(new URL('./run-electron-display.mjs', import.meta.url), 'utf8');
const startupBegin = sharp.indexOf("  if (profile) {\n    await progress('profiler-start-requested');");
const startupEnd = sharp.indexOf("  await progress('native-pressure-start');", startupBegin);
const startup = sharp.slice(startupBegin, startupEnd);
const stopBegin = sharp.indexOf('const stopProfiles = async interrupted => {');
const stopEnd = sharp.indexOf('\nfunction quantile(', stopBegin);
assert.ok(startupBegin > 0 && startupEnd > startupBegin && stopEnd > stopBegin);

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve() }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Promise.resolve() }
  assert.fail('Controlled command did not reach its expected asynchronous boundary');
}
function fixture(behavior = () => undefined, attachWorker = true) {
  let nextTimer = 0, attached = false;
  const timers = new Map(), calls = [], writes = [], journal = [], listeners = new Map();
  const debug = {
    attach(version) { assert.equal(version, '1.3'); attached = true; calls.push(['attach']) },
    isAttached() { return attached }, detach() { attached = false; calls.push(['detach']) },
    on(name, fn) { listeners.set(name, fn) }, removeListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); calls.push(['removeListener', name]) },
    sendCommand(method, parameters = {}, sessionId) {
      calls.push([method, parameters, sessionId]);
      const result = behavior(method, parameters, sessionId);
      if (result !== undefined) return result;
      if (method === 'Target.setAutoAttach' && parameters.autoAttach && attachWorker)
        listeners.get('message')?.(null, 'Target.attachedToTarget', { sessionId: 'owned-test-session', targetInfo: { type: 'worker', url: 'design-app://app/assets/render-worker-test.js', targetId: 'owned-test-target' } });
      return Promise.resolve(method === 'Profiler.stop' ? { profile: { nodes: [{ callFrame: { url: 'design-app://app/assets/test.js' } }] } } : {});
    },
  };
  const browser = vm.createContext({ BrowserWindow: { getAllWindows: () => [{ webContents: { debugger: debug, getURL: () => 'design-app://app/index.html' } }] },
    setTimeout(fn, ms) { assert.equal(ms, 15000); const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) } });
  const app = { evaluate: (fn, arg) => { browser.argument = arg; browser.electron = { BrowserWindow: browser.BrowserWindow };
    return vm.runInContext(`(${fn.toString()})(electron, argument)`, browser) } };
  const context = vm.createContext({ app, profile: true, profilerAttached: false, profilerStopped: false, report: { errors: [] },
    out: 'owned-test-output', path: { join: (...parts) => parts.join('/') }, writeFile: async (file, data) => writes.push({ file, data }),
    progress: async (label, fields) => journal.push({ label, fields }) });
  vm.runInContext(sharp.slice(stopBegin, stopEnd) + '\nglobalThis.stopProfiles = stopProfiles;', context);
  return { debug, browser, context, timers, calls, writes, journal, listeners, get attached() { return attached },
    start: () => vm.runInContext(`(async()=>{${startup}})()`, context),
    stop: interrupted => context.stopProfiles(interrupted),
    timeout() { assert.ok(timers.size > 0, 'a real 15s command timer must be pending'); const pending = [...timers.values()]; for (const fn of pending) fn() } };
}

test('profiler success starts actual main/worker sessions, clears all timers and retrieves both profiles before detach', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.context.profilerAttached, true); assert.equal(f.browser.__sharpZoomProfiler.main.started, true);
  assert.equal(f.browser.__sharpZoomProfiler.sessions.size, 1); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.journal.map(row => row.label), ['profiler-start-requested', 'profiler-start-acknowledged']);
  await f.stop(false);
  assert.equal(f.attached, false); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.context.report.cpuProfiles.files.length, 2); assert.equal(f.context.report.cpuProfiles.capturedRenderWorkerProfiles, 1);
  assert.equal(f.context.report.cpuProfiles.interrupted, false); assert.equal(f.context.report.errors.length, 0);
  const count = f.calls.length; await f.stop(true); assert.equal(f.calls.length, count, 'final cleanup must not stop or detach twice');
});

test('15s start command timeout rejects without native input and immediately detaches the owned debugger/listener', async () => {
  const blocked = deferred(), f = fixture(method => method === 'Profiler.enable' ? blocked.promise : undefined, false);
  const starting = f.start(); await flush(); assert.equal(f.attached, true); assert.equal(f.timers.size, 1);
  f.timeout(); await assert.rejects(starting, /Profiler command timed out: Profiler.enable/);
  assert.equal(f.timers.size, 0); assert.equal(f.attached, false); assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.journal.map(row => row.label), ['profiler-start-requested']);
  blocked.resolve({}); await flush(); assert.equal(f.calls.some(row => row[0] === 'Profiler.start'), false);
});

test('immediate profiler command failure clears timer and debugger ownership rather than claiming startup acknowledgement', async () => {
  const f = fixture(method => method === 'Profiler.enable' ? Promise.reject(Error('injected command failure')) : undefined, false);
  await assert.rejects(f.start(), /injected command failure/);
  assert.equal(f.timers.size, 0); assert.equal(f.attached, false); assert.equal(f.listeners.size, 0);
  assert.equal(f.context.report.cpuProfileStart, undefined);
});

test('a timed-out main Profiler.start remains an explicit sampling error even if its native promise resolves later', async () => {
  const blocked = deferred(), f = fixture((method, parameters, sessionId) => method === 'Profiler.start' && !sessionId ? blocked.promise : undefined);
  const starting = f.start(); await until(() => f.calls.some(row => row[0] === 'Profiler.start' && !row[2]) &&
    f.browser.__sharpZoomProfiler.sessions.get('owned-test-session')?.started === true);
  assert.equal(f.timers.size, 1); f.timeout(); await starting;
  assert.equal(f.browser.__sharpZoomProfiler.main.started, false);
  assert.ok(f.context.report.cpuProfileStart.errors.some(row => row.operation === 'Profiler.start'));
  blocked.resolve({}); await flush(); assert.equal(f.browser.__sharpZoomProfiler.main.started, false);
  await f.stop(false); assert.equal(f.context.report.cpuProfiles.files.length, 1);
  assert.ok(f.context.report.errors.some(row => /Profiler command timed out/.test(row.error)));
  assert.equal(f.attached, false); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
});

test('stop timeout preserves the valid worker profile, records missing main and still detaches and clears timers', async () => {
  const blocked = deferred(), f = fixture((method, parameters, sessionId) => method === 'Profiler.stop' && !sessionId ? blocked.promise : undefined);
  await f.start(); const stopping = f.stop(true); await flush(); assert.equal(f.timers.size, 1); f.timeout(); await stopping;
  assert.equal(f.attached, false); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.context.report.cpuProfiles.interrupted, true); assert.equal(f.context.report.cpuProfiles.files.length, 1);
  assert.ok(f.context.report.errors.some(row => /Profiler command timed out/.test(row.error)));
  blocked.reject(Error('late rejection after timeout')); await flush();
});

test('auto-attach cleanup timeout still removes listener and detaches the debugger', async () => {
  const blocked = deferred(), f = fixture((method, parameters) => method === 'Target.setAutoAttach' && parameters.autoAttach === false ? blocked.promise : undefined);
  await f.start(); const stopping = f.stop(false); await flush(); assert.equal(f.timers.size, 1); f.timeout(); await stopping;
  assert.equal(f.attached, false); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  assert.ok(f.context.report.errors.some(row => row.operation === 'Target.setAutoAttach(false)'));
});

test('phase journal captures actual current phase and newline-framed timestamps instead of inferring stale results state', async () => {
  const begin = sharp.indexOf('const progress = (label, fields = {}) => appendFile('), end = sharp.indexOf('\n\nconst stopProfiles', begin), writes = [];
  const context = vm.createContext({ phase: 'native-pressure', out: 'owned-test-output', path: { join: (...parts) => parts.join('/') },
    appendFile: async (file, text) => writes.push({ file, text }) });
  vm.runInContext(sharp.slice(begin, end) + '\nglobalThis.progress = progress;', context);
  await context.progress('native-pressure-inputs-complete', { wheelInputs: 366, panGestures: 60, stages: 90 });
  context.phase = 'post-motion-visual-reference'; await context.progress('independent-reference-start');
  assert.equal(writes.length, 2); const rows = writes.map(row => { assert.match(row.file, /phase-progress\.jsonl$/); assert.ok(row.text.endsWith('\n')); return JSON.parse(row.text) });
  assert.equal(rows[0].phase, 'native-pressure'); assert.equal(rows[0].stages, 90); assert.equal(rows[1].phase, 'post-motion-visual-reference');
  assert.ok(rows.every(row => Number.isFinite(Date.parse(row.atUtc))));
  for (const label of ['native-pressure-inputs-complete', 'settling-complete', 'actual-captures-and-trace-complete', 'profiler-stop-complete', 'independent-reference-start']) assert.ok(sharp.includes(`await progress('${label}'`));
  assert.ok(sharp.indexOf("await progress('actual-captures-and-trace-complete'") < sharp.indexOf("await progress('independent-reference-start'"));
});

test('editZoom accepts only 100 or 3200 with the latter requiring real held extended verification', () => {
  const begin = display.indexOf('const editZoom=Number('), end = display.indexOf('// Self-contained helpers:', begin), guard = display.slice(begin, end);
  for (const value of [undefined, '100', '3200']) {
    const context = { process: { env: value === undefined ? {} : { DESIGN_EDIT_ZOOM: value } }, report: {}, extended: true, verifyHeld: true };
    vm.runInNewContext(guard, context); assert.equal(context.report.requestedEditZoom, Number(value || 100));
  }
  for (const [value, extended, verifyHeld] of [['3200', false, true], ['3200', true, false], ['99', true, true], ['NaN', true, true]])
    assert.throws(() => vm.runInNewContext(guard, { process: { env: { DESIGN_EDIT_ZOOM: value } }, report: {}, extended, verifyHeld }), /DESIGN_EDIT_ZOOM supports/);
});

test('100/3200 selection setup forwards only the camera zoom while whole-document undo and PNG export preconditions remain intact', async () => {
  const begin = display.indexOf("  await extra('select-edit-target',async()=>{"), end = display.indexOf('  const beforeEdit=await stored()', begin), body = display.slice(begin, end);
  for (const editZoom of [100, 3200]) {
    const calls = [], locator = { fill: async () => {}, click: async () => {} }, canvas = { focus: async () => {} };
    const context = vm.createContext({ editZoom, group: { id: 'owned-test-target', name: 'test anchor' }, canvas,
      extra: async (name, work) => { assert.equal(name, 'select-edit-target'); await work() }, settle: async () => ({ ok: true }),
      setZoom: async value => calls.push(value), expect: () => ({ toHaveAttribute: async () => {} }),
      page: { getByLabel: () => locator, getByTestId: () => locator, locator: () => locator, keyboard: { press: async () => {} } } });
    await vm.runInContext(`(async()=>{${body}})()`, context); assert.deepEqual(calls, [editZoom]);
  }
  assert.match(display, /beforeEditHash!==report\.document\.sha256/);
  assert.match(display, /undoRestoredCompleteDocument=report\.extended\.edit\.undoSha256===beforeEditHash/);
  assert.match(display, /if\(!report\.extended\.edit\.undoRestoredCompleteDocument\)throw Error\('UI export requires verified whole-document undo'\)/);
  const exportBlock = display.slice(display.indexOf('  if(verifyExport){'), display.lastIndexOf('}catch(e)'));
  assert.equal(exportBlock.includes('editZoom'), false); assert.match(exportBlock, /scales:\[1,2,3\]/);
});
