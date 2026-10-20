import { setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene, GpuPaint, Texture, Rect } from './types'
import { paint } from '../../model'

test('resident working admission depends on physical surfaces, not arithmetic simplification',async()=>{
  const scene={version:0,width:2000,height:1280,extent:{x:0,y:0,w:2000,h:1280},
    floatCompositing:true,coherentSamples:false} as unknown as GpuScene
  for(const displayMath of [false,true]){
    const renderer=new GpuRenderer({name:'webgpu',managed:true,captureDisplay:true,displayMath,scratchBytes:0} as Driver) as any
    // Invalid protocol stops before allocating a device resource, after the
    // real render entry has selected its working-surface admission.
    await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
    expect(renderer.frameBudget).toBe(512*1024*1024)
    await expect(renderer.renderAttempt({...scene,coherentSamples:true})).rejects.toThrow(/版本/)
    expect(renderer.frameBudget).toBe(256*1024*1024)
  }
})

test('completed node masks retire without releasing ancestor clips, and pressure waits before destruction',async()=>{
  let completed=false
  const destroyed:Texture[]=[]
  const driver={name:'webgpu',managed:true,captureDisplay:true,scratchBytes:0,
    checkpoint:vi.fn(async()=>{completed=true}),destroy(t:Texture){expect(completed).toBe(true);destroyed.push(t)}} as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.scene={interactionRetained:true};renderer.bytes=200*1024*1024
  const owned={width:1024,height:1024,bytes:16*1024*1024,resource:{}} as Texture
  const shared={...owned,resource:{}} as Texture
  const a={texture:owned,rect:{x:0,y:0,w:1024,h:1024}},b={texture:shared,rect:a.rect}
  renderer.busy.add(owned);renderer.busy.add(shared)
  renderer.masks.set('owned',a);renderer.masks.set('shared',b)
  renderer.maskOwners.set(owned,new Set(['node']));renderer.maskOwners.set(shared,new Set(['node','parent']))
  renderer.retireLeafMasks({id:'node',children:['finished-child']},[a,b],[b],[],true)
  expect(renderer.masks.has('owned')).toBe(true)
  renderer.bytes=240*1024*1024
  renderer.retireLeafMasks({id:'node',children:['finished-child']},[a,b],[b],[],true)
  expect(renderer.masks.has('owned')).toBe(false)
  expect(renderer.masks.has('shared')).toBe(true)
  expect(destroyed).toHaveLength(0)
  await renderer.reclaimScratch(128*1024*1024)
  expect(driver.checkpoint).toHaveBeenCalledTimes(1)
  expect(destroyed).toEqual([owned])
  expect(renderer.busy.has(shared)).toBe(true)
})

test('display scratch and retained pixels have separate bounded admission',()=>{
  const renderer=new GpuRenderer({name:'webgpu',managed:true,captureDisplay:true,scratchBytes:0} as Driver) as any
  renderer.bytes=300*1024*1024;renderer.interactionBytes=128*1024*1024
  expect(renderer.workingBytes).toBe(172*1024*1024)
  expect(renderer.overBudget(60*1024*1024)).toBe(false)
  expect(renderer.overBudget(100*1024*1024)).toBe(true)
})

test('fractional regional blending preserves destination lattice and avoids texture feedback',()=>{
  const passes:{target:Texture;inputs:Texture[];region?:Rect}[]=[]
  const driver={name:'webgpu',managed:true,displayMath:true,scratchBytes:0,
    create(w:number,h:number){expect(Number.isInteger(w)&&Number.isInteger(h)).toBe(true);return {width:w,height:h,bytes:w*h*16,resource:{}}},
    pass(target:Texture,_u:Float32Array,inputs:Texture[],region?:Rect){expect(inputs).not.toContain(target);passes.push({target,inputs,region})},
  } as unknown as Driver
  const renderer=new GpuRenderer(driver) as any
  renderer.scene={interactionRetained:true,coherentSamples:false,integratedBlur:true}
  const src={rect:{x:10.25,y:10.5,w:8,h:8},texture:{width:8,height:8,bytes:1024,resource:{}}}
  const dst={rect:{x:.25,y:.25,w:128,h:128},texture:{width:128,height:128,bytes:128*128*16,resource:{}}}
  expect(renderer.merge(src,dst,'multiply',.8)).toBe(dst)
  expect(passes).toHaveLength(2)
  expect(passes[1].target).toBe(dst.texture)
  expect(passes[1].region).toEqual({x:9,y:9,w:10,h:11})
  renderer.aliases.set(dst.texture,2)
  expect(renderer.merge(src,dst,'multiply',.8)).not.toBe(dst)
})

