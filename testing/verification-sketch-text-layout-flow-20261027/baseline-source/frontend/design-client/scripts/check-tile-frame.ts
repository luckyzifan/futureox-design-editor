/** Owned browser input and actual WebGPU; no user browser/profile attached. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
const cwd = new URL('..', import.meta.url).pathname
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
)
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Vite timeout: ${log}`)), 30000)
    server.stdout.on('data', () => {
      const m = log.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(base)
  const results = await page.evaluate(async () => {
    const { runTileFrameCheck } = await import('/src/kernel/gpu/tile-frame-check.ts')
    return runTileFrameCheck()
  })
  let failures = 0
  for (const result of results) {
    if (result.ok) console.log(`ok   ${result.name} (${result.detail})`)
    else if ((result as { informational?: boolean }).informational) {
      console.log(`info ${result.name} (${result.detail})`)
    } else {
      failures += 1
      console.error(`FAIL ${result.name} (${result.detail})`)
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} tile frame checks failed`)
    process.exitCode = 1
  } else console.log('\ntile frame consistency checks passed')
} finally {
  await browser?.close()
  server.kill()
}
