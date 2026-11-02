import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeDesktopFrames,
  motionFileName,
  motionPreviewTimes,
  MOTION_PREVIEW_FPS,
  MOTION_PREVIEW_MAX_FRAMES,
  MOTION_PREVIEW_MAX_MS,
} from './motion-preview.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

test('a long clip is capped at 8 seconds and 96 frames', () => {
  const times = motionPreviewTimes(60_000)
  assert.equal(times.length, MOTION_PREVIEW_MAX_FRAMES)
  assert.equal(times[0], 0)
  assert.equal(times.at(-1), MOTION_PREVIEW_MAX_MS)
  assert.equal(MOTION_PREVIEW_FPS, 12)
})

test('a short clip still has two frames', () => {
  assert.deepEqual(motionPreviewTimes(100), [0, 100])
  assert.deepEqual(motionPreviewTimes(0), [0, 1])
  assert.throws(() => motionPreviewTimes(100, 0), /frame rate/)
})

test('file names drop path characters', () => {
  assert.equal(motionFileName('clip/a\nb', 'mp4'), 'clip a b.mp4')
  assert.equal(motionFileName('   ', 'webm'), 'motion.webm')
})

test('encode refuses a non-PNG and surfaces the bridge error', async () => {
  const calls = []
  const bridge = {
    async encode(request) {
      calls.push(request)
      return { status: 'error', code: 'VIDEO_ENCODE_FAILED', message: 'ffmpeg exited 1' }
    },
  }
  await assert.rejects(encodeDesktopFrames(bridge, { format: 'mp4', fps: 12, frames: [new Uint8Array([1, 2, 3, 4])] }), /PNG/)
  assert.equal(calls.length, 0)
  await assert.rejects(encodeDesktopFrames(bridge, { format: 'webm', fps: 12, frames: [png] }), /exited 1/)
  assert.equal(calls.length, 1)
})