test('transient neutral-group fusion preserves cache, clip, mask, and backdrop boundaries',async()=>{
  const renderer=new GpuRenderer({name:'webgpu',managed:true,displayMath:true,scratchBytes:0} as Driver) as any
  const side=Math.ceil(Math.sqrt(renderer.interactionBudget/16))+1
  const group={id:'group',rect:{x:0,y:0,w:side,h:side},opacity:1,blend:'normal',children:['child'],fills:[],strokes:[],effects:[]}
  const child={id:'child',blend:'normal',effects:[]}
  renderer.scene={coherentSamples:false,interactionRetained:true,nodes:{group,child}}
  renderer.drawList=vi.fn(async(_ids,target)=>target);renderer.nodeSource=vi.fn(async()=>undefined)
  const target={rect:{x:0,y:0,w:side,h:side},texture:{}}
  await renderer.drawNode('group',target)
  expect(renderer.drawList).toHaveBeenCalledTimes(1)
  for(const patch of [{mask:true},{blend:'multiply'},{passthrough:true},{effects:[{kind:'background-blur',visible:true,radius:18}]}]){
    renderer.drawList.mockClear();renderer.scene.nodes.child={...child,...patch}
    await renderer.drawNode('group',target);expect(renderer.drawList).not.toHaveBeenCalled()
  }
  renderer.scene.nodes.child=child;renderer.drawList.mockClear()
  await renderer.drawNode('group',target,target);expect(renderer.drawList).not.toHaveBeenCalled()
  renderer.interactionRoots.set(group,{source:true,planes:[]});await renderer.drawNode('group',target)
  expect(renderer.drawList).not.toHaveBeenCalled()
  renderer.interactionRoots.clear();renderer.scene.coherentSamples=true
  await renderer.drawNode('group',target);expect(renderer.drawList).not.toHaveBeenCalled()
})

test('viewport resize reclaims old GPU surfaces without destroying in-flight resources', async () => {
  const live = new Set<Texture>(),
    referenced = new Set<Texture>()
  let bytes = 0,
    peak = 0,
    evicted = 0
  const driver: Driver = {
    name: 'webgl2',
    canvas: {} as OffscreenCanvas,
    description: 'resource-lifetime verifier',
    lost: false,
    drawCalls: 0,
    triangles: 0,
    begin() {
      referenced.clear()
    },
    create(width, height) {
      const t: Texture = { width, height, resource: {} as WebGLTexture, bytes: width * height * 4 }
      live.add(t)
      bytes += t.bytes
      peak = Math.max(peak, bytes)
      return t
    },
    destroy(t) {
      expect(referenced.has(t)).toBe(false)
      expect(live.delete(t)).toBe(true)
      bytes -= t.bytes
      evicted++
    },
    upload() {
      throw new Error('No image in this test')
    },
    clear(t) {
      expect(live.has(t)).toBe(true)
      referenced.add(t)
    },
    mask(_path, t) {
      this.clear(t)
    },
    pass(target, _uniforms, inputs) {
      expect(inputs).not.toContain(target)
      for (const t of [target, ...inputs]) {
        expect(live.has(t)).toBe(true)
        referenced.add(t)
      }
    },
    over(target, uniforms, inputs) {
      this.pass(target, uniforms, inputs)
    },
    async finish() {
      referenced.clear()
      return {}
    },
    dispose() {
      for (const t of [...live]) this.destroy(t)
    },
    async loseDeviceForTesting() {
      throw new Error('No real device')
    },
  }
  const renderer = new GpuRenderer(driver)
  const scene = (width: number): GpuScene => {
    const r = { x: 0, y: 0, w: width, h: 2048 },
      matrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]
    return {
      version: 7,
      width,
      height: 2048,
      extent: r,
      background: '#ffffff',
      transparent: false,
      grid: false,
      view: { x: 0, y: 0, zoom: 1 },
      roots: ['n'],
      vertices: [0, 0, width, 0, width, 2048],
      nodes: {
        n: {
          id: 'n',
          rect: r,
          matrix,
          inverse: matrix,
          size: [width, 2048],
          fill: { rect: r, first: 0, count: 3, rule: 'evenodd' },
          fills: [paint('#ff0000'), { ...paint('#00ff00'), opacity: 0.5, blend: 'multiply' }],
          strokes: [],
          children: [],
          mask: false,
          clip: false,
          opacity: 1,
          blend: 'normal',
          effects: [],
        },
      },
    }
  }
  await expect(
    renderer.render({ ...scene(4096), version: 3 } as unknown as GpuScene),
  ).rejects.toThrow('GPU 命令版本')
  await renderer.render(scene(4096))
  await renderer.render(scene(4000))
  expect(evicted).toBeGreaterThan(0)
  expect(peak).toBeLessThanOrEqual(256 * 1024 * 1024)
  renderer.dispose()
  expect(bytes).toBe(0)
})

