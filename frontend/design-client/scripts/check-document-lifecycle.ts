import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, type DesignDocument } from '../src/model'
import { emptySystem } from '../src/design-system'
import { defaultColorSettings } from '../src/color'

const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-lifecycle-')))
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite exited ${code}`))
    })
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = [],
    records: unknown[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(base)
  await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 20000 })
  const assertStored = async (source: DesignDocument, name = source.name) => {
    await expect(page.getByLabel('文档名称')).toHaveValue(name)
    await expect(page.locator('.save-status')).toHaveText('已保存到本机')
    const readStored = () =>
      page.evaluate(async () => {
        // @ts-ignore Vite resolves the browser-only absolute module URL.
        const { localOpen } = await import('/src/local-store.ts')
        return (await localOpen()).document
      }) as Promise<DesignDocument>
    await expect.poll(async () => (await readStored()).name).toBe(name)
    const stored = await readStored()
    expect(stored.schemaVersion).toBe(Math.max(2, source.schemaVersion))
    expect(stored.designSystem).toEqual(source.designSystem)
    expect(stored.prototype).toEqual(source.prototype)
    expect(stored.colorManagement).toEqual(source.colorManagement)
    for (const n of Object.values(source.nodes))
      if (n.textRuns) expect(stored.nodes[n.id]?.textRuns).toMatchObject(n.textRuns)
    return stored
  }
  for (const version of [1, 2, 3, 4] as const) {
    const doc = blank(`Lifecycle schema ${version}`)
    doc.schemaVersion = version
    if (version === 3) {
      doc.colorManagement = defaultColorSettings()
      doc.rasterProfile = 'figma'
    }
    if (version === 4) {
      const frame = node('frame'),
        text = node('text')
      text.text = 'Rich text'
      text.textRuns = [{ start: 0, end: 4, underline: true, color: '#ff0000' }]
      frame.children = [text.id]
      doc.nodes = { [frame.id]: frame, [text.id]: text }
      doc.pages[0].children = [frame.id]
      doc.designSystem = emptySystem()
      doc.prototype = { startNode: frame.id, interactions: {} }
    }
    console.log(JSON.stringify({version,phase:'import'}))
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles({
      name: 'lifecycle.fd',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(doc)),
    })
    await assertStored(doc)
    console.log(JSON.stringify({version,phase:'brand'}))
    await page.locator('.brand').click()
    await page.getByRole('button', { name: '保存为本机副本', exact: true }).click()
    await assertStored(doc, `${doc.name} 副本`)
    console.log(JSON.stringify({version,phase:'brand'}))
    await page.locator('.brand').click()
    await page.getByRole('button', { name: '本机文件与回收站', exact: true }).click()
    await page.getByRole('button', { name: doc.name, exact: true }).click()
    await assertStored(doc)
    await page.reload()
    await assertStored(doc)
    records.push({
      schemaVersion: version,
      imported: true,
      copied: true,
      reopened: true,
      reloaded: true,
    })
  }
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ records, errors }, null, 2))
  console.log(JSON.stringify({ output, records, errors }))
} catch(error) {
  const page=browser?.contexts()[0]?.pages()[0]
  if(page){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),body:await page.locator('body').innerText().catch(()=>''),output}))}
  console.log(JSON.stringify({output,error:String(error)}));throw error
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
