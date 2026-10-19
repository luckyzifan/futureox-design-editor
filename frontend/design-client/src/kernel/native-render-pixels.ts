import type { NativeRenderFramePayload } from '../desktop'

/** Binary replies are explicit and owned; unknown encodings fail closed. */
export function decodeNativeRenderPixels(frame: NativeRenderFramePayload & { width: number; height: number }): Uint8Array {
  let rgba: Uint8Array
  if (frame.encoding === undefined && typeof frame.rgba === 'string') {
    rgba = Uint8Array.from(atob(frame.rgba), (c) => c.charCodeAt(0))
  } else if (frame.encoding === 'rgba8' && frame.rgba instanceof Uint8Array) {
    rgba = frame.rgba
  } else {
    throw new Error('Unknown native render pixel encoding')
  }
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width <= 0 || frame.height <= 0 || rgba.length !== frame.width * frame.height * 4) {
    throw new Error('Native render pixel dimensions mismatch')
  }
  return rgba
}

