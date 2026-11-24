import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { crc32, deflateSync } from 'node:zlib'
import { prepareFigmaTextReferences } from './prepare-figma-text-references.mjs'

const corpus = new URL('../public/fidelity/text-2026-10-09/', import.meta.url)
const templates = JSON.parse(await readFile(new URL('cases.json', corpus), 'utf8'))

function pngChunk(type, contents) {
  const payload = Buffer.concat([Buffer.from(type), contents])
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(contents.length)
  checksum.writeUInt32BE(crc32(payload))
  return Buffer.concat([length, payload, checksum])
}

// A synthetic PNG exercises the manifest plumbing without acting as a Figma oracle.
function blankPng(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function inputDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'figma-text-references-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'input')
  const destination = join(root, 'pack')
  await mkdir(source)
  for (const item of templates) {
    const name = `KernelTextQA-${item.id}`
    const { width, height } = item.options
    await writeFile(join(source, `${name}.png`), blankPng(width, height))
    await writeFile(join(source, `${name}@2x.png`), blankPng(width * 2, height * 2))
  }
  return { source, destination }
}

test('the Figma script adds both PNG scales to existing calibration frames', async () => {
  const code = await readFile(new URL('create-in-figma.js', corpus), 'utf8')
  const frames = templates.map(({ id, options }) => ({
    id, type: 'FRAME', name: `KernelTextQA-${id}`, width: options.width, height: options.height,
    exportSettings: [{ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }],
  }))
  const page = { name: 'Kernel text comparison 2026-10-09', children: [{ name: 'Kernel text versus Figma', children: frames }] }
  const figma = {
    root: { children: [page] }, currentPage: page, setCurrentPageAsync: async () => {},
    loadFontAsync: async () => {}, viewport: { scrollAndZoomIntoView() {} },
  }
  const result = await runInNewContext(`(async () => { ${code}\n })()`, { figma })
  const returned = JSON.parse(JSON.stringify(result))
  assert.deepEqual(returned.createdNodeIds, [])
  for (const [i, frame] of frames.entries()) {
    const actual = JSON.parse(JSON.stringify(frame.exportSettings))
    assert.deepEqual(actual.map(setting => [setting.constraint.value, setting.colorProfile, setting.useAbsoluteBounds, setting.suffix]),
      [[1, 'SRGB', true, ''], [2, 'SRGB', true, '@2x']])
    assert.deepEqual(returned.frames[i].references.map(entry => [entry.name, entry.width, entry.height]), [
      [`${frame.name}.png`, frame.width, frame.height], [`${frame.name}@2x.png`, frame.width * 2, frame.height * 2],
    ])
  }
})

test('the pack preserves source bytes and scales the render viewport', async t => {
  const { source, destination } = await inputDirectory(t)
  const records = await prepareFigmaTextReferences(source, destination)
  assert.equal(records.length, templates.length * 2)
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'cases.json'), 'utf8')), records)
  for (const [index, template] of templates.entries()) {
    const [one, two] = records.slice(index * 2, index * 2 + 2)
    assert.deepEqual(one.options, template.options)
    assert.equal(two.options.width, template.options.width * 2)
    assert.equal(two.options.height, template.options.height * 2)
    assert.equal(two.options.view.zoom, template.options.view.zoom * 2)
    assert.deepEqual(two.document, template.document)
    for (const record of [one, two]) {
      const actual = await readFile(join(destination, record.reference))
      assert.deepEqual(actual, await readFile(join(source, record.reference)))
      assert.equal(record.referenceSha256, createHash('sha256').update(actual).digest('hex'))
    }
  }
  await assert.rejects(prepareFigmaTextReferences(source, destination), { code: 'EEXIST' })
})

test('missing, mislabeled and incorrectly sized reference images leave no output pack', async t => {
  const { source, destination } = await inputDirectory(t)
  const first = join(source, `KernelTextQA-${templates[0].id}@2x.png`)
  await rm(first)
  await assert.rejects(prepareFigmaTextReferences(source, destination), /@2x\.png/)
  await assert.rejects(stat(destination), { code: 'ENOENT' })
  await writeFile(first, 'I am not a PNG')
  await assert.rejects(prepareFigmaTextReferences(source, destination), /Invalid PNG header/)
  await assert.rejects(stat(destination), { code: 'ENOENT' })
  const { width, height } = templates[0].options
  await writeFile(first, blankPng(width, height))
  await assert.rejects(prepareFigmaTextReferences(source, destination), /expected 640×480/)
  await assert.rejects(stat(destination), { code: 'ENOENT' })
})
