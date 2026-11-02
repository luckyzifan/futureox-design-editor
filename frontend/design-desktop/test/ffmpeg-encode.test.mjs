import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createVideoEncoder,
  encodeVideoWithSidecar,
  pngFrameBuffers,
  resolveBundledFfmpegPath,
} from '../src/ffmpeg-encode.mjs'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d])

test('bundled ffmpeg wins over PATH, and a packaged app does not use PATH', () => {
  const exists = file => file === '/app/bin/ffmpeg' || file === '/usr/bin/ffmpeg'
  assert.deepEqual(resolveBundledFfmpegPath({
    packaged: false,
    resourcesRoot: '/app',
    env: { PATH: '/usr/bin' },
    exists,
  }), { path: '/app/bin/ffmpeg', source: 'bundled' })
  assert.deepEqual(resolveBundledFfmpegPath({
    packaged: true,
    resourcesPath: '/Resources',
    resourcesRoot: '/app',
    env: { PATH: '/usr/bin' },
    exists: file => file === '/usr/bin/ffmpeg',
  }), { path: null, source: 'missing' })
  assert.deepEqual(resolveBundledFfmpegPath({
    packaged: false,
    resourcesRoot: '/missing',
    env: { PATH: '/usr/bin' },
    exists: file => file === '/usr/bin/ffmpeg',
  }), { path: '/usr/bin/ffmpeg', source: 'path' })
  assert.equal(JSON.stringify(resolveBundledFfmpegPath({
    packaged: true,
    resourcesPath: '/Resources',
    exists: () => false,
  })).includes('PATH'), false)
})

test('frame bytes must be bounded PNGs', () => {
  assert.equal(pngFrameBuffers([png]).length, 1)
  assert.throws(() => pngFrameBuffers([Buffer.from('not-png')]), /PNG/)
  assert.throws(() => pngFrameBuffers([]), /Frame count/)
})

test('encode hands the resolved path to Rust and returns container bytes', async () => {
  const seen = []
  const result = await encodeVideoWithSidecar({
    ffmpegPath: '/opt/futureox/ffmpeg',
    format: 'mp4',
    fps: 12,
    frames: [png, png],
    sidecar: {
      async request(method, params) {
        seen.push({ method, params })
        const first = await readFile(path.join(params.framesDir, 'frame_000001.png'))
        const second = await readFile(path.join(params.framesDir, 'frame_000002.png'))
        assert.equal(first.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        assert.equal(second.length, png.length)
        await writeFile(params.outputPath, ftyp)
        return { bytes: ftyp.length, container: 'mp4' }
      },
    },
  })
  assert.equal(seen[0].method, 'video.encode')
  assert.equal(seen[0].params.ffmpegPath, '/opt/futureox/ffmpeg')
  assert.equal(seen[0].params.container, 'mp4')
  assert.equal(seen[0].params.frameCount, 2)
  assert.equal(result.mime, 'video/mp4')
  assert.equal(result.bytes.subarray(4, 8).toString(), 'ftyp')
  assert.equal(await readFile(seen[0].params.framesDir).catch(error => error.code), 'ENOENT')
})

test('status hides the filesystem path and a second encode is busy', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const encoder = createVideoEncoder({
    getSidecar: () => ({
      async request(_method, params) {
        await gate
        await writeFile(params.outputPath, ftyp)
        return { bytes: ftyp.length, container: 'mp4' }
      },
    }),
    resolvePath: () => ({ path: '/secret/bundled/ffmpeg', source: 'bundled' }),
  })
  const status = encoder.status()
  assert.deepEqual(status, { status: 'ok', available: true, source: 'bundled' })
  assert.equal(JSON.stringify(status).includes('/secret'), false)
  const first = encoder.encode({ format: 'mp4', fps: 12, frames: [png] })
  const second = await encoder.encode({ format: 'mp4', fps: 12, frames: [png] })
  assert.equal(second.status, 'error')
  assert.equal(second.code, 'BUSY')
  release()
  const done = await first
  assert.equal(done.status, 'ok')
  assert.equal(Object.hasOwn(done, 'path'), false)
})
