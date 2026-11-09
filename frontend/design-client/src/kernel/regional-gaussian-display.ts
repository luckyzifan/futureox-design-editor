/** Allocation retry only: keep native density, original six box passes and
 * every source tap. No caller/document field grants export/HDR authority. */
export function regionalGaussianDisplay(request: {
  backend: string; channel: string; profile?: string; colorSpace?: string
  displayOnly: boolean; regional?: boolean; hdr?: boolean
  pixelPreview?: number; animation?: unknown; exportRegion?: unknown
}, flags: { auto?: unknown; prefix?: unknown; regions?: unknown }) {
  return request.backend === 'webgpu' && request.channel === 'canvas' &&
    request.profile === 'figmaSubpixel' && request.colorSpace === 'srgb' && request.displayOnly &&
    !request.regional && !request.hdr && !request.pixelPreview && !request.animation && !request.exportRegion &&
    flags.auto !== '0' && flags.prefix !== '0' && flags.regions !== '0'
}
export function regionalGaussianAllocationFailure(error: unknown) {
  return String(error).replace(/^Error: /,'') === 'GPU surface budget exceeded'
}
