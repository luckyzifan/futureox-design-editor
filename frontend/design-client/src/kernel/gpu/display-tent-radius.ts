/** SDR display approximation only. Native dependency bounds and authored
 * effects retain their original binary64 radius. Never extend its tap halo. */
export function selectDisplayTentRadius(radius: number, enabled: boolean): number {
  if (!enabled || !Number.isFinite(radius) || radius < 1 || radius > 2048) return radius
  const selected = Math.fround(radius)
  return selected >= 1 && selected <= 2048 && Math.ceil(selected) <= Math.ceil(radius) ? selected : radius
}

/** A scene flag is worker-local intent, not authority on exact output paths.
 * Both launch gates are strict; reused scene objects cannot enable exports. */
export function allowsDisplayTentRadius(
  scene: { displayTentRadius?: boolean; softwareRaster?: boolean; integratedBlur?: boolean; displayFilters?: boolean; displayMaterialSource?: boolean },
  driver: { name?: string; managed?: boolean; hdr?: boolean; displayMath?: boolean },
  readback: boolean, present: boolean,
): boolean {
  return import.meta.env.VITE_DESIGN_DISPLAY_TENT_RADIUS === '1' && import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1' &&
    scene.displayTentRadius === true && scene.integratedBlur === true && driver.name === 'webgpu' && !!driver.managed && !driver.hdr && !driver.displayMath &&
    !scene.softwareRaster && !scene.displayFilters && !scene.displayMaterialSource && !readback && present
}
