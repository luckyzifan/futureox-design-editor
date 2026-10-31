import { usesDesktopDisplay, type DisplayRenderRequest, type RenderPolicy } from './render-policy'

/** Keep the ordinary small-frame whole render. Large physical frames may
 * enter the existing private bitmap assembly without first failing a whole
 * graph. These are the existing preview-area limits, not relaxed GPU guards. */
export const NATIVE_PREVIEW_WHOLE_PIXELS = 1_048_576
export const NATIVE_PREVIEW_ASSEMBLY_PIXELS = 4_100_000

export function usesNativePreviewTiles(flags: { tiles?: unknown; navigation?: unknown; exactClamp?: unknown },
  policy: RenderPolicy, request: DisplayRenderRequest & {
    backend: unknown; livePreview?: unknown; previewTileFallback?: unknown;
    interaction?: unknown; tileViewport?: unknown; captureViewport?: unknown;
    width?: unknown; height?: unknown;
  }): boolean {
  if (flags.tiles !== '1' || flags.navigation !== '1' || flags.exactClamp !== '1' ||
      request.backend !== 'webgpu' || request.renderIntent !== 'preview' || request.livePreview !== true ||
      request.previewTileFallback !== true || request.interaction || request.tileViewport || request.captureViewport ||
      !usesDesktopDisplay(policy, request)) return false
  const { width, height } = request
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192) return false
  const pixels = width * height
  return pixels > NATIVE_PREVIEW_WHOLE_PIXELS && pixels <= NATIVE_PREVIEW_ASSEMBLY_PIXELS
}
