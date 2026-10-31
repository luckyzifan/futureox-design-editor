// Same immutable baseline snapshot, two actual native preparation products.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NativePreparation } from '../../frontend/design-desktop/src/preparation.mjs'

const repo = process.cwd(), out = path.resolve('testing/verification-source-work-reuse-20261031')
process.env.CORE_SOURCE_SNAPSHOT_METADATA_ONLY = '0'
const descriptor = JSON.parse(await fs.readFile(path.join(out, 'baseline-1/snapshot.json'), 'utf8'))
const layout = JSON.parse(await fs.readFile(path.join(out, 'baseline-1/layout.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const overview = process.argv.includes('--overview'), suffix = overview ? '-overview' : ''
const expected = [], results = []
for (const label of ['baseline', 'candidate']) {
  const worker = new NativePreparation(path.join(out, label + '-bin/design-prepare'), path.join(repo, 'frontend/design-client/public/fonts/NotoSansSC.ttf'))
  try {
    const loaded = await worker.loadSourceSnapshot(descriptor); if (loaded.error) throw Error(loaded.error)
    for (const [i, id] of ['10c6999a-19ed-4836-be94-46a2609309d7', 'B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105'].entries()) {
      const item = layout.find(item => item.id === id); assert(item)
      const width = overview ? 384 : 96, zoom = overview ? width / item.placed.width : 1
      const height = overview ? Math.ceil(item.placed.height * zoom) : 64
      const options = { pageId: descriptor.pageId, width, height, view: {
        x: width / 2 - (item.placed.x + item.placed.width / 2) * zoom,
        y: height / 2 - (item.placed.y + item.placed.height / 2) * zoom, zoom }, rasterProfile: 'figmaSubpixel', transparent: false }
      const started = performance.now()
      const reply = await worker.request({ lane: 'canvas', method: 'render_png', args: [JSON.stringify(options)] })
      if (reply.error) {
        // Preserve baseline admission failures as failures of this pixel case,
        // not as a reason to increase budgets or silently change the fixture.
        if (label === 'baseline') expected.push({ error: reply.error })
        else assert.equal(reply.error, expected[i].error, 'source admission changed')
        results.push({ label, root: id, name: item.name, options, status: 'rejected', error: reply.error })
        await fs.writeFile(path.join(out, `same-snapshot-pixels${suffix}.json`), JSON.stringify(results, null, 2))
        console.log(JSON.stringify(results.at(-1))); continue
      }
      const bytes = Buffer.from(reply.value); assert(bytes.length > 0)
      await fs.writeFile(path.join(out, `${label}-cpu${suffix}-${i}.png`), bytes)
      if (label === 'baseline') expected.push(bytes)
      else assert.deepEqual(bytes, expected[i], 'same-snapshot CPU PNG changed')
      results.push({ label, root: id, name: item.name, options, status: 'pixels', bytes: bytes.length, sha256: hash(bytes), ms: performance.now()-started })
      await fs.writeFile(path.join(out, `same-snapshot-pixels${suffix}.json`), JSON.stringify(results, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally { await worker.close() }
}
