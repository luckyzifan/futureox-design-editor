import { TileCompositor, type CompositeTile } from './tile-compositor'
import { canvasPixelAt } from '../../canvas-color-picker'
import { KernelClient } from '../client'
import { blank, node, paint, effect } from '../../model'
import { tilePrepareViewport } from '../tile-prepare-viewport'
import type { DesignDocument, Matrix } from '../../model'
import { apply, multiply } from '../../geometry'

const canvas = document.querySelector<HTMLCanvasElement>('#preview')!
const output = document.getElementById('results')!
const stages: unknown[] = []
let compositor: TileCompositor | undefined
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message) }
const sample = (x: number, y: number) => {
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
  const ctx = copy.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(canvas, 0, 0)
  return [...ctx.getImageData(x, y, 1, 1).data]
}
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
try {
  compositor = new TileCompositor(canvas)
  const pixels = new Uint8Array(6 * 6 * 4)
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) pixels.set(y < 3 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 6 + x) * 4)
  const tile: CompositeTile = { key: 'orientation', serial: 1, x: -1, y: -1, width: 6, height: 6, zoom: 1, bytes: pixels }
  compositor.upload(tile)
  const item = { tile, active: true, layer: 0 }
  compositor.draw([item], { x: 0, y: 0, zoom: 16 }, 64, 64, 1)
  await nextFrame()
  assert(sample(16, 8).join() === '255,0,0,255', 'Top row orientation')
  assert(sample(16, 56).join() === '0,255,0,255', 'Bottom row orientation')
  stages.push({ name: 'orientation + gutter clipping', passed: true })
  const uploads = compositor.uploads
  for (let i = 0; i < 60; i++) compositor.draw([item], { x: i / 10, y: 0, zoom: 16 + i / 100 }, 64, 64, 1)
  assert(compositor.uploads === uploads, 'Camera move uploaded pixels again')
  stages.push({ name: '60 camera frames reuse the same texture', uploads: compositor.uploads })
  const red: CompositeTile = { key: 'red', serial: 2, x: 0, y: 0, width: 1, height: 1, zoom: 1, bytes: new Uint8Array([255, 0, 0, 255]) }
  const blue: CompositeTile = { ...red, key: 'blue', serial: 3, bytes: new Uint8Array([0, 0, 255, 128]) }
  compositor.upload(red); compositor.upload(blue)
  const place = { left: 0, top: 0, width: 64, height: 64 }
  compositor.draw([{ tile: red, active: true, layer: 0, gutter: 0, blend: true, placement: place },
    { tile: blue, active: true, layer: 1, gutter: 0, blend: true, placement: place }], { x: 0, y: 0, zoom: 1 }, 64, 64, 1)
  await nextFrame()
  const blended = sample(20, 20)
  assert(Math.abs(blended[0] - 127) <= 1 && blended[1] === 0 && Math.abs(blended[2] - 128) <= 1 && blended[3] === 255, 'Layer alpha/order: ' + blended)
  stages.push({ name: 'transparent layer order and alpha', pixels: blended })
  canvas.dataset.compositor = 'webgl2'; canvas.dataset.frameVisible = 'true'
  const bounds = canvas.getBoundingClientRect()
  assert(canvasPixelAt(document.body, bounds.x + 20, bounds.y + 20) === '#7f0080', 'GPU eyedropper readback')
  stages.push({ name: 'GPU canvas eyedropper', color: '#7f0080' })
  compositor.retain(new Set([3]))
  assert(compositor.bytes === 4 && !compositor.has(tile) && compositor.has(blue), 'Texture retirement accounting')
  stages.push({ name: 'texture retirement', residentBytes: compositor.bytes })
  const doc = blank('translation pixels'); doc.schemaVersion = 3; doc.rasterProfile = 'figma'
  doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const root = node('frame', 20, 20, 30, 30); root.blend = 'multiply'; root.fills = [paint('#e05544', 'linear')]
  const blur = effect('background-blur'); blur.radius = 3; root.effects = [blur]
  // Imported documents may carry explicit null optionals. The very first
  // pointer update must not lose the retained identity while normalizing them.
  Object.assign(root, { constraints: null })
  const background = node('rectangle', 0, 0, 96, 96); background.fills = [paint('#77bbee')]
  doc.nodes = { [background.id]: background, [root.id]: root }; doc.pages[0].children = [background.id, root.id]
  const client = new KernelClient(), reference = new KernelClient()
  try {
    const options = { pageId: doc.pages[0].id, width: 96, height: 96, view: { x: 0, y: 0, zoom: 1 },
      transparent: false, grid: false, livePreview: true, retainInteractionGraph: true, renderIntent: 'preview' as const, rasterProfile: 'figmaSubpixel' as const }
    await client.render(doc, options, false, 'webgpu', true)
    const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, 25, 24] as typeof root.transform } } }
    const retained = await client.render(moved, options, false, 'webgpu', true)
    const fresh = await reference.render(moved, { ...options, retainInteractionGraph: false }, false, 'webgpu', true)
    assert(retained.compileCacheHit, 'Transient translation did not reuse its geometry program')
    let max = 0
    for (let i = 0; i < retained.bytes.length; i++) max = Math.max(max, Math.abs(retained.bytes[i] - fresh.bytes[i]))
    assert(retained.bytes.length === fresh.bytes.length && max <= 1, `Translated scene differs from fresh compilation by ${max}`)
    stages.push({ name: 'retained geometry with gradient, multiply and background blur vs fresh GPU compilation', maxDifference: max })
    retained.bitmap?.close(); fresh.bitmap?.close()
    const exactOptions = { ...options, retainInteractionGraph: false, renderIntent: 'settled' as const }
    const exact = await client.render(moved, exactOptions, false, 'webgpu', true)
    const exactFresh = await reference.render(moved, exactOptions, false, 'webgpu', true)
    let exactMax = 0
    for (let i = 0; i < exact.bytes.length; i++) exactMax = Math.max(exactMax, Math.abs(exact.bytes[i] - exactFresh.bytes[i]))
    assert(exact.bytes.length === exactFresh.bytes.length && exactMax === 0, `Deferred transforms leaked into exact rendering: ${exactMax}`)
    stages.push({ name: 'exact rendering synchronizes deferred transient translations', maxDifference: exactMax })
    exact.bitmap?.close(); exactFresh.bitmap?.close()
  } finally { client.dispose(); reference.dispose() }
  root.effects = [effect('shadow')]; root.effects[0].radius = 2; root.opacity = .65
  const child = node('ellipse', 3, 4, 12, 10)
  child.effects = [effect('background-blur')]; child.effects[0].radius = 2; child.fills[0].opacity = .3
  root.children = [child.id]; doc.nodes[child.id] = child
  const cachedRoots = new KernelClient(), baselineRoots = new KernelClient()
  try {
    const options = { pageId: doc.pages[0].id, width: 96, height: 96, view: { x: 0, y: 0, zoom: 1 },
      transparent: false, grid: false, livePreview: true, retainInteractionGraph: true,
      renderIntent: 'preview' as const, rasterProfile: 'figmaSubpixel' as const }
    const warm = await cachedRoots.render(doc, options, false, 'webgpu', true); warm.bitmap?.close()
    let moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, 25, 24] as typeof root.transform } } }
    for (const edit of [false, true]) {
      if (edit) moved = { ...moved, nodes: { ...moved.nodes, [root.id]: { ...moved.nodes[root.id], opacity: .3 } } }
      const reused = await cachedRoots.render(moved, options, false, 'webgpu', true)
      const fresh = await baselineRoots.render(moved, { ...options, retainInteractionGraph: false }, false, 'webgpu', true)
      let max = 0
      for (let i = 0; i < reused.bytes.length; i++) max = Math.max(max, Math.abs(reused.bytes[i] - fresh.bytes[i]))
      assert(edit ? reused.retainedGroupHits === 0 : (reused.retainedGroupHits || 0) >= 2,
        `Root paint cache invalidation/reuse: ${JSON.stringify({ edit, hits: reused.retainedGroupHits, bytes: reused.retainedGroupBytes, compileHit: reused.compileCacheHit, max })}`)
      assert(max <= 1, `Root paint cache differs from uncached GPU by ${max}`)
      assert((reused.retainedGroupBytes || 0) <= 32 * 1024 * 1024, 'Root cache exceeded its budget')
      stages.push({ name: edit ? 'root content edit revokes retained paint' : 'translated root paint with nested backdrop, shadow, opacity and multiply',
        maxDifference: max, groupHits: reused.retainedGroupHits, groupBytes: reused.retainedGroupBytes })
      reused.bitmap?.close(); fresh.bitmap?.close()
    }
  } finally { cachedRoots.dispose(); baselineRoots.dispose() }
  root.effects = [effect('background-blur')]; root.effects[0].radius = 4
  const group = node('group', 1, 1, 20, 20); group.blend = 'normal'
  const extra = node('rectangle', 8, 9, 10, 10); extra.fills = [paint('#4bdd77')]
  group.children = [child.id, extra.id]; root.children = [group.id]
  doc.nodes[group.id] = group; doc.nodes[extra.id] = extra
  const dependent = new KernelClient(), dependentReference = new KernelClient()
  try {
    const options = { pageId: doc.pages[0].id, width: 96, height: 96, view: { x: 0, y: 0, zoom: 1 },
      transparent: false, grid: false, livePreview: true, retainInteractionGraph: true,
      renderIntent: 'preview' as const, rasterProfile: 'figmaSubpixel' as const }
    const warm = await dependent.render(doc, options, false, 'webgpu', true); warm.bitmap?.close()
    const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, 25, 24] as typeof root.transform } } }
    const reused = await dependent.render(moved, options, false, 'webgpu', true)
    const fresh = await dependentReference.render(moved, { ...options, retainInteractionGraph: false }, false, 'webgpu', true)
    let max = 0
    for (let i = 0; i < reused.bytes.length; i++) max = Math.max(max, Math.abs(reused.bytes[i] - fresh.bytes[i]))
    assert((reused.retainedGroupHits || 0) >= 2 && max <= 1, `Backdrop subtree cache: hits=${reused.retainedGroupHits}, difference=${max}`)
    stages.push({ name: 'external backdrop resampled with isolated subtree cache', maxDifference: max, groupHits: reused.retainedGroupHits })
    const display = await dependent.render(moved, options, false, 'webgpu', false)
    assert(display.bitmap && display.bytes.length === 0, 'Transient display performed a CPU pixel readback')
    const scratch = document.createElement('canvas'); scratch.width = 96; scratch.height = 96
    const context = scratch.getContext('2d')!; context.drawImage(display.bitmap!, 0, 0)
    const displayBytes = context.getImageData(0, 0, 96, 96).data
    let displayMax = 0
    for (let i = 0; i < displayBytes.length; i++) displayMax = Math.max(displayMax, Math.abs(displayBytes[i] - fresh.bytes[i]))
    assert(displayMax <= 1, `GPU bitmap display differs from byte reference by ${displayMax}`)
    stages.push({ name: 'transient GPU bitmap transport without CPU readback', maxDifference: displayMax })
    display.bitmap?.close()
    reused.bitmap?.close(); fresh.bitmap?.close()
  } finally { dependent.dispose(); dependentReference.dispose() }
  for (const scenario of ['clipped', 'expanded-group', 'rotated', 'backdrop-sibling'] as const) {
    const nestedDoc = blank(`nested placement ${scenario}`); nestedDoc.schemaVersion = 3; nestedDoc.rasterProfile = 'figma'
    nestedDoc.colorManagement = doc.colorManagement
    const board = node('frame', scenario === 'rotated' ? 80 : 8, 8, 76, 76)
    board.blend = 'normal'; board.clip = true; board.fills = [paint('#77bbee')]
    if (scenario === 'rotated') board.transform = [0, 1, -1, 0, 80, 8]
    const group = node('group', 3, 4, 20, 20); group.blend = 'multiply'; group.fills = []
    const leaf = node('rectangle', 3, 4, 15, 13); leaf.fills = [paint('#d65c44', 'linear')]
    leaf.constraints = { horizontal: 'scale', vertical: 'center', referenceWidth: 20, referenceHeight: 20 }
    group.children = [leaf.id]; board.children = [group.id]
    nestedDoc.nodes = { [board.id]: board, [group.id]: group, [leaf.id]: leaf }
    if (scenario === 'backdrop-sibling') {
      const lens = node('rectangle', 12, 12, 35, 32); lens.fills = [paint('#ffffff')]; lens.fills[0].opacity = .15
      lens.effects = [effect('background-blur')]; lens.effects[0].radius = 3
      board.children.push(lens.id); nestedDoc.nodes[lens.id] = lens
    }
    nestedDoc.pages[0].children = [board.id]
    const reusedClient = new KernelClient(), freshClient = new KernelClient()
    try {
      const options = { pageId: nestedDoc.pages[0].id, width: 96, height: 96, view: { x: 0, y: 0, zoom: 1 },
        grid: false, transparent: false, livePreview: true, retainInteractionGraph: true,
        interactionSelection: [leaf.id],
        renderIntent: 'preview' as const, rasterProfile: 'figmaSubpixel' as const }
      const warm = await reusedClient.render(nestedDoc, options, false, 'webgpu', true); warm.bitmap?.close()
      const moved = { ...nestedDoc, nodes: { ...nestedDoc.nodes, [leaf.id]: { ...leaf,
        transform: [1, 0, 0, 1, scenario === 'expanded-group' ? 28 : 8, 8] as typeof leaf.transform } } }
      const reused = await reusedClient.render(moved, options, false, 'webgpu', true)
      const fresh = await freshClient.render(moved, { ...options, retainInteractionGraph: false }, false, 'webgpu', true)
      let max = 0
      for (let i = 0; i < reused.bytes.length; i++) max = Math.max(max, Math.abs(reused.bytes[i] - fresh.bytes[i]))
      assert(reused.compileCacheHit && reused.bytes.length === fresh.bytes.length && max <= 1,
        `Nested ${scenario}: cache=${reused.compileCacheHit}, pixel difference=${max}`)
      stages.push({ name: `nested ${scenario} movement vs fresh GPU`, maxDifference: max, compileCacheHit: reused.compileCacheHit })
      reused.bitmap?.close(); fresh.bitmap?.close()
      for (let i = 0; i < 2; i++) (await reusedClient.render(moved, options, false, 'webgpu', true)).bitmap?.close()
      const bindings = (await reusedClient.gpuMemorySnapshot()).driverStats
      assert((bindings?.bindGroupHits || 0) > 0 && (bindings?.bindGroupCacheSize || 0) <= 2048,
        `Binding cache did not reuse stable resources: ${JSON.stringify(bindings)}`)
      stages.push({ name: `binding descriptor reuse ${scenario}`, hits: bindings!.bindGroupHits,
        creates: bindings!.bindGroupCreates, entries: bindings!.bindGroupCacheSize, viewCreates: bindings!.textureViewCreates })
    } finally { reusedClient.dispose(); freshClient.dispose() }
  }
  const filterDocument = blank('paired filter weights'); filterDocument.schemaVersion = 3
  filterDocument.colorManagement = doc.colorManagement; filterDocument.rasterProfile = 'figma'
  const filterShape = node('frame', 20, 20, 48, 42); filterShape.blend = 'normal'; filterShape.fills = [paint('#e64c39', 'linear')]
  filterShape.opacity = .7; filterShape.effects = [effect('blur')]
  filterDocument.nodes = { [filterShape.id]: filterShape }; filterDocument.pages[0].children = [filterShape.id]
  const pairClient = new KernelClient()
  try {
    const differences: { radius: number; maxDifference: number; pairedPasses: number }[] = []
    for (const radius of [.6, 1, 3.25, 31.5, 64, 128.25]) {
      const current = { ...filterDocument, nodes: { [filterShape.id]: { ...filterShape, effects: [{ ...filterShape.effects[0], radius }] } } }
      const options = { pageId: current.pages[0].id, width: 96, height: 96, view: { x: .25, y: .75, zoom: 1 },
        grid: false, transparent: false, renderIntent: 'preview' as const, rasterProfile: 'figmaSubpixel' as const }
      const reference = await pairClient.render(current, options, false, 'webgpu', true, false, { pairedDisplayFilters: false })
      const paired = await pairClient.render(current, options, false, 'webgpu', true, false, { pairedDisplayFilters: true })
      if (radius >= 64) assert((paired.pairedFilterPasses || 0) > 0, 'Paired integrated filter was not exercised')
      let maxDifference = 0
      assert(reference.bytes.length === paired.bytes.length && paired.bytes.length > 0, 'Missing paired filter output')
      for (let i = 0; i < paired.bytes.length; i++) maxDifference = Math.max(maxDifference, Math.abs(reference.bytes[i] - paired.bytes[i]))
      assert(maxDifference <= 1, `Integrated tap pairing differs by ${maxDifference} at radius ${radius}`)
      differences.push({ radius, maxDifference, pairedPasses: paired.pairedFilterPasses || 0 }); reference.bitmap?.close(); paired.bitmap?.close()
    }
    stages.push({ name: 'integrated tap pairing vs original compensated filter', differences })
  } finally { pairClient.dispose() }
  if (new URLSearchParams(location.search).has('fixture')) {
    const response = await fetch('/__render_fixture')
    if (!response.ok) throw Error('Private fixture unavailable')
    const input = await response.json(), document = (input.document || input) as DesignDocument
    const root = document.nodes[document.pages[0].children[1] || document.pages[0].children[0]]
    const tiles = [0, 256].map(offset => ({ key: `guard-${offset}`, x: Math.floor(root.transform[4] + 400 + offset),
      y: Math.floor(root.transform[5] + 300), width: 258, height: 258, zoom: 1 }))
    const view = { x: .25, y: .75, zoom: 1 }, guard = tilePrepareViewport(tiles, view)!
    const worker = new KernelClient()
    try {
      let maxDifference = 0
      for (const tile of tiles) {
        const frames: Uint8Array[] = []
        for (const shared of [false, true]) {
          await worker.render(document, { pageId: document.pages[0].id, width: 258, height: 258, view,
            grid: false, transparent: false, rasterProfile: 'figmaSubpixel', renderIntent: 'canvas',
            tileViewport: [tile], tilePrepareViewport: shared ? guard : undefined,
          }, false, 'webgpu', true, false, { disableExactTileCache: true, disableCertifiedTileReuse: true }, result => {
            if (result.bitmap) {
              const copy = window.document.createElement('canvas'); copy.width = result.width; copy.height = result.height
              const context = copy.getContext('2d')!; context.drawImage(result.bitmap, 0, 0)
              frames.push(new Uint8Array(context.getImageData(0, 0, copy.width, copy.height).data))
              result.bitmap.close()
            } else frames.push(result.bytes)
          })
        }
        assert(frames.length === 2 && frames[0].length === frames[1].length && frames[0].length > 0, 'Missing guard comparison pixels')
        for (let i = 0; i < frames[0].length; i++) maxDifference = Math.max(maxDifference, Math.abs(frames[0][i] - frames[1][i]))
      }
      assert(maxDifference === 0, `Camera-wide preparation changes private fixture pixels: ${maxDifference}`)
      stages.push({ name: 'private complex document: split batches with shared guard vs independent preparation',
        nodes: Object.keys(document.nodes).length, comparedTiles: tiles.length, maxDifference })
      const options = { pageId: document.pages[0].id, width: 512, height: 320,
        view: { x: -root.transform[4] - 400.25, y: -root.transform[5] - 300.75, zoom: 1 },
        grid: false, transparent: false, livePreview: true, renderIntent: 'preview' as const,
        // Unmanaged fine-byte profiles do not enter the float display tier.
        // Use this real document's analytic SDR path to exercise both policies.
        rasterProfile: document.colorManagement ? 'figmaSubpixel' as const : 'analytic' as const }
      // Imported UI kits need not contain a visible filter in this crop.
      // Add the same explicit effect and managed SDR contract to both sides.
      const filteredDocument:DesignDocument={...document,rasterProfile:'figma',colorManagement:{documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000},
        nodes:{...document.nodes,[root.id]:{...root,effects:[...root.effects,{...effect('background-blur'),radius:64}]}}}
      const filterOptions={...options,rasterProfile:'figmaSubpixel' as const}
      const reference = await worker.render(filteredDocument, filterOptions, false, 'webgpu', true, false, { pairedDisplayFilters: false, displayMath: false })
      const paired = await worker.render(filteredDocument, filterOptions, false, 'webgpu', true, false, { pairedDisplayFilters: true })
      assert(!reference.displayMath && paired.displayMath, 'Both arithmetic tiers must be exercised')
      let maxFilterDifference = 0
      assert(paired.bytes.length > 0 && paired.bytes.length === reference.bytes.length && (paired.pairedFilterPasses || 0) > 0, 'Missing private filter comparison')
      for (let i = 0; i < paired.bytes.length; i++) maxFilterDifference = Math.max(maxFilterDifference, Math.abs(paired.bytes[i] - reference.bytes[i]))
      assert(maxFilterDifference <= 1, `Private document paired filter error ${maxFilterDifference}`)
      stages.push({ name: 'private complex document paired filter vs original', maxDifference: maxFilterDifference, pairedPasses: paired.pairedFilterPasses })
      paired.bitmap?.close(); reference.bitmap?.close()
      const denseWorker = new KernelClient()
      try {
        const queue:{id:string;matrix:Matrix}[]=document.pages[0].children.map(id=>({id,matrix:[1,0,0,1,0,0]}))
        let imageCenter:{x:number;y:number}|undefined
        while(queue.length&&!imageCenter){const entry=queue.shift()!,n=document.nodes[entry.id]
          if(!n||!n.visible||n.opacity<=0)continue
          const matrix=multiply(entry.matrix,n.transform)
          if(n.fills.some(p=>p.visible&&p.kind==='image'))imageCenter=apply(matrix,{x:n.width/2,y:n.height/2})
          else queue.push(...n.children.map(id=>({id,matrix})))
        }
        assert(imageCenter,'Real fixture must contain a visible image')
        const exactOptions = { ...options, view:{x:options.width/2-imageCenter!.x,y:options.height/2-imageCenter!.y,zoom:1},renderIntent: 'settled' as const }
        const dense = await denseWorker.render(document, exactOptions, false, 'webgpu', true, false, { denseImageFields: true })
        const axes = await worker.render(document, exactOptions, false, 'webgpu', true)
        let difference = 0
        assert(axes.bytes.length === dense.bytes.length && axes.bytes.length > 0 && (axes.imageAxisFields || 0) > 0, 'Compact image address fields were not exercised')
        for (let i = 0; i < axes.bytes.length; i++) difference = Math.max(difference, Math.abs(axes.bytes[i] - dense.bytes[i]))
        assert(difference === 0, `Exact compact image fields differ by ${difference}`)
        stages.push({ name: 'private complex document exact compact vs dense image coordinates', maxDifference: difference,
          compactFields: axes.imageAxisFields, compactBytes: axes.imageFieldBytes, denseBytes: dense.imageFieldBytes })
        dense.bitmap?.close(); axes.bitmap?.close()
      } finally { denseWorker.dispose() }
    } finally { worker.dispose() }
  }
  output.textContent = JSON.stringify({ status: 'passed', stages }, null, 2)
} catch (error) { output.textContent = JSON.stringify({ status: 'failed', error: String(error), stages }, null, 2) }
// Keep the verified pixels visible; resources are released with this document.
window.addEventListener('pagehide', () => compositor?.dispose(), { once: true })
