import { expect, test } from 'vitest'
import { blank, node, effect, paint, stroke, type DesignDocument } from '../model'
import { scene, unionBounds } from '../geometry'
import { buildInteractionDependencyScope, interactionRootBounds, type InteractionDependencyScope } from './interaction-scene-bounds'
import { pageBackdropPadding, planInteractionLayers } from './interaction-layers'
import { allowsReducedSampling } from './render-quality'
import { VectorEngine } from '../generated/design-kernel/design_kernel'

// Frozen inline localization logic from the tested pre-refactor renderer.
function reference(document: DesignDocument, selection: string[], zoom: number, dpr: number, allowFixedBackdrop: boolean) {
  const pageId = document.pages[0].id, entries = scene(document, pageId)
  const scope: InteractionDependencyScope = { rootBounds: new Map(), parentLinear: new Map(), localizedBounds: new Set(), shortTravelBounds: new Set(), fixedBounds: new Set(), dependencyPadding: 0, finalForeground: false }
  // Bound propagation through all backdrop filters conservatively. This
  // is computed once per scene, not once per pointer sample.
  scope.dependencyPadding = pageBackdropPadding(document,entries)
  scope.rootBounds = interactionRootBounds(document, pageId, entries)
  // Small nested edits do not need a full-screen capture. Only localize
  // when no backdrop can propagate the changed pixels and every ancestor
  // is an ordinary effect-free, mask-free container; other selections
  // retain the conservative viewport dependency path.
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  scope.parentMatrices = new Map(selection.map(id => [id, byId.get(byId.get(id)?.parent || '')?.matrix || [1, 0, 0, 1, 0, 0] as import('../model').Matrix]))
  scope.parentLinear = new Map(selection.map(id =>
    [id, byId.get(byId.get(id)?.parent || '')?.matrix.slice(0, 4) || [1, 0, 0, 1]]))
  scope.localizedBounds = new Set()
  const noBackdrop = entries.every(entry => !document.nodes[entry.id].effects.some(e =>
    e.visible && ['background-blur', 'glass'].includes(e.kind)))
  if (noBackdrop) for (const id of selection) {
    const entry = byId.get(id), selected = document.nodes[id]
    if (!entry || !entry.ancestors.length || selected.mask || entry.ancestors.some(id => {
      const n = document.nodes[id]
      return n.mask || n.effects.some(e => e.visible) || n.children.some(id => document.nodes[id]?.mask)
    })) continue
    const affected = entries.filter(e => e.id === id || e.ancestors.includes(id)).map(e => {
      const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
      const pad = Math.max(0, ...n.effects.filter(e => e.visible).map(e => e.radius * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0)),
        ...n.strokes.filter(s => s.visible).map(s => s.width * 4)) * scale
      return { x: e.bounds.x - pad, y: e.bounds.y - pad, width: e.bounds.width + 2 * pad, height: e.bounds.height + 2 * pad }
    })
    scope.rootBounds.set(id, unionBounds(affected))
    scope.localizedBounds.add(id)
  }
  // A nested edit cannot escape a fixed, clipped page root. Capture
  // that complete dependency scope even when it has background blur;
  // a large Retina viewport must not force a small board to half density.
  // Optical reads and ancestor layout remain on the conservative path.
  scope.fixedBounds = new Set()
  const finiteBackdrop = !allowsReducedSampling(zoom) || !entries.some(entry => document.nodes[entry.id].effects.some(e => e.visible && e.kind === 'glass'))
  if (!noBackdrop && finiteBackdrop && allowFixedBackdrop) for (const id of selection) {
    const entry=byId.get(id), rootId=entry?.ancestors[0], root=rootId&&document.nodes[rootId], rootEntry=rootId&&byId.get(rootId)
    if(!entry||!root||!rootEntry||root.kind!=='frame'||!root.clip||root.mask||
      root.effects.some(e=>e.visible&&e.kind!=='background-blur'&&e.kind!=='glass')||entry.ancestors.some(id=>{
        const n=document.nodes[id]
        return n.layout&&n.layout.mode!=='none'||n.sizing?.width==='hug'||n.sizing?.height==='hug'||
          !!n.instance||!!n.instanceOrigin||!!n.component||!!n.componentSet||!!n.componentKey||
          Object.keys(n.bindings||{}).length>0||Object.keys(n.variableModes||{}).length>0
      }))continue
    const b=rootEntry.bounds,edge=2/Math.max(1e-6,zoom*dpr)
    scope.rootBounds.set(id,{x:b.x-edge,y:b.y-edge,width:b.width+edge*2,height:b.height+edge*2})
    scope.localizedBounds.add(id);scope.fixedBounds.add(id)
  }
  return scope
}
function fixture() {
  const document = blank(), root = node('frame', 4, 5, 80, 70), group = node('group', 3, 4, 50, 50), leaf = node('rectangle', 8, 9, 20, 25)
  root.clip = true; root.children = [group.id]; group.children = [leaf.id]
  root.blend = group.blend = 'normal'; leaf.fills = [paint('#a13c28')]; leaf.strokes = [stroke('#124e89', 1.25)]
  for (const n of [root, group, leaf]) document.nodes[n.id] = n
  document.pages[0].children = [root.id]
  return { document, root, group, leaf }
}
test('centralized authored capture estimates are exactly equivalent across dependency gates', () => {
  for (const kind of ['none', 'blur', 'shadow', 'background-blur', 'glass', 'mask', 'layout', 'binding'] as const)
    for (const zoom of [.2, 1]) for (const allowFixedBackdrop of [false, true]) {
      const { document, root, group, leaf } = fixture()
      if (kind === 'mask') leaf.mask = true
      else if (kind === 'layout') group.layout = { mode: 'horizontal' } as typeof group.layout
      else if (kind === 'binding') group.bindings = { opacity: 'v' } as typeof group.bindings
      else if (kind !== 'none') (kind === 'background-blur' || kind === 'glass' ? root : leaf).effects = [{ ...effect(kind), radius: 2.5 }]
      const options = { zoom, dpr: 2, allowFixedBackdrop }
      const actual = buildInteractionDependencyScope(document, document.pages[0].id, scene(document, document.pages[0].id), [leaf.id], options)
      expect(actual).toEqual(reference(document, [leaf.id], zoom, 2, allowFixedBackdrop))
    }
})
test('unknown visible effects cannot localize captures or flatten authored layers', () => {
  const { document, leaf, root } = fixture()
  leaf.effects = [{ ...effect('blur'), kind: 'future-effect' as never }]
  const scope = buildInteractionDependencyScope(document, document.pages[0].id, scene(document, document.pages[0].id), [leaf.id], { zoom: 1, dpr: 1, allowFixedBackdrop: true })
  expect(scope.localizedBounds.size).toBe(0); expect(scope.fixedBounds.size).toBe(0)
  expect(planInteractionLayers(document, document.pages[0].id, [root.id])).toBeNull()
})
test('localized capture options and real CPU-WASM bytes remain identical', () => {
  const { document, leaf } = fixture(); leaf.effects = [{ ...effect('shadow'), radius: 2, x: -2, y: 3 }]
  const pageId = document.pages[0].id, selected = [leaf.id]
  const old = reference(document, selected, 1, 1, true)
  const next = buildInteractionDependencyScope(document, pageId, scene(document, pageId), selected, { zoom: 1, dpr: 1, allowFixedBackdrop: true })
  const options = (scope: InteractionDependencyScope) => {
    const b = scope.rootBounds.get(leaf.id)!, x = Math.floor(b.x), y = Math.floor(b.y)
    return JSON.stringify({ pageId, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y,
      view: { x: -x, y: -y, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' })
  }
  expect(options(next)).toBe(options(old))
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(document))
    const a = kernel.render_rgba(options(old)), b = kernel.render_rgba(options(next))
    expect(b).toEqual(a); expect(a.some((value, i) => i % 4 === 3 && value > 0)).toBe(true)
  } finally { kernel.free() }
})

function foregroundFixture() {
  const value = fixture()
  const { document, root, group } = value
  const backdrop = node('rectangle', 0, 0, 75, 60)
  backdrop.fills = [{ ...paint('#eab457'), opacity: .4 }]
  backdrop.effects = [{ ...effect('background-blur'), radius: 3 }]
  document.schemaVersion = 5
  document.nodes[backdrop.id] = backdrop
  root.clip = false
  root.children = [backdrop.id, group.id]
  return { ...value, backdrop }
}
function foregroundScope(value: ReturnType<typeof foregroundFixture>, selection = [value.group.id], allowFixedBackdrop = false) {
  const { document } = value, pageId = document.pages[0].id
  return buildInteractionDependencyScope(document, pageId, scene(document, pageId), selection,
    { zoom: 1, dpr: 2, allowFixedBackdrop })
}
test('earlier backdrop admits the final ordinary nested foreground using the unchanged bounds', () => {
  const value = foregroundFixture(), { document, root, group, backdrop } = value
  const original = JSON.stringify(document)
  const scope = foregroundScope(value)
  expect(scope.finalForeground).toBe(true)
  expect(scope.localizedBounds.has(group.id)).toBe(true)
  expect(scope.fixedBounds.size).toBe(0)
  const withoutBackdrop: DesignDocument = { ...document, nodes: { ...document.nodes,
    [backdrop.id]: { ...backdrop, effects: [] } } }
  expect(scope.rootBounds.get(group.id)).toEqual(reference(withoutBackdrop, [group.id], 1, 2, false).rootBounds.get(group.id))
  expect(scope.dependencyPadding).toBe(0)
  expect(JSON.stringify(document)).toBe(original)
  // A clipped root can retain the smaller foreground proof as well.
  root.clip = true
  const clipped = foregroundScope(value, [group.id], true)
  expect(clipped.rootBounds.get(group.id)).toEqual(scope.rootBounds.get(group.id))
  expect(clipped.fixedBounds.size).toBe(0)
})
test('final foreground ordering is checked at every ancestor and at the page', () => {
  for (const placement of ['selected-sibling', 'ancestor-sibling', 'page-sibling'] as const) {
    const value = foregroundFixture(), { document, root, group, leaf, backdrop } = value
    let selection = [group.id]
    if (placement === 'selected-sibling') root.children = [group.id, backdrop.id]
    else if (placement === 'ancestor-sibling') {
      root.children = [group.id, backdrop.id]; selection = [leaf.id]
    } else {
      root.children = [group.id]; document.pages[0].children.push(backdrop.id)
    }
    expect(foregroundScope(value, selection).localizedBounds.size, placement).toBe(0)
  }
})
test('only proven final foreground discards the padding of earlier page backdrops', () => {
  for (const kind of ['background-blur', 'glass'] as const) {
    const value = foregroundFixture(), { document, root, group, backdrop } = value
    backdrop.effects = [{ ...effect(kind), radius: 3 }]
    root.children = [group.id]
    document.pages[0].children = [backdrop.id, root.id]
    const pageId = document.pages[0].id
    const padding = pageBackdropPadding(document, scene(document, pageId))
    expect(padding).toBeGreaterThan(0)
    const local = foregroundScope(value)
    expect(local.localizedBounds.has(group.id)).toBe(true)
    expect(local.dependencyPadding).toBe(0)
    document.pages[0].children = [root.id, backdrop.id]
    const later = foregroundScope(value)
    expect(later.localizedBounds.size).toBe(0)
    expect(later.finalForeground).toBe(false)
    expect(later.dependencyPadding).toBe(padding)
    document.pages[0].children = [backdrop.id, root.id]
    root.opacity = .5
    const unsupported = foregroundScope(value)
    expect(unsupported.localizedBounds.size).toBe(0)
    expect(unsupported.finalForeground).toBe(false)
    expect(unsupported.dependencyPadding).toBe(padding)
  }
})
test('hidden trailing siblings do not change the final visible paint order', () => {
  const value = foregroundFixture(), hidden = node('rectangle', 1, 1, 10, 10)
  hidden.visible = false; hidden.effects = [effect('background-blur')]
  value.document.nodes[hidden.id] = hidden; value.root.children.push(hidden.id)
  expect(foregroundScope(value).localizedBounds.has(value.group.id)).toBe(true)
})
test('foreground can precede independent blurred and Boolean siblings without capturing earlier backdrops',()=>{
 const value=foregroundFixture(),{document,root,group}=value
 const later=node('group',5,5,80,60),shape=node('vector',0,0,80,60),a=node('rectangle',0,0,70,50),b=node('ellipse',10,10,30,30)
 later.effects=[{...effect('gaussian-blur'),radius:4}];later.children=[shape.id]
 shape.booleanOperation='subtract';shape.children=[a.id,b.id]
 for(const n of [later,shape,a,b])document.nodes[n.id]=n
 root.children.push(later.id)
 expect(foregroundScope(value).finalForeground).toBe(true)
 expect(foregroundScope(value).localizedBounds.has(group.id)).toBe(true)
 b.effects=[effect('background-blur')]
 expect(foregroundScope(value).finalForeground).toBe(false)
 b.effects=[];later.blend='pass-through'
 expect(foregroundScope(value).finalForeground).toBe(false)
})
test('a selected foreground subtree may keep its ordinary leaf text hug sizing', () => {
  const value = foregroundFixture()
  const text = node('text', 1, 1, 12, 10)
  text.sizing = { width: 'hug', height: 'hug' } as typeof text.sizing
  value.document.nodes[text.id] = text; value.group.children.push(text.id)
  expect(foregroundScope(value).localizedBounds.has(value.group.id)).toBe(true)
})
const foregroundRejections: [string, (value: ReturnType<typeof foregroundFixture>) => void][] = [
  ['parent effect', ({ root }) => { root.effects = [effect('blur')] }],
  ['stacked foreground effects', ({ group }) => { group.effects = [effect('shadow'), effect('blur')] }],
  ['radial foreground effect', ({ group }) => { group.effects = [effect('zoom-blur')] }],
  ['descendant foreground effect', ({ leaf }) => { leaf.effects = [effect('blur')] }],
  ['selected backdrop', ({ group }) => { group.effects = [effect('background-blur')] }],
  ['descendant backdrop', ({ leaf }) => { leaf.effects = [effect('background-blur')] }],
  ['unknown preceding effect', ({ backdrop }) => { backdrop.effects = [{ ...effect('blur'), kind: 'future-effect' as never }] }],
  ['pass-through parent', ({ root }) => { root.blend = 'pass-through' }],
  ['parent opacity', ({ root }) => { root.opacity = .5 }],
  ['selected blend', ({ group }) => { group.blend = 'multiply' }],
  ['parent mask', ({ root }) => { root.mask = true }],
  ['selected mask', ({ group }) => { group.mask = true }],
  ['descendant mask', ({ leaf }) => { leaf.mask = true }],
  ['preceding sibling mask', ({ backdrop }) => { backdrop.mask = true }],
  ['parent layout', ({ root }) => { root.layout = { mode: 'horizontal' } as typeof root.layout }],
  ['descendant layout', ({ leaf }) => { leaf.layout = { mode: 'horizontal' } as typeof leaf.layout }],
  ['parent hug sizing', ({ root }) => { root.sizing = { width: 'hug' } as typeof root.sizing }],
  ['selected container hug sizing', ({ group }) => { group.sizing = { width: 'hug' } as typeof group.sizing }],
  ['parent binding', ({ root }) => { root.bindings = { opacity: 'variable' } }],
  ['descendant binding', ({ leaf }) => { leaf.bindings = { opacity: 'variable' } }],
  ['inherited mode', ({ root }) => { root.variableModes = { collection: 'mode' } }],
  ['shared style', ({ leaf }) => { leaf.styleRefs = { fill: 'style' } }],
  ['component definition', ({ group }) => { group.componentSet = true }],
  ['component instance', ({ group }) => { group.instance = {} as never }],
  ['instance origin', ({ root }) => { root.instanceOrigin = { owner: 'a', key: 'b', source: 'c' } }],
  ['component key', ({ leaf }) => { leaf.componentKey = 'component' }],
  ['boolean ancestor', ({ root }) => { root.booleanOperation = 'union' }],
  ['descendant repeat', ({ leaf }) => { leaf.repeat = {} as never }],
  ['attached connector', ({ backdrop }) => { backdrop.connector = {} as never }],
  ['animation', ({ document }) => { document.animations = [{} as never] }],
]
test.each(foregroundRejections)('final foreground keeps the conservative fallback for %s', (_label, change) => {
  const value = foregroundFixture(); change(value)
  expect(foregroundScope(value).localizedBounds.size).toBe(0)
})
test('new foreground admission does not broaden multi-selection or overlapping selection rules', () => {
  const value = foregroundFixture()
  expect(foregroundScope(value, [value.group.id, value.leaf.id]).localizedBounds.size).toBe(0)
})
test.each([false,true])('complete CPU-WASM changes stay inside foreground footprints with later isolated effects=%s', laterEffects => {
  const value = foregroundFixture(), { document, group } = value
  if(laterEffects){
    document.schemaVersion=18
    const later=node('rectangle',10,10,80,60);later.fills=[{...paint('#b07547'),opacity:.6}]
    later.effects=[{...effect('gaussian-blur'),radius:4}];document.nodes[later.id]=later;value.root.children.push(later.id)
  }
  document.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  document.rasterProfile = 'figma'
  const scope = foregroundScope(value), beforeBounds = scope.rootBounds.get(group.id)!
  const dx = 14.25, dy = -3.5
  const moved: DesignDocument = { ...document, nodes: { ...document.nodes,
    [group.id]: { ...group, transform: [...group.transform.slice(0, 4), group.transform[4] + dx, group.transform[5] + dy] as typeof group.transform } } }
  const afterBounds = { ...beforeBounds, x: beforeBounds.x + dx, y: beforeBounds.y + dy }
  const options = JSON.stringify({ pageId: document.pages[0].id, width: 128, height: 128,
    view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'figma' })
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(document))
    const before = kernel.render_linear(options)
    kernel.load_document(JSON.stringify(moved))
    const after = kernel.render_linear(options)
    const beforeBits = new Uint32Array(before.buffer, before.byteOffset, before.length)
    const afterBits = new Uint32Array(after.buffer, after.byteOffset, after.length)
    let changed = 0
    for (let pixel = 0; pixel < 128 * 128; pixel++) {
      if ([0, 1, 2, 3].every(channel => beforeBits[pixel * 4 + channel] === afterBits[pixel * 4 + channel])) continue
      changed++
      const x = pixel % 128, y = Math.floor(pixel / 128)
      expect([beforeBounds, afterBounds].some(b => x + 1 >= b.x && x <= b.x + b.width &&
        y + 1 >= b.y && y <= b.y + b.height), `changed pixel ${x},${y} outside the admitted capture`).toBe(true)
    }
    expect(changed).toBeGreaterThan(0)
  } finally { kernel.free() }
})

