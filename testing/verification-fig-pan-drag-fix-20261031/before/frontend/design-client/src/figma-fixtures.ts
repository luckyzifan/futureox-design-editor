import { blank, node, paint, effect, type DesignDocument, type Matrix } from './model'
import { around, rotate } from './geometry'
import { largeReference } from './large-reference'
export type ReferenceCase =
  | 'mask-half-overlap'
  | 'mask-overlap'
  | 'mask-outside'
  | 'rectangle'
  | 'curve'
  | 'rotated-curve'
  | 'alpha-curve'
  | 'shadow'
  | 'layer-blur'
  | 'blur-radii'
  | 'coverage-overlap'
  | 'coverage-overlap-2x'
  | 'group-blur'
  | 'group-shadow'
  | 'group-inner-shadow'
  | 'backdrop-blur'
  | 'pass-through'
  | 'pass-through-opacity'
  | 'isolated-opacity'
  | 'pass-through-blur'
  | 'large-nested'
export const referenceScale = (kind: ReferenceCase) => (kind === 'coverage-overlap-2x' ? 2 : 1)
export const referenceSize = (kind: ReferenceCase) => ({
  width:
    kind === 'large-nested'
      ? 1024
      : kind === 'coverage-overlap-2x'
        ? 768
        : kind === 'blur-radii'
          ? 512
          : kind === 'coverage-overlap'
            ? 384
            : 128,
  height: kind === 'large-nested' ? 768 : kind === 'coverage-overlap-2x' ? 256 : 128,
})
export function figmaFixture(kind: ReferenceCase): DesignDocument {
  if (kind === 'mask-overlap' || kind === 'mask-outside' || kind === 'mask-half-overlap') {
    const d = blank(`Figma-${kind}`),
      frame = node('frame', 0, 0, 128, 128)
    const mask = node('rectangle', kind === 'mask-outside' ? 1000 : 16, 16, 64, 64),
      content = node('rectangle', 16, 16, 64, 64)
    frame.fills = [paint('#ffffff')]
    mask.mask = true
    mask.fills = [paint('#d9d9d9')]
    content.fills = [paint('#ff0000')]
    frame.children = [mask.id, content.id]
    d.pages[0].children = [frame.id]
    for (const n of [frame, mask, content]) d.nodes[n.id] = n
    if (kind === 'mask-half-overlap') {
      mask.opacity = 0.5
      mask.fills = [paint('#ffffff')]
      const blue = node('rectangle', 16, 16, 64, 64)
      blue.fills = [paint('#0000ff')]
      d.nodes[blue.id] = blue
      frame.children.push(blue.id)
    }
    return d
  }
  if (kind === 'large-nested') return largeReference().doc
  if (kind === 'coverage-overlap-2x') return figmaFixture('coverage-overlap')
  const size = referenceSize(kind)
  const d = blank(`Core-QA-${kind}`),
    frame = node('frame', 0, 0, size.width, size.height)
  frame.fills = kind === 'alpha-curve' ? [] : [paint('#ffffff')]
  d.nodes[frame.id] = frame
  d.pages[0].children = [frame.id]
  if (
    ['pass-through', 'pass-through-opacity', 'isolated-opacity', 'pass-through-blur'].includes(kind)
  ) {
    const bg = node('rectangle', 0, 0, 128, 128)
    bg.fills = [paint('#80a0c0')]
    const group = node('group', 16, 16, 96, 96)
    group.fills = []
    group.clip = false
    group.blend = kind === 'isolated-opacity' ? 'normal' : 'pass-through'
    group.opacity = kind === 'pass-through' ? 1 : 0.5
    if (kind === 'pass-through-blur') group.effects = [{ ...effect('blur'), radius: 4 }]
    const a = node('rectangle', 0, 0, 64, 64),
      b = node('rectangle', 32, 32, 64, 64)
    a.blend = 'multiply'
    a.fills = [paint('#cc8040')]
    b.blend = 'screen'
    b.fills = [paint('#4080cc')]
    group.children = [a.id, b.id]
    frame.children = [bg.id, group.id]
    for (const n of [bg, group, a, b]) d.nodes[n.id] = n
    return d
  }
  if (kind === 'backdrop-blur') {
    const add = (n: ReturnType<typeof node>) => {
      d.nodes[n.id] = n
      frame.children.push(n.id)
      return n
    }
    for (const x of [0, 32, 64, 96])
      add(node('rectangle', x, 0, 16, 128)).fills = [paint('#000000')]
    const lens = add(node('rectangle', 16.125, 16.125, 96, 96))
    lens.fills = [{ ...paint('#ffffff'), opacity: 0.1 }]
    lens.effects = [{ ...effect('background-blur'), radius: 4, x: 0, y: 0 }]
    add(node('rectangle', 52, 52, 24, 24)).fills = [paint('#dd4477')]
    return d
  }
  if (kind === 'group-blur' || kind === 'group-shadow' || kind === 'group-inner-shadow') {
    const group = node('group', 8.125, 8.125, 60.4, 60.6)
    group.fills = []
    group.clip = false
    const effectKind =
      kind === 'group-blur' ? 'blur' : kind === 'group-shadow' ? 'shadow' : 'inner-shadow'
    group.effects = [
      { ...effect(effectKind), radius: 4, x: 0, y: 4, spread: 0, color: '#000000', opacity: 0.25 },
    ]
    d.nodes[group.id] = group
    frame.children = [group.id]
    for (const color of ['#000000', '#4477dd']) {
      const child = node('rectangle', 0, 0, 60.4, 60.6)
      child.fills = [paint(color)]
      d.nodes[child.id] = child
      group.children.push(child.id)
    }
    return d
  }
  if (kind === 'coverage-overlap') {
    const add = (x: number, color: string, parent = frame) => {
      const shape = node('rectangle', x, 8.125, 60.4, 60.6)
      shape.fills = [paint(color)]
      d.nodes[shape.id] = shape
      parent.children.push(shape.id)
      return shape
    }
    add(8.125, '#000000')
    const group = node('group', 0, 0, 384, 128)
    group.fills = []
    group.clip = false
    d.nodes[group.id] = group
    frame.children.push(group.id)
    add(136.125, '#000000', group).mask = true
    add(136.125, '#000000', group)
    add(264.125, '#000000')
    add(264.125, '#4477dd')
    return d
  }
  if (kind === 'blur-radii') {
    for (const [i, radius] of [1, 2, 8, 16].entries()) {
      const shape = node('rectangle', 32 + 128 * i, 32, 64, 48)
      shape.fills = [paint('#000000')]
      shape.effects = [{ ...effect('blur'), radius }]
      d.nodes[shape.id] = shape
      frame.children.push(shape.id)
    }
    return d
  }
  const n = node(
    kind === 'rectangle' || kind === 'shadow' || kind === 'layer-blur' ? 'rectangle' : 'vector',
    0,
    0,
    128,
    128,
  )
  n.fills = [paint('#000000')]
  n.strokes = []
  if (kind === 'shadow' || kind === 'layer-blur') {
    n.transform = [1, 0, 0, 1, 32, 32]
    n.width = 64
    n.height = 48
    n.fills = [paint('#4477dd')]
    n.effects = [
      {
        ...effect(kind === 'layer-blur' ? 'blur' : 'shadow'),
        radius: 4,
        x: 0,
        y: 4,
        color: '#000000',
        opacity: 0.25,
        spread: 0,
      },
    ]
  } else if (kind === 'rectangle') {
    n.transform = [1, 0, 0, 1, 8.125, 8.125]
    n.width = 20.4
    n.height = 12.6
  } else {
    n.network = {
      fillRule: 'nonzero',
      vertices: [
        { id: 'a', x: 8, y: 8 },
        { id: 'b', x: 108, y: 8 },
      ],
      edges: [
        { id: 'ab', from: 'a', to: 'b', c1: { x: 8, y: 108 }, c2: { x: 108, y: 108 } },
        { id: 'ba', from: 'b', to: 'a' },
      ],
    }
    if (kind === 'rotated-curve' || kind === 'alpha-curve')
      n.transform = around({ x: 58, y: 45.5 }, rotate(-17)) as Matrix
  }
  d.nodes[n.id] = n
  frame.children = [n.id]
  return d
}