test('glass capture replays each jitter and tile with local scissors and retained parameter uploads', async () => {
  const live = new Set<Texture>(),
    parameters = new Set<Texture>()
  const passes: {
    mode: number
    target: Texture
    inputs: Texture[]
    region?: Rect
    u: Float32Array
  }[] = []
  let finished = false
  const driver: Driver = {
    name: 'webgpu',
    canvas: {} as OffscreenCanvas,
    description: 'capture command and lifetime verifier',
    lost: false,
    drawCalls: 0,
    triangles: 0,
    begin() {},
    create(width, height) {
      const texture: Texture = {
        width,
        height,
        resource: {} as GPUTexture,
        bytes: width * height * 4,
      }
      live.add(texture)
      return texture
    },
    destroy(texture) {
      if (parameters.has(texture)) expect(finished).toBe(true)
      expect(live.delete(texture)).toBe(true)
    },
    upload() {
      throw new Error('Capture must replay geometry, not uploaded colour pixels')
    },
    uploadParameters(values, width, height) {
      expect(values.length).toBe(width * height * 4)
      const texture = this.create(width, height)
      texture.bytes = width * height * 16
      parameters.add(texture)
      return texture
    },
    clear(texture) {
      expect(live.has(texture)).toBe(true)
      expect(parameters.has(texture)).toBe(false)
    },
    mask(_path, texture) {
      this.clear(texture)
    },
    pass(target, u, inputs, region) {
      expect(inputs).not.toContain(target)
      expect(parameters.has(target)).toBe(false)
      for (const texture of [target, ...inputs]) expect(live.has(texture)).toBe(true)
      if (region) {
        expect(region.x).toBeGreaterThanOrEqual(0)
        expect(region.y).toBeGreaterThanOrEqual(0)
        expect(region.x + region.w).toBeLessThanOrEqual(target.width)
        expect(region.y + region.h).toBeLessThanOrEqual(target.height)
      }
      passes.push({ mode: u[16], target, inputs: [...inputs], region, u: u.slice() })
    },
    over(target, u, inputs, region) {
      this.pass(target, u, inputs, region)
    },
    async finish() {
      expect(parameters.size).toBe(4)
      for (const texture of parameters) expect(live.has(texture)).toBe(true)
      finished = true
      return {}
    },
    dispose() {
      for (const texture of [...live]) this.destroy(texture)
    },
    async loseDeviceForTesting() {
      throw new Error('No real device')
    },
  }
  const r = { x: 488, y: 72, w: 80, h: 80 },
    lens = { x: 496, y: 80, w: 64, h: 64 }
  const scene: GpuScene = {
    version: 7,
    width: 640,
    height: 192,
    extent: { x: 0, y: 0, w: 640, h: 192 },
    background: '#000000',
    transparent: false,
    grid: false,
    view: { x: 0, y: 0, zoom: 1 },
    roots: ['glass'],
    vertices: [],
    coherentSamples: true,
    integratedBlur: true,
    nodes: {
      glass: {
        id: 'glass',
        rect: r,
        matrix: [1, 0, 0, 1, 496, 80],
        inverse: [1, 0, 0, 1, -496, -80],
        size: [64, 64],
        glassShape: { size: [64, 64], radius: 8 },
        fill: { rect: r, first: 0, count: 0, rule: 'nonzero' },
        fills: [],
        strokes: [],
        children: [],
        mask: false,
        clip: false,
        opacity: 1,
        blend: 'normal',
        effects: [
          {
            id: 'fx',
            kind: 'glass',
            visible: true,
            radius: 1.5,
            x: 0,
            y: 0,
            spread: 0,
            color: '#ffffff',
            opacity: 1,
            amount: 0,
            glass: { depth: 8, refraction: 0, dispersion: 0, lightAngle: 45, lightIntensity: 0 },
          },
        ],
        captureReplay: {
          parentMatrix: [1, 0, 0, 1, 0, 0],
          parentWorldTransform: [1, 0, 0, 1, 0, 0],
          cameraMatrix: [1, 0, 0, 1, 0, 0],
          parentSize: [640, 192],
          lensRect: lens,
          lensBounds: [lens.x, lens.y, lens.x + lens.w, lens.y + lens.h],
          effectiveFrost: 1.5,
          support: 1.5,
          side: 512,
          primitives: [
            { transform: [1, 0, 0, 1, 0, 0], size: [640, 192], color: [0, 0, 0, 1] },
            { transform: [1, 0, 0, 1, 511, 64], size: [1, 96], color: [1, 1, 1, 1] },
          ],
        },
      },
    },
  }
  const renderer = new GpuRenderer(driver)
  await renderer.render(scene)
  const optical = passes.filter((pass) => pass.mode === 34)
  expect(optical).toHaveLength(8)
  expect(optical.map((pass) => pass.region)).toEqual(
    Array.from({ length: 4 }, () => [
      { x: 8, y: 8, w: 16, h: 64 },
      { x: 24, y: 8, w: 48, h: 64 },
    ]).flat(),
  )
  expect(optical.map((pass) => Array.from(pass.u.slice(48, 51)))).toEqual(
    Array.from({ length: 4 }, () => [
      [1, 0, 0],
      [1, 512, 0],
    ]).flat(),
  )
  for (const pass of optical) {
    expect(parameters.has(pass.inputs[1])).toBe(true)
    expect(pass.inputs[0].width).toBe(512)
    expect(pass.inputs[0].height).toBe(512)
    expect(Array.from(pass.u.slice(44, 48))).toEqual([0, 0, 3, 8])
  }
  expect(passes.filter((pass) => pass.mode === 40)).toHaveLength(8)
  expect(passes.filter((pass) => pass.mode === 41).map((pass) => [pass.u[37], pass.u[38]])).toEqual(
    Array.from({ length: 8 }, () => [
      [0, 64],
      [1, 64],
    ]).flat(),
  )
  expect(passes.filter((pass) => pass.mode === 12 && pass.region).length).toBeGreaterThanOrEqual(8)
  expect(passes.some((pass) => pass.mode === 26 || pass.mode === 22)).toBe(false)
  // Immutable parameter textures remain resident, never become writable color targets.
  for (const texture of parameters) expect(live.has(texture)).toBe(true)
  const repeated = await renderer.render(scene)
  expect(repeated.materialFieldHits).toBe(4)
  expect(repeated.materialFieldBuilds).toBe(0)
  expect(repeated.materialFieldUploadBytes).toBe(0)
  renderer.dispose()
  expect(live.size).toBe(0)
})

