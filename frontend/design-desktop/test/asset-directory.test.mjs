import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  admitAssetBatch,
  assetZipDialogName,
  normalizeAssetZipChoice,
  publishAssetDirectory,
  publishAssetZip,
  readStoredZip,
  validAssetFileName,
} from '../src/asset-directory.mjs'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

function task(pathName, format, suffix, status = 'succeeded', bytes = png) {
  return {
    taskId: pathName, nodeId: pathName.split('@')[0], settingId: suffix, revision: 4,
    format, scale: 1, suffix, path: pathName, status, ...(status === 'succeeded' ? { byteLength: bytes.length } : { error: 'failed' }),
  }
}

function batch(files, tasks = files.map(file => task(file.name, file.name.endsWith('.svg') ? 'svg' : 'png', file.name.includes('@vector') ? '@vector' : '@one', 'succeeded', file.bytes))) {
  const succeeded = tasks.filter(item => item.status === 'succeeded')
  return {
    files,
    manifest: {
      format: 'futureox.asset-batch.v1', documentId: 'doc', pageId: 'page', revision: 4,
      complete: tasks.length > 0 && succeeded.length === tasks.length, fileCount: succeeded.length, tasks,
    },
  }
}

test('asset names reject traversal and the manifest must match the files', () => {
  assert.equal(validAssetFileName('Rect@one.png'), true)
  assert.equal(validAssetFileName('../Rect@one.png'), false)
  assert.equal(validAssetFileName('nested/Rect@one.png'), false)
  assert.equal(validAssetFileName('asset-manifest.json'), false)
  assert.equal(validAssetFileName('notes.txt'), false)
  assert.equal(assetZipDialogName('../outside.zip'), 'assets.zip')
  assert.equal(assetZipDialogName('预设.zip'), '预设.zip')
  assert.throws(() => normalizeAssetZipChoice('relative.zip'), error => error.reason === 'path')
  const good = batch([{ name: 'Rect@one.png', bytes: png }, { name: 'Rect@vector.svg', bytes: svg }])
  assert.equal(admitAssetBatch(good.files, good.manifest).files.length, 2)
  assert.throws(() => admitAssetBatch([{ name: '../Rect@one.png', bytes: png }], good.manifest), error => error.reason === 'name')
  const lied = structuredClone(good.manifest)
  lied.complete = true
  lied.fileCount = 1
  lied.tasks[1].status = 'failed'
  assert.throws(() => admitAssetBatch([good.files[0]], lied), error => error.reason === 'complete')
})

test('directory delivery writes real bytes and a manifest, and reports existing names per file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'asset-dir-'))
  try {
    const admitted = admitAssetBatch(
      [{ name: 'Rect@one.png', bytes: png }, { name: 'Ellipse@vector.svg', bytes: svg }],
      batch([{ name: 'Rect@one.png', bytes: png }, { name: 'Ellipse@vector.svg', bytes: svg }]).manifest,
    )
    const first = await publishAssetDirectory(root, admitted)
    assert.equal(first.fileCount, 2)
    assert.equal(first.complete, true)
    assert.equal(first.manifestName, 'asset-manifest.json')
    assert.deepEqual(await readFile(path.join(root, 'Rect@one.png')), png)
    assert.deepEqual(await readFile(path.join(root, 'Ellipse@vector.svg')), svg)
    const manifest = JSON.parse(await readFile(path.join(root, 'asset-manifest.json'), 'utf8'))
    assert.equal(manifest.fileCount, 2)
    assert.equal(manifest.complete, true)
    assert.equal(manifest.tasks.length, 2)
    await writeFile(path.join(root, 'Rect@one.png'), png)
    const second = await publishAssetDirectory(root, admitted)
    assert.equal(second.complete, false)
    assert.equal(second.fileCount, 0)
    assert.equal(second.results.find(item => item.name === 'Rect@one.png').reason, 'exists')
    assert.equal(second.results.find(item => item.name === 'Ellipse@vector.svg').reason, 'exists')
    assert.deepEqual(await readFile(path.join(root, 'Rect@one.png')), png)
    const updated = JSON.parse(await readFile(path.join(root, 'asset-manifest.json'), 'utf8'))
    assert.equal(updated.complete, false)
    assert.equal(updated.fileCount, 0)
    const kept = path.join(root, 'kept.txt')
    await writeFile(kept, 'keep')
    await symlink(kept, path.join(root, 'link.png'))
    const linked = await publishAssetDirectory(root, admitAssetBatch(
      [{ name: 'link.png', bytes: png }],
      batch([{ name: 'link.png', bytes: png }]).manifest,
    ))
    assert.equal(linked.results[0].written, false)
    assert.equal(linked.results[0].reason, 'path')
    assert.equal(await readFile(kept, 'utf8'), 'keep')
    assert.equal((await lstat(path.join(root, 'link.png'))).isSymbolicLink(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zip delivery stores the files and manifest and refuses to replace a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'asset-zip-'))
  try {
    const admitted = batch([{ name: 'Rect@one.png', bytes: png }, { name: 'Ellipse@vector.svg', bytes: svg }])
    const choice = normalizeAssetZipChoice(path.join(root, '预设'))
    assert.equal(choice.appended, true)
    const published = await publishAssetZip(choice, admitAssetBatch(admitted.files, admitted.manifest))
    assert.equal(published.fileCount, 2)
    assert.equal(published.complete, true)
    const zip = await readFile(path.join(root, '预设.zip'))
    const files = readStoredZip(zip)
    assert.deepEqual(files.get('Rect@one.png'), png)
    assert.deepEqual(files.get('Ellipse@vector.svg'), svg)
    const manifest = JSON.parse(files.get('asset-manifest.json').toString('utf8'))
    assert.equal(manifest.complete, true)
    assert.equal(manifest.fileCount, 2)
    await assert.rejects(publishAssetZip(choice, admitAssetBatch(admitted.files, admitted.manifest)), error => error.reason === 'exists')
    assert.deepEqual(await readFile(path.join(root, '预设.zip')), zip)
    const kept = path.join(root, 'kept.txt')
    await writeFile(kept, 'keep')
    await symlink(kept, path.join(root, 'linked.zip'))
    await assert.rejects(publishAssetZip(normalizeAssetZipChoice(path.join(root, 'linked.zip')), admitAssetBatch(admitted.files, admitted.manifest)), error => error.reason === 'path')
    assert.equal(await readFile(kept, 'utf8'), 'keep')
    await mkdir(path.join(root, 'outside'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
