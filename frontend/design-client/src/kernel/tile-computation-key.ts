import { coordinateSlot } from './exact-tile-cache'
import type { RasterTile } from './tile-cache'

/** Measured byte gradients dither in export-device coordinates. Integer
 * camera translation therefore changes their existing profile's pixels.
 * Pixel preview and grids also retain their precise computation camera.
 * Keep these cameras in both presentation and worker cache identities; a
 * world address alone is not a certificate for those paths. */
export function tileComputationDependsOnCamera(
  options: { rasterProfile?: string; pixelPreview?: number; grid?: boolean; checkerboard?: boolean },
  colorManaged: boolean,
) {
  return !!options.checkerboard || !!options.pixelPreview || !!options.grid || (!colorManaged &&
    (options.rasterProfile === 'figma' || options.rasterProfile === 'figmaSoftware'))
}

/** Camera-translation quantum that reproduces byte-identical tiles for the
 * camera-dependent paths: grid lines sit at world multiples of 32 (so the
 * pattern repeats every 32·scale device pixels) and the figma dither runs on
 * a power-of-two device matrix (512 is a multiple of every period ≤ 512).
 * Shapes inside tiles are world-anchored and independent of the camera
 * translation, so quantizing the raster camera to whole periods restores pan
 * reuse — one re-raster per period instead of one per frame — without moving
 * any content. Pixel preview demands device-exact sampling and stays
 * unquantized. `0` means the camera needs no quantization. */
export function patternCameraPeriod(
  scale: number,
  options: { pixelPreview?: number; grid?: boolean; checkerboard?: boolean; cameraDependent?: boolean },
) {
  if (options.pixelPreview || !options.cameraDependent) return 0
  if (options.checkerboard) return 32
  if (options.grid) {
    const grid = 32 * scale
    return Number.isInteger(grid) && grid >= 1 ? grid : 512
  }
  return 512
}

/** Quantize one camera axis onto the pattern period (integer result). */
export function snapPatternAxis(value: number, period: number) {
  return period > 0 ? Math.round(value / period) * period : value
}

export function tileComputationKey(
  tile: RasterTile,
  camera: { x: number; y: number; zoom: number },
  dependsOnCamera: boolean,
) {
  return dependsOnCamera
    ? `${coordinateSlot([camera.x, camera.y, camera.zoom])}/${tile.key}`
    : tile.key
}

/** Remove whole dither periods from cache identity only. Do NOT snap the
 * render camera to a nearby period: that changes non-periodic translations'
 * dither and exact fractional samples. Far-view rendering keeps its local
 * camera, so geometry precision/admission are untouched. Screen chrome and
 * pixel preview keep their full identities. */
export function periodicComputationCamera(
  camera: {x:number;y:number;zoom:number},
  options: {rasterProfile?:string;pixelPreview?:number;grid?:boolean;checkerboard?:boolean},
  colorManaged:boolean,
) {
  const dependent=tileComputationDependsOnCamera(options,colorManaged)
  if(!dependent || options.pixelPreview || options.grid || options.checkerboard ||
    import.meta.env.VITE_DESIGN_SOURCE_PATTERN_REUSE==='0')return camera
  const period=patternCameraPeriod(camera.zoom,{cameraDependent:dependent})
  if(!period || ![camera.x,camera.y].every(Number.isFinite))return camera
  const axis=(value:number)=>{
    const result=value-snapPatternAxis(value,period)
    return Object.is(result,-0)?0:result
  }
  return {x:axis(camera.x),y:axis(camera.y),zoom:camera.zoom}
}