test('measured gradients retain exact lookups and jitter fields across completed frames', async () => {
  const live = new Set<Texture>(),
    uploads = new Set<Texture>()
  const passes: { u: Float32Array; inputs: Texture[] }[] = []
  let completed = false,
    lookups = 0,
    fields = 0
  const driver: Driver = {
    name: 'webgl2',
    canvas: {} as OffscreenCanvas,
    description: 'gradient upload verifier',
    lost: false,
    drawCalls: 0,
    triangles: 0,
    begin() {
      completed = false
    },
    create(width, height) {
      const t: Texture = { width, height, resource: {} as WebGLTexture, bytes: width * height * 4 }
      live.add(t)
      return t
    },
    destroy(t) {
      if (uploads.has(t)) expect(completed).toBe(true)
      expect(live.delete(t)).toBe(true)
    },
    upload() {
      throw new Error('No bitmap upload')
    },
    uploadRgba8(bytes, width, height) {
      expect([width, height, bytes.length]).toEqual([1024, 2, 8192])
      lookups++
      const t = this.create(width, height)
      uploads.add(t)
      return t
    },
    uploadParameters(values, width, height) {
      expect([width, height, values.length]).toEqual([16, 16, 16 * 16 * 4])
      fields++
      const t = this.create(width, height)
      t.bytes = width * height * 16
      uploads.add(t)
      return t
    },
    clear(t) {
      expect(uploads.has(t)).toBe(false)
    },
    mask(_path, t) {
      this.clear(t)
    },
    pass(target, u, inputs) {
      expect(inputs).not.toContain(target)
      expect(uploads.has(target)).toBe(false)
      for (const t of [target, ...inputs]) expect(live.has(t)).toBe(true)
      passes.push({ u: u.slice(), inputs: [...inputs] })
    },
    over(target, u, inputs) {
      this.pass(target, u, inputs)
    },
    async finish() {
      expect([...uploads].filter((t) => live.has(t))).toHaveLength(5)
      completed = true
      return {}
    },
    dispose() {
      for (const t of [...live]) this.destroy(t)
    },
    async loseDeviceForTesting() {
      throw new Error('No real device')
    },
  }
  const gradient: GpuPaint = {
    ...paint('#000000', 'linear'),
    angle: 0,
    figmaGradient: true,
    stops: [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' },
    ],
  }
  const constant: GpuPaint = {
    ...gradient,
    constantColor: '#ddeeff',
    stops: [
      { offset: 0, color: '#ddeeff' },
      { offset: 1, color: '#ddeeff' },
    ],
  }
  const r = { x: 13, y: 7, w: 16, h: 16 }
  const scene: GpuScene = {
    version: 7,
    width: 32,
    height: 32,
    extent: { x: 0, y: 0, w: 32, h: 32 },
    background: '#000000',
    transparent: false,
    grid: false,
    view: { x: 0, y: 0, zoom: 1 },
    coherentSamples: true,
    integratedBlur: true,
    roots: ['gradient'],
    vertices: [],
    nodes: {
      gradient: {
        id: 'gradient',
        rect: r,
        matrix: [1, 0, 0, 1, 13, 7],
        inverse: [1, 0, 0, 1, -13, -7],
        size: [16, 16],
        fill: { rect: r, first: 0, count: 0, rule: 'nonzero' },
        fills: [constant, gradient],
        strokes: [],
        children: [],
        effects: [],
        mask: false,
        clip: true,
        opacity: 1,
        blend: 'normal',
      },
    },
  }
  const renderer = new GpuRenderer(driver)
  await renderer.render(scene)
  expect([lookups, fields]).toEqual([1, 4])
  const first = passes.filter(({ u }) => u[16] === 42)
  expect(first).toHaveLength(4)
  expect(new Set(first.map(({ inputs }) => inputs[2])).size).toBe(1)
  expect(new Set(first.map(({ inputs }) => inputs[3])).size).toBe(4)
  for (const { u } of first) {
    expect(Array.from(u.slice(52, 56))).toEqual([13, 7, 16, 16])
    expect(u[32]).toBe(1)
  }
  expect(passes.filter(({ u }) => u[16] === 35)).toHaveLength(4)
  const reused = await renderer.render(scene)
  expect([lookups, fields]).toEqual([1, 4])
  expect(reused.materialFieldHits).toBe(5)
  expect(reused.materialFieldUploadBytes).toBe(0)
  for (const t of uploads) expect(live.has(t)).toBe(true)
  renderer.dispose()
  expect(live.size).toBe(0)
})

type RecordedTexturePass = {
  mode: number
  target: Texture
  inputs: Texture[]
  region?: Rect
  uniforms: Float32Array
  over: boolean
}

