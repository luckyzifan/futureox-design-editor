import test from 'node:test'
import assert from 'node:assert/strict'
import { imageData } from './image-import.ts'

function browser(t, { width = 100, height = 80, data = 'data:image/png;base64,EXACT+SOURCE==', readError, abort = false, decodeError } = {}) {
  const original = { FileReader: globalThis.FileReader, Image: globalThis.Image, document: globalThis.document }
  let decodes = 0
  globalThis.document = { createElement() { throw Error('Canvas re-encoding is forbidden') } }
  globalThis.FileReader = class {
    readAsDataURL() {
      queueMicrotask(() => {
        if (readError) { this.error = readError; this.onerror(); return }
        if (abort) { this.onabort(); return }
        this.result = data; this.onload()
      })
    }
  }
  globalThis.Image = class {
    naturalWidth = width; naturalHeight = height; width = 1; height = 1
    async decode() { decodes++; if (decodeError) throw decodeError }
  }
  t.after(() => { for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value
  } })
  return { data, decodes: () => decodes }
}
const file = (type = 'image/png', size = 5) => ({ type, size })
test('preserves exact original bytes and intrinsic dimensions without a canvas', async t => {
  const env = browser(t)
  assert.deepEqual(await imageData(file()), { data: env.data, width: 100, height: 80 })
  assert.equal(env.decodes(), 1)
})
test('PNG, JPEG and WebP retain their original encoded payload', async t => {
  const env = browser(t)
  for (const type of ['image/png', 'image/jpeg', 'image/webp'])
    assert.equal((await imageData(file(type))).data, env.data)
})
test('accepts exact pixel limit and never marks an asset resized', async t => {
  browser(t, { width: 4096, height: 4096 })
  const result = await imageData(file())
  assert.equal(result.width * result.height, 16_777_216)
  assert.equal(result.resized, undefined)
})
test('rejects oversized assets instead of downsampling or lossy reencoding', async t => {
  browser(t, { width: 5000, height: 5000 })
  await assert.rejects(imageData(file()), /未自动缩小或重新编码/)
})
test('honors smaller managed-image admission limits', async t => {
  browser(t, { width: 4096, height: 4096 })
  await assert.rejects(imageData(file(), 8_388_608), /像素预算/)
})
test('rejects invalid budgets before browser decoding', async t => {
  const env = browser(t)
  for (const value of [0, -1, 1.5, NaN, Infinity, 16_777_217])
    await assert.rejects(imageData(file(), value), /无效的图片像素预算/)
  assert.equal(env.decodes(), 0)
})
test('rejects unsupported type and oversized encoded files', async t => {
  const env = browser(t)
  await assert.rejects(imageData(file('image/svg+xml')), /PNG、JPEG、WebP、GIF 或 TIFF/)
  await assert.rejects(imageData(file('image/png', 8 * 1024 * 1024 + 1)), /8 MB/)
  assert.equal(env.decodes(), 0)
})
test('propagates read failure without logging source data', async t => {
  const error = Error('read failure'); browser(t, { readError: error })
  await assert.rejects(imageData(file()), value => value === error)
})
test('settles aborted reads', async t => {
  browser(t, { abort: true }); await assert.rejects(imageData(file()), /读取已取消/)
})
test('propagates decode failure without accepting an asset', async t => {
  const error = Error('decode failure'); browser(t, { decodeError: error })
  await assert.rejects(imageData(file()), value => value === error)
})
test('rejects invalid decoded dimensions', async t => {
  browser(t, { width: -1, height: 100 }); await assert.rejects(imageData(file()), /尺寸无效/)
})

test('rejects zero intrinsic size rather than using layout dimensions', async t => {
  browser(t, { width: 0, height: 0 }); await assert.rejects(imageData(file()), /尺寸无效/)
})
test('rejects oversized data URIs without decoding or reencoding', async t => {
  const env = browser(t, { data: 'x'.repeat(12 * 1024 * 1024 + 1) })
  await assert.rejects(imageData(file()), /12 MB/)
  assert.equal(env.decodes(), 0)
})
