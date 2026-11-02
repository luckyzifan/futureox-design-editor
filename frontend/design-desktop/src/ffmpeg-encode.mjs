// Resolve the bundled FFmpeg and hand that path to the Rust sidecar.
// The renderer receives bytes, never a filesystem path. PATH is a dev-only
// fallback used when dist/bin/ffmpeg is absent; a packaged app does not use it.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const VIDEO_LIMITS = {
  maxFrames: 300,
  maxFrameBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  minFps: 1,
  maxFps: 60,
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function ffmpegExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

function lookupOnPath(name, env, exists) {
  const pathEnv = env.PATH || env.Path || ''
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Packaged apps resolve `resourcesPath/bin/ffmpeg` only.
 * Development prefers `resourcesRoot/bin/ffmpeg` (dist/bin) and may fall
 * back to PATH when that file is missing.
 */
export function resolveBundledFfmpegPath({
  packaged,
  resourcesPath,
  resourcesRoot,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  const name = ffmpegExecutableName(platform)
  const root = packaged ? resourcesPath : resourcesRoot
  if (typeof root !== 'string' || !root) return { path: null, source: 'missing' }
  const bundled = path.join(root, 'bin', name)
  if (exists(bundled)) return { path: bundled, source: 'bundled' }
  if (!packaged) {
    const found = lookupOnPath(name, env, exists)
    if (found) return { path: found, source: 'path' }
  }
  return { path: null, source: 'missing' }
}

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

export function pngFrameBuffers(frames) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > VIDEO_LIMITS.maxFrames) {
    throw fail('INVALID_REQUEST', 'Frame count must be from 1 to 300')
  }
  let total = 0
  return frames.map((frame, index) => {
    let buffer
    try {
      buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
    } catch {
      buffer = Buffer.alloc(0)
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > VIDEO_LIMITS.maxFrameBytes || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
      throw fail('INVALID_REQUEST', `Frame ${index + 1} is not a bounded PNG`)
    }
    total += buffer.length
    if (total > VIDEO_LIMITS.maxTotalBytes) throw fail('TOO_LARGE', 'PNG sequence exceeds 64 MiB')
    return buffer
  })
}

function outputMagicOk(container, bytes) {
  if (container === 'webm') {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  }
  const head = bytes.subarray(0, 64)
  return head.includes(Buffer.from('ftyp'))
}

export async function encodeVideoWithSidecar({ sidecar, ffmpegPath, format, fps, frames }) {
  if (!sidecar || typeof sidecar.request !== 'function') throw fail('BACKEND_UNAVAILABLE', 'Desktop backend is not running')
  if (format !== 'mp4' && format !== 'webm') throw fail('INVALID_REQUEST', 'Video format must be mp4 or webm')
  if (!Number.isInteger(fps) || fps < VIDEO_LIMITS.minFps || fps > VIDEO_LIMITS.maxFps) {
    throw fail('INVALID_REQUEST', 'Frame rate must be an integer from 1 to 60')
  }
  if (typeof ffmpegPath !== 'string' || !path.isAbsolute(ffmpegPath)) throw fail('FFMPEG_UNAVAILABLE', 'Bundled FFmpeg is not installed')
  const buffers = pngFrameBuffers(frames)
  const root = await mkdtemp(path.join(tmpdir(), `futureox-ffmpeg-${randomUUID()}-`))
  try {
    const framesDir = path.join(root, 'frames')
    await mkdir(framesDir)
    for (let index = 0; index < buffers.length; index += 1) {
      await writeFile(path.join(framesDir, `frame_${String(index + 1).padStart(6, '0')}.png`), buffers[index])
    }
    const outputPath = path.join(root, `motion.${format}`)
    await sidecar.request('video.encode', {
      ffmpegPath,
      framesDir,
      outputPath,
      container: format,
      fps,
      frameCount: buffers.length,
    })
    const bytes = await readFile(outputPath)
    if (bytes.length < 8 || bytes.length > VIDEO_LIMITS.maxOutputBytes || !outputMagicOk(format, bytes)) {
      throw fail('VIDEO_ENCODE_FAILED', 'FFmpeg did not write a bounded MP4 or WebM file')
    }
    return {
      status: 'ok',
      bytes,
      mime: format === 'mp4' ? 'video/mp4' : 'video/webm',
      container: format,
      byteLength: bytes.length,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function createVideoEncoder({ getSidecar, resolvePath }) {
  let active = false
  return {
    status() {
      const resolved = resolvePath()
      return { status: 'ok', available: Boolean(resolved.path), source: resolved.source }
    },
    async encode(value) {
      if (active) return { status: 'error', code: 'BUSY', message: 'Another video encode is already running' }
      active = true
      try {
        const resolved = resolvePath()
        if (!resolved.path) throw fail('FFMPEG_UNAVAILABLE', 'Bundled FFmpeg is not installed')
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_REQUEST', 'Invalid video encode request')
        const extra = Object.keys(value).filter(key => !['format', 'fps', 'frames'].includes(key))
        if (extra.length) throw fail('INVALID_REQUEST', 'Invalid video encode request')
        return await encodeVideoWithSidecar({
          sidecar: getSidecar(),
          ffmpegPath: resolved.path,
          format: value.format,
          fps: value.fps,
          frames: value.frames,
        })
      } catch (error) {
        return { status: 'error', code: error.code || 'VIDEO_ENCODE_FAILED', message: error.message || 'FFmpeg encode failed' }
      } finally {
        active = false
      }
    },
  }
}

export function registerVideoEncode(ipcMain, { packaged, resourcesPath, resourcesRoot, getSidecar, assertSender }) {
  const encoder = createVideoEncoder({
    getSidecar,
    resolvePath: () => resolveBundledFfmpegPath({
      packaged: typeof packaged === 'function' ? packaged() : packaged,
      resourcesPath: typeof resourcesPath === 'function' ? resourcesPath() : resourcesPath,
      resourcesRoot,
    }),
  })
  const handle = (name, action) => {
    ipcMain.handle(`design-desktop:${name}`, async (event, value) => {
      assertSender(event)
      return action(value)
    })
  }
  handle('video-encode-status', () => encoder.status())
  handle('video-encode', value => encoder.encode(value))
  return encoder
}
