import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('strict launch policy is configured before readiness and forwarded only from main argv', async () => {
  // Source contract only: never import Electron, emulate GPU APIs, or launch a browser.
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const smoke = await readFile(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8')
  assert.match(main, /const cpuOnly = process\.argv\.includes\('--core-cpu-only'\)/)
  assert.ok(main.indexOf('app.disableHardwareAcceleration()') < main.indexOf('.whenReady()'))
  assert.match(main, /appendSwitch\('disable-gpu'\)/)
  assert.match(main, /appendSwitch\('disable-software-rasterizer'\)/)
  assert.match(main, /additionalArguments: cpuOnly \? \['--core-cpu-only'\] : \[\]/)
  assert.match(smoke, /\[root, '--desktop-smoke', '--core-cpu-only'\]/)
  // The explicit packaged smoke must also choose a private profile and strict
  // CPU policy; silently ignoring this flag would touch the ordinary profile.
  assert.match(main, /const smoke = process\.argv\.includes\('--desktop-smoke'\)/)
  assert.match(main, /const cpuOnly = process\.argv\.includes\('--core-cpu-only'\) \|\| smoke/)
  assert.match(main, /if \(smoke \|\| guiTest \|\| isolatedProfile\) \{/)
  assert.match(main, /const isolatedProfile = process\.argv\.includes\('--desktop-isolated-profile'\)/)
  assert.match(main, /!smoke && !guiTest && !isolatedProfile && peerWindowId === undefined/)
  assert.match(main, /if \(smoke\) await runSmoke\(\)/)
})
