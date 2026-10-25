import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
const MiB = 1024 * 1024

function pressureFixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  let resolve!: () => void, reject!: (error: Error) => void, covered = false, current = true
  const create = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture
  const driver = { name: 'webgpu', managed: true, create, clear: vi.fn(), pass: vi.fn(), scratchBytes: 0,
    resourceEpoch: 3, completedResourceEpoch: 2,
    destroy: vi.fn((_texture: Texture) => expect(covered).toBe(true)),
    checkpoint: vi.fn(async () => {
      await new Promise<void>((yes, no) => { resolve = yes; reject = no }); covered = true
    }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  renderer.scene = { extent: { x: 0, y: 0, w: 768, h: 512 }, coherentSamples: true, rootInputBox: [0, 0, 768, 512] }
  renderer.frameBudget = 24 * MiB; renderer.frameCurrent = () => current
  const targets = Array.from({ length: 4 }, () => renderer.acquire({ x: 0, y: 0, w: 512, h: 512 })) as Surface[]
  const free = create(256, 512), image = create(512, 512)
  renderer.free.set('256:512', [free]); renderer.used.add(free); renderer.poolReleaseEpoch.set(free, 3)
  renderer.images.set('fixture', { texture: image, rect: { x: 0, y: 0, w: 512, h: 512 } }); renderer.used.add(image)
  renderer.bytes += free.bytes + image.bytes
  const n = { id: 'backdrop', rect: { x: 0, y: 0, w: 512, h: 512 }, backdropBox: [0, 0, 768, 512], matrix: [1, 0, 0, 1, 0, 0] } as unknown as GpuNode
  const run = renderer.run.bind(renderer)
  renderer.run = vi.fn((mode: number, ...args: any[]) => {
    const output = run(mode, ...args)
    if (mode === 26) { renderer.release(output); throw Error('captured') }
    return output
  })
  return { renderer, driver, targets, free, image, n, run: () => renderer.drawBackdropLeaf(n, targets, undefined, { kind: 'background-blur', radius: 1, visible: true }),
    complete: () => resolve(), fail: () => reject(Error('uncertain fence')), cancel: () => { current = false } }
}

test('the actual capture allocation waits for covered pool and last-resort image reclamation before reading its four live planes', async () => {
  const f = pressureFixture(), pending = f.run()
  expect(f.renderer.run).not.toHaveBeenCalled(); expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.busy.size).toBe(4)
  f.complete()
  await expect(pending).rejects.toThrow('captured')
  expect(f.driver.destroy.mock.calls.map(call => call[0])).toEqual([f.free, f.image])
  expect(f.renderer.run).toHaveBeenCalledExactlyOnceWith(26, { x: 0, y: 0, w: 768, h: 512 }, f.targets)
  expect(f.driver.pass.mock.calls[0][2]).toEqual(f.targets.map(s => s.texture))
  expect(f.renderer.bytes).toBe(22 * MiB); expect(f.renderer.bytes).toBeLessThanOrEqual(f.renderer.frameBudget)
  expect(f.targets.every(s => f.renderer.busy.has(s.texture))).toBe(true)
})

test.each(['cancel', 'failed-completion'] as const)('%s before capture encodes no stale mode26 and retains all four source planes', async mode => {
  const f = pressureFixture(), pending = f.run()
  if (mode === 'cancel') { f.cancel(); f.complete() } else f.fail()
  await expect(pending).rejects.toThrow(mode === 'cancel' ? 'PREVIEW_CANCELLED' : 'uncertain fence')
  expect(f.renderer.run).not.toHaveBeenCalled(); expect(f.driver.pass).not.toHaveBeenCalled()
  expect(f.targets.every(s => f.renderer.busy.has(s.texture))).toBe(true)
  if (mode === 'failed-completion') { expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.images.size).toBe(1) }
  expect(f.driver.completedResourceEpoch).toBe(2)
})

test('an existing exact-size capture pool does not add an admission wait', async () => {
  const f = pressureFixture(), texture = f.driver.create(768, 512)
  f.renderer.free.set('768:512', [texture]); f.renderer.bytes += texture.bytes; f.renderer.frameBudget = 32 * MiB
  await expect(f.run()).rejects.toThrow('captured')
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
})

