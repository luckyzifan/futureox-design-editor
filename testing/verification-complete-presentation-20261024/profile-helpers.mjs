import { writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function startProfiles(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const debug = BrowserWindow.getAllWindows()[0].webContents.debugger, sessions = new Map(), pending = []
    debug.attach('1.3')
    const listener = (_event, method, params) => {
      if (method !== 'Target.attachedToTarget' || params.targetInfo.type !== 'worker') return
      sessions.set(params.sessionId, params.targetInfo)
      pending.push(debug.sendCommand('Profiler.enable', {}, params.sessionId)
        .then(() => debug.sendCommand('Profiler.start', {}, params.sessionId)))
    }
    debug.on('message', listener)
    await debug.sendCommand('Profiler.enable'); await debug.sendCommand('Profiler.start')
    await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise(resolve => setTimeout(resolve, 100)); await Promise.allSettled(pending)
    globalThis.__ownedProfiles = { debug, sessions, pending, listener, startedAt: Date.now() }
    return { startedAt: globalThis.__ownedProfiles.startedAt, workers: [...sessions.values()] }
  })
}

export async function stopProfiles(app, directory, host) {
  const data = await app.evaluate(async () => {
    const p = globalThis.__ownedProfiles; if (!p) throw Error('Owned profiler was not started')
    await Promise.allSettled(p.pending); const results = []
    try {
      for (const [id, target] of [[undefined, { type: 'renderer', title: 'UI 主线程' }], ...p.sessions]) {
        try { const { profile } = await p.debug.sendCommand('Profiler.stop', {}, id); results.push({ target, profile }) }
        catch (error) { results.push({ target, error: String(error) }) }
      }
    } finally { p.debug.off('message', p.listener); p.debug.detach(); delete globalThis.__ownedProfiles }
    return { startedAt: p.startedAt, endedAt: Date.now(), results }
  })
  const results = []
  for (const [index, row] of data.results.entries()) {
    const file = 'cpu-' + index + '.cpuprofile'
    if (row.profile) await writeFile(path.join(directory, file), JSON.stringify(row.profile))
    results.push({ target: row.target, ...(row.profile ? { file } : { error: row.error }) })
  }
  const manifest = { host, scope: 'sampled real Electron native-input integration; UI and existing browser workers, native Rust process and GPU execution are not V8 CPU stacks', startedAt: data.startedAt, endedAt: data.endedAt, results }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
