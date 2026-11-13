import type { GpuScene } from './types'

/** Shader specialization removes unreachable dispatch branches; it never changes the numeric program. */
export const baseCompositorModes=[1,2,12,15,19,21,23,24,25,26,27,28,29,30]
export function compositorModes(scene: GpuScene) {
  const modes = new Set(Object.keys(scene.nodes).length ? baseCompositorModes : [12])
  if (scene.coherentSamples) modes.add(scene.resolve ? 24 : 23)
  else if (scene.resolve) modes.add(21)
  if (scene.presentation) { modes.add(18); modes.add(33) }
  for (const n of Object.values(scene.nodes)) {
    if (n.blend !== 'normal' || n.fills.some((p) => p.blend !== 'normal') || n.strokes.some((s) => s.paint.blend !== 'normal')) modes.add(3)
    for (const effect of n.effects) {
    if (!effect.visible) continue
    if (effect.kind === 'shadow' || effect.kind === 'inner-shadow') { modes.add(6); if (effect.spread) modes.add(5) }
    if (effect.kind === 'glass') {
    if (n.glassShape && effect.glass) modes.add(34)
    else { modes.add(9); modes.add(10); modes.add(11) }
    }
      if (effect.kind === 'noise') modes.add(7)
      if (effect.colorControls) modes.add(60)
      if (effect.kind === 'motion-blur') modes.add(61)
      if (effect.kind === 'zoom-blur') modes.add(62)
      if (effect.kind === 'texture') modes.add(8)
      // One-pass GPU gradient-blur composite (shared vector shader mode 46).
      // Background blur uses the same blend of the sharp capture and the
      // filtered capture; omitting it leaves the managed pipeline unprepared.
      if ((effect.kind === 'blur' || effect.kind === 'background-blur') && effect.gradientBlur) modes.add(46)
    }
  }
  return modes
}