test('the generic backdrop capture waits as well, while replay does not request a nonexistent capture allocation', async () => {
  for (const replay of [false, true]) {
    const f = pressureFixture(), n = { ...f.n, opacity: 1, blend: 'normal', fills: [], strokes: [], children: [],
      effects: [{ kind: 'glass', radius: 1, visible: true, glass: { refraction: 1 } }], captureReplay: replay, glassShape: {} } as unknown as GpuNode
    f.driver.managed = false
    f.renderer.scene.nodes = { backdrop: n }; f.renderer.scene.roots = ['backdrop']
    f.renderer.yieldEncoding = () => undefined; f.renderer.reclaimScratch = vi.fn(async () => {})
    f.renderer.replayTexture = () => false; f.renderer.streamIsolatedFilter = async () => undefined
    f.renderer.nodeMask = () => f.targets[0]
    f.renderer.glass = () => { throw Error('replay reached') }
    let complete!: () => void
    f.renderer.reclaimForSurface = vi.fn(() => new Promise<void>(yes => { complete = yes }))
    const pending = f.renderer.drawBundle(['backdrop'], f.targets)
    // drawBundle has several intentional task boundaries before this branch.
    for (let i = 0; i < 30 && !f.renderer.reclaimForSurface.mock.calls.length && !replay; i++) await Promise.resolve()
    if (replay) {
      await expect(pending).rejects.toThrow('replay reached')
      expect(f.renderer.reclaimForSurface).not.toHaveBeenCalled()
      expect(f.renderer.run).not.toHaveBeenCalled()
    } else {
      expect(f.renderer.reclaimForSurface).toHaveBeenCalledExactlyOnceWith(n.rect)
      expect(f.renderer.run).not.toHaveBeenCalled()
      complete()
      await expect(pending).rejects.toThrow('captured')
    }
  }
})

test('color-surface admission charges the actual managed or byte format and skips an exact-size pool', async () => {
  const f = pressureFixture(); f.renderer.reclaimScratch = vi.fn(async () => {})
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).toHaveBeenLastCalledWith(9 * 7 * 16)
  f.driver.managed = false
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).toHaveBeenLastCalledWith(9 * 7 * 4)
  f.renderer.reclaimScratch.mockClear(); f.renderer.free.set('9:7', [f.driver.create(9, 7)])
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).not.toHaveBeenCalled()
})

