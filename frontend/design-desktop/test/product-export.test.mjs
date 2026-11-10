import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { desktopText } from '../src/native-locale.mjs'
import {
  exportDialogName,
  normalizeExportChoice,
  publishProductExport,
  validateProductExport,
} from '../src/product-export.mjs'
import { PNG, makeFd, makeZip, productEntries, productZip } from './product-export-fixtures.mjs'

const reason = (fn) => {
  try { fn() }
  catch (error) { return error.reason }
  assert.fail('expected rejection')
}

test('FD admission accepts a version-2 checksum and rejects every other container', () => {
  const bytes = makeFd('panel')
  assert.deepEqual(validateProductExport('fd', bytes), bytes)
  assert.deepEqual(validateProductExport('fd', Uint8Array.from(bytes)), bytes)
  const tampered = Buffer.from(bytes)
  tampered[tampered.length - 1] ^= 1
  assert.equal(reason(() => validateProductExport('fd', tampered)), 'checksum')
  assert.equal(reason(() => validateProductExport('fd', Buffer.alloc(16, 1))), 'magic')
  const version = Buffer.from(bytes)
  version.writeUInt16LE(1, 4)
  assert.equal(reason(() => validateProductExport('fd', version)), 'version')
  assert.equal(reason(() => validateProductExport('fd', PNG)), 'magic')
  assert.equal(reason(() => validateProductExport('fd', bytes, 8)), 'size')
  assert.equal(reason(() => validateProductExport('sketch', bytes)), 'kind')
})

test('HTML ZIP admission accepts only the fixed design bundle', () => {
  const zip = productZip()
  assert.deepEqual(validateProductExport('html-zip', zip), zip)
  assert.deepEqual(validateProductExport('html-zip', makeZip(productEntries({ asset: false }), { method: 0 })), makeZip(productEntries({ asset: false }), { method: 0 }))
  assert.deepEqual(validateProductExport('html-zip', makeZip(productEntries(), { flags: 0x800 })), makeZip(productEntries(), { flags: 0x800 }))
  assert.equal(reason(() => validateProductExport('html-zip', makeFd('panel'))), 'eocd')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ extra: [['payload.exe', Buffer.from('MZ')]] }))), 'entries')
  assert.equal(reason(() => validateProductExport('html-zip', makeZip(productEntries(), { external: 1 }))), 'attributes')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ extra: [['../secret.png', PNG]] }))), 'name')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ extra: [['assets/payload.html', Buffer.from('<html>')]] }))), 'entries')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ extra: [['assets/fake.png', Buffer.from('not-a-png')]] }))), 'bundle')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ html: '<!doctype html><script>bad()</script>' }))), 'bundle')
  assert.equal(reason(() => validateProductExport('html-zip', productZip({ css: '.design-scene{} @import "https://evil.example/a.css";' }))), 'bundle')
  const bomb = makeZip(productEntries(), { declaredSize: new Map([['index.html', 9 * 1024 * 1024]]) })
  assert.equal(reason(() => validateProductExport('html-zip', bomb)), 'size')
  assert.equal(reason(() => validateProductExport('html-zip', Buffer.concat([Buffer.from([0]), productZip()]))), 'layout')
  assert.equal(reason(() => validateProductExport('html-zip', Buffer.concat([productZip(), Buffer.from([0])]))), 'eocd')
})

test('dialog names and destinations stay inside the chosen file and extension', async () => {
  assert.equal(exportDialogName('fd', '../outside.fd'), 'design.fd')
  assert.equal(exportDialogName('html-zip', 'https://evil.example/design-html.zip'), 'design-html.zip')
  assert.equal(exportDialogName('fd', '设计.fd'), '设计.fd')
  assert.equal(exportDialogName('html-zip', 'design.fd'), 'design-html.zip')
  assert.throws(() => normalizeExportChoice('fd', 'relative.fd'), error => error.reason === 'path')
  assert.throws(() => normalizeExportChoice('fd', '/tmp/notes.txt'), error => error.actual === '.txt' && error.reason === 'extension')
  const appended = normalizeExportChoice('html-zip', '/tmp/bundle')
  assert.equal(appended.appended, true)
  assert.equal(appended.basename, 'bundle.zip')
  for (const locale of ['zh-CN', 'en']) {
    assert.equal(desktopText[locale].rejectedDownload('.zip').includes('.fd'), false)
    assert.match(desktopText[locale].rejectedDownload('.zip'), /\.zip/)
    assert.match(desktopText[locale].rejectedDownload('.fd'), /\.fd/)
    assert.equal(desktopText[locale].rejectedDownload('.sh').includes('.fd'), false)
    assert.equal(desktopText[locale].productExportRejected('html-zip').includes('.fd'), false)
    assert.match(desktopText[locale].productExportRejected('fd'), /\.fd/)
  }
})

test('publish writes the admitted bytes and refuses symlink or silent appended replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'product-export-'))
  try {
    const bytes = makeFd('written')
    const target = await publishProductExport({ directory: root, basename: '设计.fd', appended: false }, bytes)
    assert.equal(target, path.join(root, '设计.fd'))
    assert.deepEqual(await readFile(target), bytes)
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.futureox-export-')), [])
    const replaced = makeFd('replaced')
    await publishProductExport({ directory: root, basename: '设计.fd', appended: false }, replaced)
    assert.deepEqual(await readFile(target), replaced)
    await assert.rejects(publishProductExport({ directory: root, basename: '设计.fd', appended: true }, bytes), error => error.reason === 'exists')
    assert.deepEqual(await readFile(target), replaced)
    const kept = path.join(root, 'kept.txt')
    await writeFile(kept, 'keep')
    await symlink(kept, path.join(root, 'link.fd'))
    await assert.rejects(publishProductExport({ directory: root, basename: 'link.fd', appended: false }, bytes), error => error.reason === 'path')
    assert.equal(await readFile(kept, 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
