import { KernelClient, type TileResult } from './client'
import { sameBytes } from './exact-tile-cache'
import { blank, node, paint, type DesignDocument } from '../model'
import { blends } from './gpu/types'
import { initializePicking } from './picking'
const output = document.querySelector('#results')!,
  canvas = document.querySelector<HTMLCanvasElement>('#display')!
const report: { status: string; stages: unknown[]; error?: string } = {
  status: 'running',
  stages: [],
}
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const frame = () => new Promise(requestAnimationFrame)
const compare = (
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  region?: { x: number; y: number; w: number; h: number },
) => {
  let max = 0,
    sum = 0,
    changed = 0
  let count = 0
  for (let i = 0; i < a.length; i++) {
    if (region) {
      const x = Math.floor(i / 4) % 256,
        y = Math.floor(i / 4 / 256)
      if (x < region.x || x >= region.x + region.w || y < region.y || y >= region.y + region.h)
        continue
    }
    const delta = Math.abs(a[i] - b[i])
    max = Math.max(max, delta)
    sum += delta * delta
    if (delta > 2) changed++
    count++
  }
  return { max, rms: Math.sqrt(sum / count), changedFraction: changed / count }
}
let owner: KernelClient | undefined, reference: KernelClient | undefined
try {
  await initializePicking()
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document required')
  const input = await response.json(),
    doc: DesignDocument = input.document || input,
    page = doc.pages[0],
    id = page.children[1] || page.children[0],
    root = doc.nodes[id]
  const width = 256,
    height = 192,
    zoom = 0.5
  const center = {
    x: root.transform[4] + Math.min(root.width / 4, 200),
    y: root.transform[5] + Math.min(root.height / 3, 200),
  }
  const options = {
    pageId: page.id,
    width,
    height,
    view: { x: width / 2 - center.x * zoom, y: height / 2 - center.y * zoom, zoom },
    transparent: false,
    grid: false,
    rasterProfile: 'figmaSubpixel' as const,
    renderIntent: 'canvas' as const,
  }
  reference = new KernelClient()
  const expected = await reference.render(doc, options, false, 'webgpu', true)
  reference.dispose()
  reference = undefined
  owner = new KernelClient()
  let last: Record<string, unknown> = {}
  owner.onPresentation = (stats) => {
    last = stats
  }
  owner.attachPresentation(canvas.transferControlToOffscreen())
  const readPixels = () => {
    const probe = document.createElement('canvas')
    probe.width = width
    probe.height = height
    const context = probe.getContext('2d', { willReadFrequently: true })!
    context.drawImage(canvas, 0, 0)
    return context.getImageData(0, 0, width, height).data
  }
  const show = async (
    result: Awaited<ReturnType<KernelClient['render']>>,
    camera = options.view,
    background?: number,
    blended = false,
  ) => {
    if (!result.gpuTile || result.bitmap || result.bytes.length)
      throw Error('Expected same-device GPU texture without bitmap or CPU bytes')
    const previous = Number(last.compositorFrames || 0)
    const ids = background ? [background, result.gpuTile] : [result.gpuTile]
    owner!.present({
      view: camera,
      width,
      height,
      dpr: 1,
      interaction: !!background,
      linearBlend: blended,
      backgroundLinear: result.backgroundLinear,
      items: ids.map((id, layer) => ({
        active: true,
        layer,
        gutter: 0,
        blend: blended,
        tile: {
          key: 'probe',
          serial: id,
          gpuTile: id,
          x: -camera.x,
          y: -camera.y,
          width,
          height,
          zoom: camera.zoom,
        },
      })),
    })
    const start = performance.now()
    while (Number(last.compositorFrames || 0) <= previous) {
      if (last.error) throw Error(String(last.error))
      if (performance.now() - start > 10000) throw Error('Display acknowledgement timeout')
      await frame()
    }
    await frame()
    await frame()
    return readPixels()
  }
  const resident = await owner.render(doc, options, false, 'webgpu', false)
  const pixels = await show(resident),
    difference = compare(expected.bytes, pixels)
  report.stages.push({
    name: 'real overlapping boards: resident vs readback',
    nodes: Object.keys(doc.nodes).length,
    difference,
    display: last,
  })
  publish()
  if (difference.max > 2)
    throw Error(`Resident display pixel difference ${JSON.stringify(difference)}`)
  let settledDamage = 0
  owner.onDamage = () => settledDamage++
  // Separate transient lane on the same GPU; exact and temporary documents
  // must not patch or invalidate one another.
  const transient = {
    ...options,
    renderIntent: 'preview' as const,
    livePreview: true,
    retainInteractionGraph: true,
    interactionChannel: true,
    interactionWindow: { x: 32, y: 32, w: width - 64, h: height - 64 },
  }
  const independent = await owner.render(doc, {...transient,retainInteractionGraph:false,transparent:true}, false, 'webgpu', false)
  const warmed = await owner.render(doc, transient, false, 'webgpu', false)
  const interleaved = await owner.render(doc, options, false, 'webgpu', false)
  const position = root.transform,
    shifted: DesignDocument = {
      ...doc,
      nodes: {
        ...doc.nodes,
        [id]: {
          ...root,
          transform: [
            ...position.slice(0, 4),
            position[4] + 0.5,
            position[5] + 0.25,
          ] as typeof position,
        },
      },
    }
  if (!warmed.residentInteraction) throw Error('Resident pose updates were not enabled')
  await show(warmed, options.view, resident.gpuTile)
  const poseStarted = performance.now()
  owner.moveResidentInteraction(
    warmed.gpuTile!,
    { [id]: shifted.nodes[id].transform },
    { sequence: 1, at: poseStarted },
  )
  while (!(last.residentSample as { sequence?: number } | undefined)?.sequence) {
    if (performance.now() - poseStarted > 10000) throw Error('Resident pose did not present')
    await frame()
  }
  const poseSample = last.residentSample as { needsRebase?: boolean; groupHits?: number }
  if (poseSample.needsRebase) throw Error('Small resident movement unexpectedly recompiled')
  report.stages.push({
    name: 'worker-owned pose and direct presentation',
    latencyMs: performance.now() - poseStarted,
    sample: poseSample,
  })
  publish()
  await frame()
  await frame()
  const posePixels = readPixels()
  owner.stopResidentInteraction(warmed.gpuTile!)
  const moving = await owner.render(shifted, transient, false, 'webgpu', false),
    movingPixels = await show(moving)
  report.stages.push({
    name: 'fractional backdrop/multiply motion',
    reused: moving.compileCacheHit,
    ms: moving.roundTripMs,
    compileMs: moving.compileMs,
    graphMs: moving.graphMs,
    groupHits: moving.retainedGroupHits,
    settledDamage,
  })
  publish()
  if (settledDamage) throw Error('Interaction lane invalidated settled page')
  if (!moving.retainedGroupHits)
    throw Error('Ordinary canvas work evicted warmed interaction subtrees')
  const fresh = await owner.render(
    shifted,
    { ...transient, retainInteractionGraph: false, interactionWindow: undefined },
    false,
    'webgpu',
    false,
    false,
    { disableSceneCache: true },
  )
  const freshPixels = await show(fresh),
    transientDifference = compare(movingPixels, freshPixels, transient.interactionWindow)
  report.stages.push({
    name: 'fractional reused vs freshly compiled preview',
    difference: transientDifference,
  })
  publish()
  // Edge resampling is approximate during motion; large color/backdrop errors
  // are not. Settled output still uses the exact path checked above.
  if (transientDifference.rms > 5 || transientDifference.changedFraction > 0.1)
    throw Error('Fractional preview exceeded visual error budget')
  const poseDifference = compare(posePixels, freshPixels, transient.interactionWindow)
  report.stages.push({
    name: 'direct worker pose pixels vs fresh full scene',
    difference: poseDifference,
  })
  if (poseDifference.rms > 5 || poseDifference.changedFraction > 0.1)
    throw Error('Direct pose pixels differ from full scene')
  const resumed = await owner.render(doc, options, false, 'webgpu', false),
    resumedPixels = await show(resumed),
    restored = compare(expected.bytes, resumedPixels)
  if (restored.max > 2) throw Error('Settled lane changed after interaction')
  owner.releasePresented([
    resident.gpuTile!,
    independent.gpuTile!,
    warmed.gpuTile!,
    interleaved.gpuTile!,
    moving.gpuTile!,
    fresh.gpuTile!,
  ])
  report.stages.push({ name: 'settled lane restored', difference: restored, display: last })
  const blendDoc = blank('SDR blend display gate')
  blendDoc.schemaVersion = 3
  blendDoc.colorManagement = doc.colorManagement
  blendDoc.rasterProfile = 'figma'
  for (const [index, mode] of blends.entries()) {
    const x = (index % 6) * 42,
      y = Math.floor(index / 6) * 62,
      back = node('rectangle', x, y, 42, 62),
      front = node('ellipse', x + 4.25, y + 6.5, 34, 48)
    back.fills = [paint('#418cc7')]
    front.fills = [paint('#de4389')]
    front.opacity = 0.63
    front.blend = mode as typeof front.blend
    blendDoc.nodes[back.id] = back
    blendDoc.nodes[front.id] = front
    blendDoc.pages[0].children.push(back.id, front.id)
  }
  const blendOptions = { ...options, pageId: blendDoc.pages[0].id, view: { x: 0, y: 0, zoom: 1 } }
  reference = new KernelClient()
  const blendReference = await reference.render(blendDoc, blendOptions, false, 'webgpu', true)
  reference.dispose()
  reference = undefined
  const blendDisplay = await owner.render(blendDoc, blendOptions, false, 'webgpu', false),
    blendPixels = await show(blendDisplay, blendOptions.view)
  const blendDifference = compare(blendReference.bytes, blendPixels)
  report.stages.push({
    name: 'all 18 blend modes: native arithmetic vs reference',
    difference: blendDifference,
  })
  if (blendDifference.max > 2)
    throw Error(`Native blend display mismatch ${JSON.stringify(blendDifference)}`)
  const alphaDoc = blank('linear isolated layer composition')
  alphaDoc.schemaVersion = 3
  alphaDoc.colorManagement = doc.colorManagement
  alphaDoc.rasterProfile = 'figma'
  const red = node('rectangle', 0, 0, width, height),
    blue = node('rectangle', 20, 30, 160, 100)
  red.fills = [paint('#ff0000')]
  blue.fills = [paint('#0000ff')]
  blue.opacity = 0.5
  alphaDoc.nodes[red.id] = red
  alphaDoc.nodes[blue.id] = blue
  alphaDoc.pages[0].children = [red.id, blue.id]
  const alphaOptions = { ...options, pageId: alphaDoc.pages[0].id, view: { x: 0, y: 0, zoom: 1 } }
  reference = new KernelClient()
  const alphaReference = await reference.render(alphaDoc, alphaOptions, false, 'webgpu', true)
  reference.dispose()
  reference = undefined
  const isolate = (id: string) => ({
    ...alphaDoc,
    nodes: {
      ...alphaDoc.nodes,
      ...Object.fromEntries(
        alphaDoc.pages[0].children
          .filter((other) => other !== id)
          .map((other) => [other, { ...alphaDoc.nodes[other], visible: false }]),
      ),
    },
  })
  const back = await owner.render(
    isolate(red.id),
    { ...alphaOptions, transparent: true },
    false,
    'webgpu',
    false,
  )
  const front = await owner.render(
    isolate(blue.id),
    { ...alphaOptions, transparent: true },
    false,
    'webgpu',
    false,
  )
  const alphaPixels = await show(front, alphaOptions.view, back.gpuTile, true),
    alphaDifference = compare(alphaReference.bytes, alphaPixels)
  report.stages.push({
    name: 'isolated translucent boards vs linear scene',
    difference: alphaDifference,
  })
  publish()
  if (alphaDifference.max > 2)
    throw Error(`Isolated layer color mismatch ${JSON.stringify(alphaDifference)}`)
  const guardedOptions={...transient,width:768,height:512,view:{...options.view,x:options.view.x+256,y:options.view.y+160},
    interactionWindow:{x:256,y:160,w:256,h:192}}
  const cropGuarded=(bytes:Uint8Array)=>{
    const cropped=new Uint8Array(256*192*4)
    for(let y=0;y<192;y++)cropped.set(bytes.subarray(((y+160)*768+256)*4,((y+160)*768+512)*4),y*256*4)
    return cropped
  }
  const guardedReference=await owner.render(doc,{...guardedOptions,retainInteractionGraph:false},false,'webgpu',true)
  const guarded=await owner.render(doc,guardedOptions,false,'webgpu',true)
  const guardedDifference=compare(cropGuarded(guardedReference.bytes),cropGuarded(guarded.bytes))
  if(guardedDifference.max>2)throw Error(`Guarded surface crop mismatch ${JSON.stringify(guardedDifference)}`)
  report.stages.push({name:'guarded interaction preserves backdrop halo pixels',difference:guardedDifference})
  publish()
  // A protocol batch must survive a higher-priority document lane between
  // tiles with exactly the same pixels as independent requests.
  const tileOptions = {...options, view:{x:0,y:0,zoom}, width:256,height:256}
  const tilePlan = Array.from({length:4},(_,i)=>({key:`batch:${i}`,
    x:Math.floor(center.x*zoom)-128+(i%2)*128,y:Math.floor(center.y*zoom)-128+Math.floor(i/2)*128,
    width:128,height:128,zoom}))
  const tilePixels = (tile:TileResult) => tile.linear
    ? new Uint8Array(tile.linear.buffer,tile.linear.byteOffset,tile.linear.byteLength) : tile.bytes
  const sequential = new Map<string,Uint8Array>()
  for(const tile of tilePlan) await owner.render(doc,{...tileOptions,tileViewport:[tile]},false,'webgpu',true,false,
    {disableExactTileCache:true},result=>{sequential.set(result.key,tilePixels(result).slice());result.bitmap?.close()})
  const order:string[]=[]
  let interrupt:Promise<unknown>|undefined
  await owner.render(doc,{...tileOptions,tileViewport:tilePlan},false,'webgpu',true,false,{disableExactTileCache:true},result=>{
    order.push(result.key)
    if(!sameBytes(sequential.get(result.key)!,tilePixels(result)))throw Error('Interleaved batch changed tile pixels')
    result.bitmap?.close()
    if(!interrupt)interrupt=owner!.render(shifted,{...transient,width:128,height:128,retainInteractionGraph:false},false,'webgpu',false)
      .then(result=>{order.push('interaction');result.bitmap?.close();if(result.gpuTile)owner!.releasePresented([result.gpuTile])})
  })
  await interrupt
  if(order.indexOf('interaction')>order.indexOf('batch:3'))throw Error('Interaction waited behind the complete tile batch')
  // Cancellation preserves already delivered pixels and leaves both lanes
  // usable for the next camera/document request.
  let delivered=0
  try {
    await owner.render(doc,{...tileOptions,tileViewport:tilePlan},false,'webgpu',true,false,{disableExactTileCache:true},result=>{
      delivered++;result.bitmap?.close();owner!.cancelTileFill()
    })
    throw Error('Obsolete batch was not cancelled')
  } catch(error) { if(!String(error).includes('PREVIEW_CANCELLED'))throw error }
  if(delivered>=tilePlan.length)throw Error('Cancellation did not stop remaining tiles')
  await owner.render(doc,{...tileOptions,tileViewport:[tilePlan[3]]},false,'webgpu',true,false,{disableExactTileCache:true},result=>{
    if(!sameBytes(sequential.get(result.key)!,tilePixels(result)))throw Error('Cancelled batch corrupted the next request')
    result.bitmap?.close()
  })
  report.stages.push({name:'tile batch: pixel identity, lane preemption and camera cancellation',order,deliveredBeforeCancellation:delivered})
  publish()
  await owner.loseDeviceForTesting()
  const lostAt = performance.now()
  while (!last.error) {
    if (performance.now() - lostAt > 10000) throw Error('Lost display device was not reported')
    await frame()
  }
  report.stages.push({
    name: 'lost display device reports invalidated ownership',
    error: last.error,
  })
  report.status = 'passed'
  publish()
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  publish()
} finally {
  reference?.dispose()
}
