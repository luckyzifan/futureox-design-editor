import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const out = path.join(process.cwd(), 'testing/verification-complete-presentation-20261024')
const { runtime } = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
const results = []
for (const [kind, name, profile] of [['117','117-quality-1',false], ['fig','fig-quality-1',false], ['sketch','sketch-quality-1',false], ['117','117-profile-1',true]]) {
  const log = createWriteStream(path.join(out, name + '-run.log'))
  const child = spawn(process.execPath, [path.join(out, 'capture-foreground.mjs'), kind, name], {
    env: { ...process.env, FIG_HOST: path.join(runtime, 'host-complete-quality-1'), CAPTURE_MOTION: '0', PROFILE_MOTION: profile ? '1' : '0' },
    stdio: ['ignore','pipe','pipe'],
  })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const code = await new Promise(resolve => child.on('exit', resolve))
  await new Promise(resolve => log.end(resolve))
  results.push({ name, kind, profile, code })
  await writeFile(path.join(out, 'quality-runs.json'), JSON.stringify(results, null, 2))
  console.log(name, code)
  if (code !== 0) { process.exitCode = 1; break }
}