test.each(['blur', 'gaussian-blur', 'shadow', 'inner-shadow', 'color-controls'] as const)(
  'selected self-filter %s localizes only after all backdrop reads, with complete float-pixel containment', kind => {
    const value = foregroundFixture(), { document, group, root, backdrop } = value
    document.schemaVersion = 20
    document.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
    document.rasterProfile = 'figma'
    group.effects = [{ ...effect(kind), radius: 3.25, x: -2.5, y: 1.75 }]
    value.leaf.strokes = kind === 'gaussian-blur' || kind === 'shadow' ? [stroke('#124e89',2)] : [] // single-halo source support
    const scope = foregroundScope(value), bounds = scope.rootBounds.get(group.id)!
    expect(scope.finalForeground).toBe(true)
    expect(scope.localizedBounds.has(group.id)).toBe(true)
    expect(scope.dependencyPadding).toBe(0)
    const kernel = new VectorEngine(), dx = 11.25, dy = 7.5
    const options = JSON.stringify({ pageId: document.pages[0].id, width: 128, height: 128,
      view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'figmaSubpixel' })
    try {
      kernel.load_document(JSON.stringify(document)); const before = kernel.render_linear(options)
      const moved = { ...document, nodes: { ...document.nodes, [group.id]: { ...group,
        transform: [...group.transform.slice(0, 4), group.transform[4] + dx, group.transform[5] + dy] } } }
      kernel.load_document(JSON.stringify(moved)); const after = kernel.render_linear(options)
      const a = new Uint32Array(before.buffer, before.byteOffset, before.length), b = new Uint32Array(after.buffer, after.byteOffset, after.length)
      let changed = 0
      for (let i = 0; i < 128 * 128; i++) {
        if ([0, 1, 2, 3].every(c => a[i * 4 + c] === b[i * 4 + c])) continue
        changed++
        const x = i % 128, y = Math.floor(i / 128)
        expect([bounds, { ...bounds, x: bounds.x + dx, y: bounds.y + dy }].some(r =>
          x + 1 >= r.x && x <= r.x + r.width && y + 1 >= r.y && y <= r.y + r.height)).toBe(true)
      }
      expect(changed).toBeGreaterThan(0)
    } finally { kernel.free() }
    root.children = [group.id, backdrop.id]
    expect(foregroundScope(value).finalForeground).toBe(false)
  })


