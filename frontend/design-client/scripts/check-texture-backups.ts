/** Pair a default build with a build that defines VITE_DESIGN_TEXTURE_BACKUPS on the same fixed
 * synthetic documents. Hardware GPU readback of production worker frames: identical bytes are
 * required, fewer draws on the managed lanes and unchanged draws elsewhere. This is not a GUI,
 * latency or G2/G5 measurement. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { resolve } from 'node:path'

type Row = { scene: string; mode: string; zoom: number; sha: string; draws: number; graphMs: number; finishMs: number }
const root = resolve(import.meta.dir, '..')

async function collect(candidate: boolean): Promise<Row[]> {
  const server = await createServer({ root, logLevel: 'error',
    ...(candidate ? { define: { 'import.meta.env.VITE_DESIGN_TEXTURE_BACKUPS': JSON.stringify('1') } } : {}),
    server: { host: '127.0.0.1', port: 0, strictPort: true } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  try {
    const page = await browser.newPage()
    await page.goto(server.resolvedUrls.local[0] + 'texture-backups-check.html')
    await page.waitForFunction(() => {
      const text = document.querySelector<HTMLElement>('#results')?.textContent
      return !!text && text !== 'running'
    }, null, { timeout: 900000 })
    const payload = JSON.parse((await page.textContent('#results')) || 'null')
    if (!payload?.rows) throw Error(`Texture backup check produced no rows${candidate ? ' (candidate)' : ''}: ${payload?.error ?? 'empty page'}`)
    return payload.rows as Row[]
  } finally { await browser.close(); await server.close() }
}

const baseline = await collect(false), candidate = await collect(true)
const failures: string[] = []
const at = (row: Row) => `${row.scene} ${row.mode} @${row.zoom}`
if (baseline.length !== candidate.length || baseline.length === 0) failures.push(`row counts differ: ${baseline.length} and ${candidate.length}`)
let reduced = 0, unchanged = 0
const drawBaseline: Record<string, number> = {}, drawCandidate: Record<string, number> = {}
for (const [index, row] of baseline.entries()) {
  const other = candidate[index]
  if (!other || at(other) !== at(row)) { failures.push(`row ${index} is a different case`); continue }
  if (other.sha !== row.sha) failures.push(`${at(row)}: read back pixels differ`)
  const lane = row.mode === 'figma' ? 'byte' : 'managed'
  drawBaseline[lane] = (drawBaseline[lane] ?? 0) + row.draws
  drawCandidate[lane] = (drawCandidate[lane] ?? 0) + other.draws
  if (other.draws < row.draws) { reduced++; if (lane === 'byte') failures.push(`${at(row)}: the byte lane changed its draws`) }
  else if (other.draws === row.draws) unchanged++
  else failures.push(`${at(row)}: more draws (${row.draws} to ${other.draws})`)
}
if (!reduced) failures.push('no case drew fewer passes with the candidate')
const share = (from: number, to: number) => `${from} to ${to} (${from ? Math.round((to / from - 1) * 1000) / 10 : 0}%)`
console.log(JSON.stringify({ kind: 'texture-backups-pair', rows: baseline.length, identicalPixels: baseline.length - failures.filter(f => f.includes('pixels')).length,
  reducedCases: reduced, unchangedCases: unchanged, draws: { managed: share(drawBaseline.managed ?? 0, drawCandidate.managed ?? 0), byte: share(drawBaseline.byte ?? 0, drawCandidate.byte ?? 0) },
  failures }, null, 1))
process.exit(failures.length ? 1 : 0)