function ordinaryCompositionFixture(){
 const f=pressureFixture(),n={...f.n,id:'ordinary',opacity:.5,blend:'normal',passthrough:true,
  clip:false,mask:false,children:[],fills:[],strokes:[],effects:[]}as unknown as GpuNode
 f.renderer.scene.nodes={ordinary:n};f.renderer.scene.roots=['ordinary'];f.renderer.scene.interactionRetained=false
 f.renderer.nodeSource=vi.fn(async()=>f.targets[1])
 const run=f.renderer.run.mockImplementation((mode:number,...args:any[])=>{
  if(mode!==28)throw Error('Unexpected ordinary composition path')
  return (GpuRenderer.prototype as any).run.call(f.renderer,mode,...args)
 })
 return {...f,compose:()=>f.renderer.drawNode(n.id,f.targets[0]),encoded:run}
}
test('ordinary canvas composition admits its new destination after child work and waits before destroying pending pool bytes',async()=>{
 const f=ordinaryCompositionFixture(),pending=f.compose()
 for(let i=0;i<10&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
 expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.encoded).not.toHaveBeenCalled()
 expect(f.driver.destroy).not.toHaveBeenCalled()
 f.complete();const output=await pending
 expect(f.encoded).toHaveBeenCalledTimes(1);expect(f.encoded.mock.calls[0][0]).toBe(28)
 expect(f.driver.destroy.mock.calls.map(call=>call[0])).toEqual([f.free])
 expect(f.renderer.images.has('fixture')).toBe(true)
 expect(f.renderer.bytes).toBeLessThanOrEqual(f.renderer.frameBudget)
 expect(output.rect).toEqual(f.targets[0].rect)
})
test.each(['cancel','failed-completion'] as const)('ordinary %s preserves both live sources and encodes no stale interpolation',async mode=>{
 const f=ordinaryCompositionFixture(),pending=f.compose()
 for(let i=0;i<10&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
 if(mode==='cancel'){f.cancel();f.complete()}else f.fail()
 await expect(pending).rejects.toThrow(mode==='cancel'?'PREVIEW_CANCELLED':'uncertain fence')
 expect(f.encoded).not.toHaveBeenCalled();expect(f.driver.pass).not.toHaveBeenCalled()
 expect(f.targets.every(s=>f.renderer.busy.has(s.texture))).toBe(true)
})

test('completed groups retire only their consumed masks, keeping ancestor clips, output aliases and shared owners live',()=>{
 const f=pressureFixture(),node={id:'group',children:['child']}as GpuNode
 const masks=Array.from({length:4},()=>f.driver.create(64,64))
 for(const texture of masks){f.renderer.busy.add(texture);f.renderer.used.add(texture);f.renderer.bytes+=texture.bytes;f.renderer.maskOwners.set(texture,new Set(['group']))}
 f.renderer.maskOwners.set(masks[3],new Set(['group','ancestor']))
 const asSurface=(texture:Texture)=>({texture,rect:{x:0,y:0,w:64,h:64}})
 const outputs=[asSurface(masks[2])],clips=[asSurface(masks[1])]
 f.renderer.retireLeafMasks(node,undefined,clips,outputs)
 expect(masks.every(t=>f.renderer.busy.has(t))).toBe(true)
 f.renderer.retireLeafMasks(node,undefined,clips,outputs,true)
 expect(f.renderer.busy.has(masks[0])).toBe(false)
 expect(f.renderer.free.get('64:64')).toContain(masks[0])
 expect(f.renderer.used.has(masks[0])).toBe(true)
 expect(masks.slice(1).every(t=>f.renderer.busy.has(t))).toBe(true)
 expect(f.driver.destroy).not.toHaveBeenCalled()
})

function expansionPressureFixture(){
 const f=pressureFixture();f.renderer.frameBudget=32*MiB
 let background:Surface|undefined
 f.renderer.blurBackdropRegion=vi.fn(async(source:Surface)=>{
  background=source
  const texture=f.driver.create(128,1024)
  f.renderer.free.set('128:1024',[texture]);f.renderer.used.add(texture);f.renderer.poolReleaseEpoch.set(texture,3);f.renderer.bytes+=texture.bytes
  return source
 })
 f.renderer.run.mockImplementation((mode:number,...args:any[])=>{
  const out=(GpuRenderer.prototype as any).run.call(f.renderer,mode,...args)
  if(mode===27){f.renderer.release(out);throw Error('expanded')}
  return out
 })
 return {...f,get background(){return background}}
}
test('background expansion accounts for pool pressure created by filtering after the capture was admitted',async()=>{
 const f=expansionPressureFixture(),pending=f.run()
 for(let i=0;i<20&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
 expect(f.renderer.run.mock.calls.map((call:any[])=>call[0])).toEqual([26])
 expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.driver.destroy).not.toHaveBeenCalled()
 expect(f.renderer.busy.has(f.background!.texture)).toBe(true)
 f.complete();await expect(pending).rejects.toThrow('expanded')
 expect(f.renderer.run.mock.calls.map((call:any[])=>call[0])).toEqual([26,27])
 expect(f.driver.pass.mock.calls.at(-1)![2]).toEqual([f.background!.texture])
 expect(f.targets.every(s=>f.renderer.busy.has(s.texture))).toBe(true)
 expect(f.renderer.bytes).toBeLessThanOrEqual(f.renderer.frameBudget)
})
test.each(['cancel','failed-completion'] as const)('background expansion %s never encodes or releases its live blurred input',async mode=>{
 const f=expansionPressureFixture(),pending=f.run()
 for(let i=0;i<20&&!f.driver.checkpoint.mock.calls.length;i++)await Promise.resolve()
 if(mode==='cancel'){f.cancel();f.complete()}else f.fail()
 await expect(pending).rejects.toThrow(mode==='cancel'?'PREVIEW_CANCELLED':'uncertain fence')
 expect(f.renderer.run.mock.calls.map((call:any[])=>call[0])).toEqual([26])
 expect(f.renderer.busy.has(f.background!.texture)).toBe(true)
})