function textureReplayDriver(failUploadAt = Infinity, reusable = false) {
  const live = new Set<Texture>()
  const metadata = new Set<Texture>()
  const masks = new Set<Texture>()
  const passes: RecordedTexturePass[] = []
  const uploads: { width: number; height: number; parameters: boolean }[] = []
  let finished = false
  let aborted = false
  let parameterUploads = 0
  let replayAllocations = 0
  let bytes = 0
  let peak = 0
  const allocate = (width: number, height: number, channels: number): Texture => {
    const texture = { width, height, bytes: width * height * channels, resource: {} as GPUTexture }
    live.add(texture)
    bytes += texture.bytes
    peak = Math.max(peak, bytes)
    return texture
  }
  const record = (
    target: Texture,
    u: Float32Array,
    inputs: Texture[],
    region: Rect | undefined,
    over: boolean,
  ) => {
    expect(metadata.has(target)).toBe(false)
    expect(inputs).not.toContain(target)
    for (const texture of [target, ...inputs]) expect(live.has(texture)).toBe(true)
    if (region) {
      expect(region.x).toBeGreaterThanOrEqual(0)
      expect(region.y).toBeGreaterThanOrEqual(0)
      expect(region.x + region.w).toBeLessThanOrEqual(target.width)
      expect(region.y + region.h).toBeLessThanOrEqual(target.height)
    }
    passes.push({ mode: u[16], target, inputs: [...inputs], region, uniforms: u.slice(), over })
  }
  const driver: Driver = {
    name: 'webgpu',
    canvas: {} as OffscreenCanvas,
    description: 'texture replay graph verifier',
    lost: false,
    drawCalls: 0,
    triangles: 0,
    begin() {
      finished = false
      aborted = false
    },
    create(width, height) {
      return allocate(width, height, 4)
    },
    destroy(texture) {
      if (metadata.has(texture)) expect(finished || aborted).toBe(true)
      expect(live.delete(texture)).toBe(true)
      bytes -= texture.bytes
    },
    upload() {
      throw new Error('Texture sources must be painted by the GPU')
    },
    uploadParameters(values, width, height) {
      expect(values.length).toBe(width * height * 4)
      if (++parameterUploads === failUploadAt) {
        aborted = true
        throw new Error('injected parameter upload failure')
      }
      const texture = allocate(width, height, 16)
      metadata.add(texture)
      uploads.push({ width, height, parameters: true })
      return texture
    },
    uploadRgba8(values, width, height) {
      expect(width).toBe(1024)
      expect([2, 1024]).toContain(height)
      expect(values.length).toBe(width * height * 4)
      const texture = allocate(width, height, 4)
      metadata.add(texture)
      uploads.push({ width, height, parameters: false })
      return texture
    },
    clear(texture) {
      expect(live.has(texture)).toBe(true)
      expect(metadata.has(texture)).toBe(false)
    },
    mask(_path, texture) {
      masks.add(texture)
      this.clear(texture)
    },
    pass(target, u, inputs, region) {
      record(target, u, inputs, region, false)
    },
    over(target, u, inputs, region) {
      record(target, u, inputs, region, true)
    },
    async finish() {
      finished = true
      return {}
    },
    dispose() {
      for (const texture of [...live]) this.destroy(texture)
    },
    async loseDeviceForTesting() {
      throw new Error('No real device')
    },
  }
  if (reusable) {
    driver.uploadReplayParameters = (values, width, height, target) => {
      expect(values.length).toBe(width * height * 4)
      if (++parameterUploads === failUploadAt) {
        aborted = true
        throw new Error('injected parameter upload failure')
      }
      if (target) {
        expect(metadata.has(target)).toBe(true)
        expect(live.has(target)).toBe(true)
      } else {
        target = allocate(1024, 1024, 16)
        metadata.add(target)
        replayAllocations++
      }
      uploads.push({ width, height, parameters: true })
      return target
    }
  }
  return {
    driver,
    live,
    metadata,
    masks,
    passes,
    uploads,
    peak: () => peak,
    replayAllocations: () => replayAllocations,
  }
}

function textureReplayScene(radius = 2, clipped = false): GpuScene {
  const parent = { x: 0, y: 0, w: 640, h: 320 }
  const leaf = { x: 456, y: 36, w: 148, h: 162 }
  const gradient: GpuPaint = {
    ...paint('#26568a', 'linear'),
    angle: 45,
    figmaGradient: true,
    stops: [
      { offset: 0, color: '#26568a' },
      { offset: 1, color: '#b28b31' },
    ],
  }
  return {
    version: 7,
    width: parent.w,
    height: parent.h,
    extent: parent,
    background: '#ffffff',
    transparent: false,
    grid: false,
    view: { x: 120, y: 80, zoom: 2 },
    coherentSamples: true,
    integratedBlur: true,
    roots: ['frame'],
    vertices: [0, 0, 640, 0, 640, 320, 0, 0, 640, 320, 0, 320],
    nodes: {
      frame: {
        id: 'frame',
        rect: parent,
        matrix: [2, 0, 0, 2, 0, 0],
        inverse: [0.5, 0, 0, 0.5, 0, 0],
        size: [320, 160],
        fill: { rect: parent, first: 0, count: 6, rule: 'nonzero' },
        fills: [paint('#ffffff')],
        strokes: [],
        children: ['leaf'],
        mask: false,
        clip: true,
        opacity: 1,
        blend: 'normal',
        effects: [],
      },
      leaf: {
        id: 'leaf',
        rect: leaf,
        matrix: [2, 0, 0, 2, 460, 40],
        inverse: [0.5, 0, 0, 0.5, -230, -20],
        size: [70, 77],
        fill: { rect: leaf, first: 0, count: 0, rule: 'nonzero' },
        fills: [gradient],
        strokes: [],
        children: [],
        mask: false,
        clip: false,
        opacity: 1,
        blend: 'normal',
        effects: [
          {
            id: 'texture',
            kind: 'texture',
            visible: true,
            radius,
            x: 0,
            y: 0,
            spread: 0,
            color: '#000000',
            opacity: 1,
            amount: 0,
            texture: { noiseSize: [5, 11], clipToShape: clipped },
          },
        ],
        textureReplay: {
          parentMatrix: [2, 0, 0, 2, 0, 0],
          parentWorldTransform: [1, 0, 0, 1, 120, 80],
          cameraMatrix: [2, 0, 0, 2, -240, -160],
          parentSize: [320, 160],
          nodeTransform: [1, 0, 0, 1, 230, 20],
          nodeSize: [70, 77],
          paint: gradient,
          radius,
          noiseSize: [5, 11],
          clipped,
        },
      },
    },
  }
}

