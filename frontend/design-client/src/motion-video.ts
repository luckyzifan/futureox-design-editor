import { useEffect, useState } from 'react'
import { desktopBridge } from './desktop'
export {
  encodeDesktopFrames,
  motionFileName,
  motionPreviewTimes,
  MOTION_PREVIEW_FPS,
  MOTION_PREVIEW_HEIGHT,
  MOTION_PREVIEW_MAX_FRAMES,
  MOTION_PREVIEW_MAX_MS,
  MOTION_PREVIEW_WIDTH,
} from './motion-preview.ts'

export function useVideoEncodeAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    const bridge = desktopBridge()?.videoEncode
    if (!bridge) return undefined
    let cancelled = false
    void bridge.status().then(
      result => {
        if (!cancelled && result.status === 'ok' && result.available) setAvailable(true)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [])
  return available
}
