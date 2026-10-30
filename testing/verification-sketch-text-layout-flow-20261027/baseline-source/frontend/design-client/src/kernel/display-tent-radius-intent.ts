import { usesDesktopDisplay, type DisplayRenderRequest, type RenderPolicy } from './render-policy'

/** Worker launch policy only. A request/document scene field grants no
 * capability; each compiled scene is overwritten at its real backend boundary. */
export function usesDisplayTentRadiusIntent(flag: unknown, exactFlag: unknown, policy: RenderPolicy,
  request: DisplayRenderRequest): boolean {
  return flag === '1' && exactFlag === '1' && usesDesktopDisplay(policy, request)
}
export function stampDisplayTentRadius(scene: { displayTentRadius?: boolean; softwareRaster?: boolean },
  trustedIntent: boolean, backend: unknown) {
  scene.displayTentRadius = trustedIntent === true && backend === 'webgpu' && !scene.softwareRaster
}