for (const { radius, clipped, original } of [
  { radius: 2, clipped: false, original: false },
  { radius: 180, clipped: true, original: true },
]) {
  test(`texture replay paints independent sources and directly blends canonical tiles (original=${original})`, async () => {
    const mock = textureReplayDriver()
    const renderer = new GpuRenderer(mock.driver)
    await renderer.render(textureReplayScene(radius, clipped))
    const effects = mock.passes.filter((p) => p.mode === 43)
    const copybacks = mock.passes.filter((p) => p.mode === 44)
    expect(effects).toHaveLength(8)
    expect(copybacks).toHaveLength(8)
    expect(mock.masks.size).toBe(4) // The root clips survive; no leaf mask is rasterized.
    for (const pass of effects) {
      expect(pass.target.width).toBe(1024)
      expect(pass.target.height).toBe(1024)
      expect(pass.inputs).toHaveLength(4)
      expect(pass.inputs[0].width).toBe(1024)
      expect(pass.inputs[1].width).toBe(original ? 512 : 1024)
      expect(pass.uniforms[37]).toBe(clipped ? 1 : 0)
      expect(pass.uniforms[38]).toBe(original ? 1 : 0)
      expect(mock.metadata.has(pass.inputs[2])).toBe(true)
      expect(pass.inputs[3].width).toBe(1024)
      expect(pass.inputs[3].height).toBe(1024)
    }
    for (const pass of copybacks) {
      expect(pass.over).toBe(true)
      expect(pass.target.width).toBe(640)
      expect(pass.target.height).toBe(320)
      expect(pass.inputs[0].width).toBe(1024)
      expect(pass.inputs).toHaveLength(3)
      expect(mock.metadata.has(pass.inputs[1])).toBe(true)
      expect(mock.masks.has(pass.inputs[2])).toBe(true)
      expect(pass.uniforms[19]).toBe(1)
      expect(pass.region!.x < 512 ? pass.region!.x + pass.region!.w : pass.region!.x).toBe(512)
    }
    expect(mock.passes.filter((p) => p.mode === 45)).toHaveLength(original ? 16 : 8)
    expect(mock.passes.some((p) => p.mode === 8)).toBe(false)
    expect(mock.uploads.filter((u) => !u.parameters && u.height === 2)).toHaveLength(1)
    expect(mock.uploads.filter((u) => !u.parameters && u.height === 1024)).toHaveLength(1)
    for (const texture of mock.metadata) expect(mock.live.has(texture)).toBe(false)
    renderer.dispose()
    expect(mock.live.size).toBe(0)
  })
}

test('texture passthrough skips texture processing while unsupported replay keeps the old effect', async () => {
  const pass = textureReplayDriver()
  const ordinary = new GpuRenderer(pass.driver)
  await ordinary.render(textureReplayScene(0.01, true))
  expect(pass.passes.some((p) => [8, 43, 44, 45].includes(p.mode))).toBe(false)
  expect(pass.passes.some((p) => p.mode === 42)).toBe(true)
  ordinary.dispose()
  const unsupported = textureReplayScene(2, true)
  unsupported.nodes.leaf.textureReplay!.nodeSize = [0.01, 0.01]
  unsupported.nodes.leaf.size = [0.01, 0.01]
  unsupported.nodes.leaf.rect = { x: 456, y: 36, w: 9, h: 9 }
  unsupported.nodes.leaf.fill.rect = unsupported.nodes.leaf.rect
  const fallback = textureReplayDriver()
  const renderer = new GpuRenderer(fallback.driver)
  await renderer.render(unsupported)
  expect(fallback.passes.some((p) => [43, 44, 45].includes(p.mode))).toBe(false)
  expect(fallback.passes.some((p) => p.mode === 8)).toBe(true)
  renderer.dispose()
  expect(fallback.live.size).toBe(0)
})

test('texture metadata upload errors release retained inputs without retrying or fallback', async () => {
  const mock = textureReplayDriver(3, true)
  const renderer = new GpuRenderer(mock.driver)
  await expect(renderer.render(textureReplayScene())).rejects.toThrow(
    'injected parameter upload failure',
  )
  expect(mock.passes.some((p) => p.mode === 8)).toBe(false)
  for (const texture of mock.metadata) expect(mock.live.has(texture)).toBe(false)
  renderer.dispose()
  expect(mock.live.size).toBe(0)
})

test('texture replay keeps a single budgeted metadata allocation across four tiles and AA', async () => {
  const scene = textureReplayScene(0.25, true)
  const extent = { x: 0, y: 0, w: 1024, h: 1024 }
  scene.width = scene.height = 1024
  scene.extent = extent
  scene.vertices = [0, 0, 1024, 0, 1024, 1024, 0, 0, 1024, 1024, 0, 1024]
  Object.assign(scene.nodes.frame, {
    rect: extent,
    matrix: [8, 0, 0, 8, 0, 0],
    inverse: [0.125, 0, 0, 0.125, 0, 0],
    size: [128, 128],
  })
  scene.nodes.frame.fill.rect = extent
  Object.assign(scene.nodes.leaf, {
    rect: { x: 472, y: 472, w: 80, h: 80 },
    matrix: [8, 0, 0, 8, 480, 480],
    inverse: [0.125, 0, 0, 0.125, -60, -60],
    size: [8, 8],
  })
  scene.nodes.leaf.fill.rect = scene.nodes.leaf.rect
  Object.assign(scene.nodes.leaf.textureReplay!, {
    parentMatrix: [8, 0, 0, 8, 0, 0],
    cameraMatrix: [8, 0, 0, 8, -960, -640],
    parentSize: [128, 128],
    nodeTransform: [1, 0, 0, 1, 60, 60],
    nodeSize: [8, 8],
  })
  const mock = textureReplayDriver(Infinity, true)
  const renderer = new GpuRenderer(mock.driver)
  await renderer.render(scene)
  expect(mock.passes.filter((p) => p.mode === 43)).toHaveLength(16)
  expect(mock.passes.filter((p) => p.mode === 44)).toHaveLength(16)
  expect(mock.replayAllocations()).toBe(1)
  expect(mock.peak()).toBeLessThan(256 * 1024 * 1024)
  renderer.dispose()
  expect(mock.live.size).toBe(0)
})

