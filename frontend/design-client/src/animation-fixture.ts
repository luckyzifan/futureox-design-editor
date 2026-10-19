import { blank, node, paint, effect, stroke } from './model'
import { createClip, recordKeyframe, spring } from './animation'
export function animationFixture() {
  const doc = blank('Core 动画内核验收'),
    frame = node('frame', 0, 0, 520, 320),
    orb = node('ellipse', 48.125, 98.375, 80, 80),
    card = node('rectangle', 178, 70, 174, 128)
  frame.fills = [paint('#f3f1fa')]
  doc.rasterProfile = 'figma'
  frame.name = '动画画板'
  frame.radii = [18, 18, 18, 18]
  orb.name = '弹簧圆形'
  orb.fills = [paint('#7755dd')]
  orb.effects = [{ ...effect('shadow'), radius: 8, x: 0, y: 6, opacity: 0.3 }]
  card.name = '渐变卡片'
  card.fills = [paint('#4477dd', 'linear')]
  card.radii = [18, 18, 18, 18]
  card.strokes = [stroke('#ffffff', 2)]
  for (const n of [frame, orb, card]) doc.nodes[n.id] = n
  doc.pages[0].children = [frame.id]
  frame.children = [orb.id, card.id]
  const clip = createClip(doc, doc.pages[0].id, [orb.id, card.id])
  clip.name = '弹簧、颜色与效果'
  clip.durationMs = 1200
  clip.repeat = 'alternate'
  for (const t of clip.tracks)
    for (const k of t.keyframes) {
      k.timeMs = k.timeMs ? 1200 : 0
      k.easing = structuredClone(spring)
    }
  doc.animations = [clip]
  const original = structuredClone(doc.nodes)
  orb.transform[4] = 378.125
  orb.opacity = 0.625
  orb.fills = [paint('#dd5577')]
  orb.effects[0].radius = 16
  card.transform = [Math.cos(0.22), Math.sin(0.22), -Math.sin(0.22), Math.cos(0.22), 205, 122]
  card.width = 190
  card.height = 112
  card.fills[0].angle = 80
  card.fills[0].stops[0].color = '#ee9944'
  card.radii = [32, 32, 32, 32]
  recordKeyframe(doc, clip, [orb.id, card.id], 1200, spring)
  doc.nodes = original
  return { doc, clipId: clip.id, orbId: orb.id, cardId: card.id }
}
