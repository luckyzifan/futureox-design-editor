export const MOTION_PREVIEW_FPS = 12
export const MOTION_PREVIEW_MAX_MS = 8_000
export const MOTION_PREVIEW_MAX_FRAMES = 96
export const MOTION_PREVIEW_WIDTH = 960
export const MOTION_PREVIEW_HEIGHT = 540

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type MotionVideoFormat = 'mp4' | 'webm'
export type MotionEncodeBridge = {
  encode(request: { format: MotionVideoFormat; fps: number; frames: Uint8Array[] }): Promise<
    | { status: 'ok'; bytes: Uint8Array; mime: string; container: MotionVideoFormat; byteLength?: number }
    | { status: 'error'; code: string; message: string }
  >
}

export function motionPreviewTimes(durationMs: number, fps = MOTION_PREVIEW_FPS): number[] {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('Invalid motion duration')
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('Invalid motion frame rate')
  const span = Math.min(MOTION_PREVIEW_MAX_MS, Math.max(1, Math.round(durationMs)))
  const count = Math.min(MOTION_PREVIEW_MAX_FRAMES, Math.max(2, Math.round((span / 1000) * fps)))
  const times: number[] = []
  for (let index = 0; index < count; index += 1) times.push(Math.round((span * index) / (count - 1)))
  return times
}

export function motionFileName(name: string, format: MotionVideoFormat) {
  const base = name.replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 80) || 'motion'
  return `${base}.${format}`
}

export async function encodeDesktopFrames(
  bridge: MotionEncodeBridge,
  request: { format: MotionVideoFormat; fps: number; frames: Uint8Array[] },
) {
  if (request.format !== 'mp4' && request.format !== 'webm') throw new Error('Video format must be MP4 or WebM')
  if (!request.frames.length) throw new Error('No frames to encode')
  for (const frame of request.frames) {
    if (frame.length < 8 || PNG_MAGIC.some((byte, index) => frame[index] !== byte)) throw new Error('Motion frames must be PNG')
  }
  const result = await bridge.encode(request)
  if (result.status !== 'ok') throw new Error(result.message || 'FFmpeg encode failed')
  return result
}