test('command v5 cannot silently omit texture replay', async () => {
  const mock = textureReplayDriver()
  const renderer = new GpuRenderer(mock.driver)
  await expect(
    renderer.render({ ...textureReplayScene(), version: 6 } as unknown as GpuScene),
  ).rejects.toThrow('GPU 命令版本')
  expect(mock.live.size).toBe(0)
  renderer.dispose()
})

// Image admission/atlas lifetime regressions run through the shared real-renderer
// cases in __tests__/gpu-mipmap-fallback.test.ts and the standalone Node runner.


test('external failed-frame recovery reconciles retired driver scratch with the renderer ledger', async () => {
  const driver = { name: 'webgpu', managed: true, scratchBytes: 128,
    async abortFrameAndReleaseFilterScratch(this: { scratchBytes: number }) { this.scratchBytes = 0 } } as unknown as Driver
  const renderer = new GpuRenderer(driver) as any
  renderer.bytes += 64 // Valid resident textures remain accounted and alive.
  await renderer.abortFrameAndReleaseFilterScratch()
  expect(renderer.bytes).toBe(64)
})

test('external abort failure still reconciles partially retired scratch exactly once', async () => {
  const driver = { name: 'webgpu', managed: true, scratchBytes: 128,
    async abortFrameAndReleaseFilterScratch(this: { scratchBytes: number }) { this.scratchBytes = 32; throw Error('submit failed') } } as unknown as Driver
  const renderer = new GpuRenderer(driver) as any
  renderer.bytes += 64
  await expect(renderer.abortFrameAndReleaseFilterScratch()).rejects.toThrow('submit failed')
  expect(renderer.bytes).toBe(96)
})


test.each([NaN, Infinity, -Infinity, .5, Number.MAX_SAFE_INTEGER + 1])('invalid surface dimension %s is rejected before GPU allocation or eviction', width => {
  const create = vi.fn(), destroy = vi.fn()
  const renderer = new GpuRenderer({ managed: true, create, destroy } as unknown as Driver) as any
  expect(() => renderer.acquire({ x: 0, y: 0, w: width, h: 2 })).toThrow()
  expect(create).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled()
  expect(renderer.bytes).toBe(0)
})

