import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-persistence-')))
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
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`${base}/persistence-check.html`)
  const result = await page.evaluate(async () => {
    const { blank } = await import('/src/model.ts')
    const store = await import('/src/local-store.ts')
    const { Backend } = await import('/src/persistence.ts')
    const assert = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message)
    }
    const a = blank('作品 A'),
      b = blank('作品 B')
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('futureox-design-studio', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('documents')
      r.onerror = () => reject(r.error)
      r.onsuccess = () => {
        const tx = r.result.transaction('documents', 'readwrite')
        tx.objectStore('documents').put(a, 'current')
        tx.oncomplete = () => {
          r.result.close()
          resolve()
        }
      }
    })
    const migrated = await store.localOpen()
    assert(
      migrated?.document.id === a.id && migrated.revision === 1,
      'legacy migration lost current document',
    )
    await store.localSave(b, 0)
    await store.localSelect(b.id)
    assert((await store.localOpen(a.id))?.document.name === '作品 A', 'new document overwrote A')
    assert((await store.localOpen())?.document.id === b.id, 'session does not select B')
    const competing = await Promise.allSettled([
      store.localSave({ ...a, name: 'A1' }, 1),
      store.localSave({ ...a, name: 'A2' }, 1),
    ])
    assert(
      competing.filter((r) => r.status === 'fulfilled').length === 1,
      'compare-and-swap allowed two writers',
    )
    assert((await store.localOpen(a.id))?.revision === 2, 'unexpected revision after conflict')
    await store.localTrash(a.id, true)
    assert((await store.localList()).find((e) => e.id === a.id)?.deleted, 'trash marker missing')
    await store.localTrash(a.id, false)
    assert(!(await store.localList()).find((e) => e.id === a.id)?.deleted, 'restore failed')
    const backend = new Backend()
    backend.token = 'owned-browser-fixture'
    const originalFetch = window.fetch,
      sent: { document: unknown; revision: number; requestId: string }[] = []
    let drop = true,
      revision = 0
    const receipts = new Map<string, unknown>()
    window.fetch = async (_url, options) => {
      const payload = JSON.parse(String(options?.body))
      sent.push(payload)
      let response = receipts.get(payload.requestId)
      if (!response) {
        response = {
          id: b.id,
          name: payload.document.name,
          document: payload.document,
          revision: ++revision,
          updatedAt: new Date().toISOString(),
        }
        receipts.set(payload.requestId, response)
      }
      if (drop) {
        drop = false
        throw new TypeError('Response dropped after commit')
      }
      return new Response(JSON.stringify(response), {
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      await backend.save(b, 0).then(
        () => {
          throw new Error('drop was not observed')
        },
        () => {},
      )
      const restarted = new Backend()
      restarted.token = backend.token
      const recovered = await restarted.save({ ...b, name: 'new edit' }, 0)
      assert(
        sent[0].requestId === sent[1].requestId &&
          JSON.stringify(sent[0]) === JSON.stringify(sent[1]),
        'unknown write was replaced',
      )
      assert(recovered.revision === 1 && revision === 1, 'replay duplicated a committed version')
      const fresh = await restarted.save({ ...b, name: 'new edit' }, 0)
      assert(
        fresh.revision === 2 && sent[2].revision === 1 && sent[2].requestId !== sent[1].requestId,
        'confirmed revision did not survive restart',
      )
    } finally {
      window.fetch = originalFetch
    }
    return {
      migration: true,
      multipleDocuments: true,
      compareAndSwap: true,
      trashRestore: true,
      unknownCommitReplay: true,
      persistedRemoteRevision: true,
    }
  })
  await writeFile(
    join(output, 'persistence.json'),
    JSON.stringify({ browser: await browser.version(), ...result }, null, 2),
  )
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
