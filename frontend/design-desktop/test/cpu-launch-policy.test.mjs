import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { selectDesktopProfile } from '../src/release-launch.mjs'

test('strict launch policy is configured before readiness and forwarded only from main argv', async () => {
  // Check the host entry point without importing Electron or launching a window.
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const smoke = await readFile(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8')
  assert.match(main, /const cpuOnly = process\.argv\.includes\('--core-cpu-only'\)/)
  assert.ok(main.indexOf('app.disableHardwareAcceleration()') < main.indexOf('.whenReady()'))
  assert.match(main, /appendSwitch\('disable-gpu'\)/)
  assert.match(main, /appendSwitch\('disable-software-rasterizer'\)/)
  assert.ok(main.includes("...(cpuOnly ? ['--core-cpu-only'] : [])"))
  assert.match(smoke, /\[root, '--desktop-smoke', '--core-cpu-only'\]/)
  // The explicit packaged smoke must also choose a private profile and strict
  // CPU policy; silently ignoring this flag would touch the ordinary profile.
  assert.match(main, /const smoke = process\.argv\.includes\('--desktop-smoke'\)/)
  assert.match(main, /const cpuOnly = process\.argv\.includes\('--core-cpu-only'\) \|\| smoke/)
  assert.match(main, /selectDesktopProfile\(\{\s*smoke,\s*guiTest,\s*isolatedProfile,/)
  assert.match(main, /app\.setPath\('userData', desktopProfile\.profile\)/)
  assert.deepEqual(selectDesktopProfile({ smoke: true, createTemporary: () => '/private/qa-smoke' }),
    { isolated: true, profile: '/private/qa-smoke', source: 'temporary' })
  assert.match(main, /const isolatedProfile = process\.argv\.includes\('--desktop-isolated-profile'\)/)
  assert.match(main, /!desktopProfile && peerWindowId === undefined/)
  assert.match(main, /if \(smoke\) await runSmoke\(\)/)
})