test('unsafe surface products, non-finite origins, and invalid byte admissions cannot poison the ledger', () => {
  const create = vi.fn(), renderer = new GpuRenderer({ managed: true, create } as unknown as Driver) as any
  expect(() => renderer.acquire({ x: 0, y: 0, w: 2 ** 28, h: 2 ** 28 })).toThrow(/字节数/)
  expect(() => renderer.acquire({ x: NaN, y: 0, w: 1, h: 1 })).toThrow(/边界/)
  for (const bytes of [NaN, Infinity, -.1, .5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => renderer.overBudget(bytes)).toThrow(/字节数/)
  expect(renderer.overBudget(0)).toBe(false)
  expect(renderer.bytes).toBe(0); expect(create).not.toHaveBeenCalled()
})


test('admission diagnostics classify proactive and required pressure without early destruction', async () => {
  const MiB = 1024 * 1024
  for (const required of [0, 64 * MiB]) {
    let finish!: () => void, metadata: any, completed = false
    const destroyed: Texture[] = []
    const driver = { name: 'webgpu', managed: true, scratchBytes: 0,
      checkpoint: vi.fn(async (_reason: unknown, fields: unknown) => { metadata = fields; await new Promise<void>(resolve => { finish = resolve }); completed = true }),
      destroy(texture: Texture) { expect(completed).toBe(true); destroyed.push(texture) },
    } as unknown as Driver
    const renderer = new GpuRenderer(driver) as any
    renderer.scene = {}; renderer.bytes = 220 * MiB
    const texture = { width: 256, height: 256, bytes: MiB, resource: {} } as Texture
    renderer.free.set('256:256', [texture])
    setGpuDiagnosticSink(() => {})
    try {
      const pending = renderer.reclaimScratch(required)
      expect(metadata).toEqual({ admissionKind: required ? 1 : 0, admissionPressure: required ? 1 : 0,
        admissionRequiredBytes: required, admissionWorkingBytes: 220 * MiB, admissionBudgetBytes: 256 * MiB,
        admissionReclaimableBytes: MiB, admissionPoolBytes: MiB, admissionPoolCount: 1,
        admissionUploadCount: 0, admissionImageCount: 0, admissionRetiredKinds: 1, admissionRetiredUploadCount: 0, admissionCoordinateCount: 0 })
      expect(destroyed).toEqual([]); expect(renderer.bytes).toBe(220 * MiB)
      finish(); await pending
      expect(destroyed).toEqual([texture]); expect(renderer.bytes).toBe(219 * MiB)
    } finally { setGpuDiagnosticSink(undefined) }
  }
})

test('disabled admission diagnostics preserve the same fence with no metadata payload', async () => {
  const driver = { name: 'webgpu', managed: true, scratchBytes: 0, checkpoint: vi.fn(async () => {}), destroy() {} } as unknown as Driver
  const renderer = new GpuRenderer(driver) as any
  renderer.scene = {}; renderer.bytes = 220 * 1024 * 1024
  const texture = { width: 256, height: 256, bytes: 1024 * 1024, resource: {} } as Texture
  renderer.free.set('256:256', [texture])
  setGpuDiagnosticSink(undefined)
  await renderer.reclaimScratch()
  expect(driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
})

function completedPoolFixture() {
  const MiB=1024*1024
  const driver={name:'webgpu',managed:true,scratchBytes:0,resourceEpoch:1,completedResourceEpoch:1,
    checkpoint:vi.fn(async()=>{}),destroy:vi.fn()}
  const renderer=new GpuRenderer(driver as unknown as Driver) as any;renderer.scene={};renderer.bytes=96*MiB
  const texture={width:1536,height:2048,bytes:48*MiB,resource:{}} as Texture
  renderer.busy.add(texture);renderer.release({texture,rect:{x:0,y:0,w:1536,h:2048}})
  driver.resourceEpoch=2
  return {driver,renderer,texture,MiB}
}
test('old pool-only maintenance carries a completed prior-frame proof',async()=>{
  const {driver,renderer,texture}=completedPoolFixture()
  await renderer.reclaimScratch()
  expect(driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission',undefined,1)
  expect(driver.destroy).toHaveBeenCalledWith(texture)
})
test('unknown, current, incomplete, upload and image-pressure batches preserve the fence',async()=>{
  for(const change of ['unknown','zero','current','incomplete','coordinates','retired','pressure','required']){
    const {driver,renderer,texture,MiB}=completedPoolFixture()
    if(change==='unknown')renderer.poolReleaseEpoch.delete(texture)
    if(change==='zero')renderer.poolReleaseEpoch.set(texture,0)
    if(change==='current')renderer.poolReleaseEpoch.set(texture,2)
    if(change==='incomplete')driver.completedResourceEpoch=0
    if(change==='coordinates')renderer.coordinateMaps.add({width:1,height:1,bytes:16,resource:{}})
    if(change==='retired')renderer.retiredUploads.push({width:1,height:1,bytes:16,resource:{}})
    if(change==='pressure')renderer.bytes=200*MiB
    await renderer.reclaimScratch(change==='required'?1:0)
    expect((driver.checkpoint as any).mock.calls[0]).toHaveLength(2)
  }
})
test('reacquiring and returning an old texture replaces its pool completion proof',async()=>{
  const {driver,renderer,texture}=completedPoolFixture()
  const surface=renderer.acquire({x:0,y:0,w:1536,h:2048})
  expect(surface.texture).toBe(texture);expect(renderer.poolReleaseEpoch.has(texture)).toBe(false);renderer.release(surface)
  await renderer.reclaimScratch()
  expect((driver.checkpoint as any).mock.calls[0]).toHaveLength(2)
})
test('pool proof covers exactly the64-resource batch, not younger survivors',async()=>{
  const {driver,renderer,MiB}=completedPoolFixture();renderer.free.clear();renderer.bytes=120*MiB
  driver.resourceEpoch=1
  const old:Texture[]=[]
  for(let i=0;i<64;i++){const texture={width:128,height:256,bytes:MiB/2,resource:{}} as Texture;old.push(texture);renderer.busy.add(texture);renderer.release({texture,rect:{x:0,y:0,w:128,h:256}})}
  driver.resourceEpoch=2
  const current={width:1536,height:1536,bytes:36*MiB,resource:{}} as Texture
  renderer.busy.add(current);renderer.release({texture:current,rect:{x:0,y:0,w:1536,h:1536}})
  await renderer.reclaimScratch()
  expect(driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission',undefined,1)
  expect(driver.destroy).toHaveBeenCalledTimes(64)
  expect(driver.destroy).not.toHaveBeenCalledWith(current)
})

test('alias decrement cannot stamp a still-owned texture as a free-pool member',()=>{
  const {renderer,driver}=completedPoolFixture()
  const surface=renderer.acquire({x:0,y:0,w:1536,h:2048}),alias=renderer.retain(surface)
  driver.resourceEpoch=3;renderer.release(surface)
  expect(renderer.busy.has(alias.texture)).toBe(true)
  expect(renderer.free.get('1536:2048')?.includes(alias.texture)).not.toBe(true)
  renderer.release(alias)
  expect(renderer.poolReleaseEpoch.get(alias.texture)).toBe(3)
})
test('a current-frame texture crossing the batch byte limit invalidates the entire proof',async()=>{
  const {renderer,driver,MiB}=completedPoolFixture();renderer.free.clear();renderer.bytes=120*MiB
  for(const [epoch,bytes] of [[1,47*MiB],[2,2*MiB]]){
    driver.resourceEpoch=epoch
    const texture={width:1,height:1,bytes,resource:{}} as Texture
    renderer.busy.add(texture);renderer.release({texture,rect:{x:0,y:0,w:1,h:1}})
  }
  await renderer.reclaimScratch()
  expect((driver.checkpoint as any).mock.calls[0]).toHaveLength(2)
})