test('one isolated root filter expands geometry and centered strokes once; outside strokes stay conservative',()=>{
 const value=foregroundFixture(),{group,leaf}=value;group.effects=[{...effect('gaussian-blur'),radius:4}];leaf.strokes=[]
 const plain=foregroundScope(value).rootBounds.get(group.id)!
 const entries=scene(value.document,value.document.pages[0].id),geometry=unionBounds(entries.filter(e=>e.id===group.id||e.ancestors.includes(group.id)).map(e=>e.bounds))
 expect(plain).toEqual({x:geometry.x-12,y:geometry.y-12,width:geometry.width+24,height:geometry.height+24})
 leaf.strokes=[stroke('#124e89',3)]
 const stroked=foregroundScope(value).rootBounds.get(group.id)!
 expect(stroked.width).toBeGreaterThan(plain.width);expect(stroked.height).toBeGreaterThan(plain.height)
 leaf.strokes[0].align='outside';const outside=foregroundScope(value).rootBounds.get(group.id)!
 expect(outside.width).toBeGreaterThanOrEqual(stroked.width)
})

test('a leaf with two inner shadows can localize its output until a later layer reads its backdrop', () => {
  const value = foregroundFixture(), { root, group, leaf, backdrop } = value
  leaf.effects = [{ ...effect('inner-shadow'), radius: 24 }, { ...effect('inner-shadow'), radius: 18 }]
  const scope = foregroundScope(value, [leaf.id])
  expect(scope.finalForeground).toBe(true)
  expect(scope.localizedBounds.has(leaf.id)).toBe(true)
  expect(scope.containedForeground).toBe(true)
  root.children = [group.id, backdrop.id]
  expect(foregroundScope(value, [leaf.id]).localizedBounds.has(leaf.id)).toBe(false)
})
