import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Prepared for an explicitly authorized CPU-only host; do not run in the cloud GPU-ban cohort.
// Requires a working OS display and Chromium's normal sandbox.
// Never add --no-sandbox or --disable-setuid-sandbox to make a container pass.
const child = spawn(electron, [root, '--desktop-smoke', '--core-cpu-only'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env, ELECTRON_ENABLE_SECURITY_WARNINGS: 'true' },
})
let found = false
let output = ''
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
}, 60_000)
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  output = (output + chunk.toString()).slice(-128 * 1024)
  found ||= output.includes('DESKTOP_SMOKE ')
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('error', (error) => {
  clearTimeout(timer)
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (timedOut || code !== 0 || !found) {
    console.error(
      `Desktop runtime smoke failed: code=${code}, signal=${signal}, report=${found}, timedOut=${timedOut}`,
    )
    process.exitCode = 1
  }
})
