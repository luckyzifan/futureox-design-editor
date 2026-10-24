import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const directory = path.dirname(new URL(import.meta.url).pathname)
const { runtime } = JSON.parse(await readFile(path.join(directory, 'baseline.json'), 'utf8'))
const runs = [
  ['fig-verified-6', 'check-fig-gui.mjs', [], 'native'],
  ['117-verified-6', 'check-117-gui.mjs', [], 'native'],
  ['sketch-verified-6', 'check-sketch-gui.mjs', [], 'native'],
  ['fig-images-6', 'capture-motion.mjs', ['fig'], 'quality'],
  ['sketch-images-6', 'capture-motion.mjs', ['sketch'], 'quality'],
  ['heavy-117-natural-6', '../verification-fig-import-20261024/replay-empty-reference.mjs', [], 'native', { REFERENCE_FULL: '1' }],
  ['heavy-empty-pressure-6', '../verification-fig-import-20261024/replay-empty-reference.mjs', [], 'native'],
]
const results = []
for (const [name, script, args, configuration, extra] of runs) {
  const startedAt = Date.now(), log = createWriteStream(path.join(directory, name + '-run.log'))
  const child = spawn(process.execPath, [path.join(directory, script), ...args, name], {
    env: { ...process.env, CAPTURE_MOTION: '0', REFERENCE_FULL: '0', ...extra,
      FIG_HOST: path.join(runtime, 'host-images-' + configuration + '-6') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const result = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  await new Promise(resolve => log.end(resolve))
  results.push({ name, script, configuration, startedAt, endedAt: Date.now(), ...result })
  await writeFile(path.join(directory, 'final-runs-6.json'), JSON.stringify(results, null, 2))
  console.log(name, result)
  if (result.code !== 0) process.exitCode = 1
}
