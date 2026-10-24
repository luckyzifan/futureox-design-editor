import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd(), out = path.join(root, 'testing/verification-render-r2-20261024')
const { runtime } = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
const kind = process.argv[2] || '117', results = []
for (const [index, variant] of ['control', 'candidate', 'candidate', 'control'].entries()) {
  const name = `${kind}-packet-ab-${index + 1}-${variant}`, start = Date.now()
  const log = createWriteStream(path.join(out, name + '-run.log'))
  const child = spawn(process.execPath, [path.join(out, 'capture-foreground.mjs'), kind, name], {
    env: { ...process.env, CAPTURE_MOTION: '0', FIG_HOST: path.join(runtime, 'host-packet-' + variant + '-1') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const code = await new Promise(resolve => child.on('exit', resolve)); await new Promise(resolve => log.end(resolve))
  results.push({ name, variant, start, end: Date.now(), code })
  await writeFile(path.join(out, `${kind}-packet-ab-runs.json`), JSON.stringify(results, null, 2))
  console.log(name, code)
  if (code !== 0) { process.exitCode = 1; break }
}
