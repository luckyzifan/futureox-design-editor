import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { effect, node, paint } from '../../frontend/design-client/src/model'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { GpuRenderer } from '../../frontend/design-client/src/kernel/gpu/renderer'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report: any = { status: 'running', scope: 'Requested topology archive, complete native-converted source roots; original and explicitly derived effects separately identified. Metal display graph plus final QA readback.', cases: [], timings: [] }
async function publish() { document.querySelector('#result')!.textContent = JSON.stringify(report, null, 2); await fetch('/report', { method: 'POST', body: JSON.stringify(report) }) }
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const encode = (v: number) => { v = Math.min(1, Math.max(0, v)); return v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055 }
function difference(a: Float32Array, b: Float32Array) {
  let changedBits = 0, maxEncoded = 0, maxAlpha = 0, nonfinite = 0
  const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < a.length; i++) {
    if (aa[i] !== bb[i]) changedBits++
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { if (aa[i] !== bb[i]) nonfinite++; continue }
    if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, Math.abs(a[i] - b[i]))
    else for (const background of [0, 1]) {
      const alpha = i - i % 4 + 3
      maxEncoded = Math.max(maxEncoded, Math.abs(encode(a[i] + background * (1 - a[alpha])) - encode(b[i] + background * (1 - b[alpha]))))
    }
  }
  return { changedBits, maxEncoded, maxAlpha, nonfinite }
}
function preview(outputs: Float32Array[], width: number, height: number, name: string) {
  const section = document.createElement('section'); section.textContent = name; const pair = document.createElement('div'); pair.className = 'pair'; section.append(pair)
  for (const values of outputs) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; pair.append(canvas)
    const bytes = new Uint8ClampedArray(values.length)
    for (let i = 0; i < values.length; i += 4) { for (let c = 0; c < 3; c++) bytes[i + c] = Math.round(encode(values[i + c] + 1 - values[i + 3]) * 255); bytes[i + 3] = 255 }
    canvas.getContext('2d')!.putImageData(new ImageData(bytes, width, height), 0, 0)
  }
  document.querySelector('#previews')!.append(section)
}
const mul = (a: number[], b: number[]) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
try {
  await initializeKernelModule()
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter || adapter.info.isFallbackAdapter) throw Error('Hardware required')
  report.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter }
  const manifest = await (await fetch('/topology-inputs/manifest.json')).json(); report.source = { path: manifest.source, hash: manifest.sourceHash, nativeBinary: manifest.binaryHash }
  if (!manifest.sourceUnchanged || manifest.status !== 'passed') throw Error('Unverified topology preparation')
  const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
  const cases: any[] = [
    ['gaussian', 'blur-type0', 'gaussian-blur', 4], ['modern-gaussian', 'blurs-type0', 'gaussian-blur', 4],
    ['background', 'blur-type3', 'background-blur', 4], ['shadow', 'shadows', 'shadow', 4],
    ['inner-shadow', 'innerShadows', 'inner-shadow', 4], ['motion', 'blur-type1', 'motion-blur', 2],
    ['background-950', 'blur-type3', 'background-blur', 9.5], ['shadow-950', 'shadows', 'shadow', 9.5],
    ['derived-tent', 'shadows', 'blur', 2, true], ['derived-gradient', 'shadows', 'blur', 2, true],
    ['derived-zoom', 'shadows', 'zoom-blur', 2, true], ['derived-glass-blur', 'shadows', 'glass', 2, true],
  ]
  const selectedCase = new URL(location.href).searchParams.get('case')
  for (const [name, sourceName, kind, zoom, derived] of cases.filter(c => !selectedCase || c[0] === selectedCase)) {
    report.current = name; await publish()
    const metadata = manifest.cases.find((c: any) => c.name === sourceName)
    const text = await (await fetch(`/topology-inputs/${metadata.file}`)).text()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('')
    if (hash !== metadata.hash) throw Error('Topology working set hash mismatch')
    const doc = JSON.parse(text), page = doc.pages[0], rootId = page.children[0]
    if (derived) {
      doc.schemaVersion = Math.max(20, doc.schemaVersion)
      const fx = effect(kind); fx.radius = 8
      if (kind === 'zoom-blur') { fx.radius = 0; fx.zoomBlur = { amount: 12, center: [.35, .65] } }
      if (name === 'derived-gradient') fx.gradientBlur = { start: [0, 0], end: [doc.nodes[rootId].width, doc.nodes[rootId].height], startCount: 0, endCount: 8, smooth: true }
      if (kind === 'glass') {
        const parent=doc.nodes[rootId],probe=node('rectangle',parent.width*.2,parent.height*.2,parent.width*.6,parent.height*.6)
        probe.id='derived-glass-blur-probe';probe.effects=[fx];probe.fills=[paint('color(srgb 1 1 1 / 0.1)')]
        parent.children.push(probe.id);doc.nodes[probe.id]=probe
      } else doc.nodes[rootId].effects.push(fx)
    }
    const candidates: any[] = [], walk = (id: string, parent: number[], visible: boolean) => {
      const n = doc.nodes[id]; if (!n) return
      const matrix = mul(parent, n.transform); visible &&= n.visible !== false
      if (visible && n.effects.some((f: any) => f.visible && f.kind === kind && (f.radius > 0 || f.zoomBlur?.amount > 0))) candidates.push({ n, matrix })
      for (const child of n.children) walk(child, matrix, visible)
    }
    for (const id of page.children) walk(id, [1, 0, 0, 1, 0, 0], true)
    const selected = derived ? candidates.find(c => c.n.id === (kind === 'glass' ? 'derived-glass-blur-probe' : rootId)) : candidates.sort((a,b) => Math.max(...b.n.effects.filter((f:any)=>f.kind===kind).map((f:any)=>f.radius))-Math.max(...a.n.effects.filter((f:any)=>f.kind===kind).map((f:any)=>f.radius)))[0]
    if (!selected) throw Error('Requested effect missing: ' + kind)
    const { n, matrix: m } = selected, width = 256, height = 192
    const vertex=n.network?.vertices?.[0]
    const point=derived?[n.width/2,n.height/2]:vertex?[vertex.x,vertex.y]:[n.width/2,kind==='shadow'?n.height:0]
    const cx=m[4]+m[0]*point[0]+m[2]*point[1],cy=m[5]+m[1]*point[0]+m[3]*point[1]
    const kernel = new VectorEngine(); kernel.load_font(font); kernel.load_document(JSON.stringify(doc))
    const options = { pageId: page.id, width, height, view: { x: width/2-cx*zoom, y: height/2-cy*zoom, zoom }, rasterProfile: 'figmaSubpixel', transparent: true }
    const raw = kernel.compile_gpu(JSON.stringify(options)), owner = createDecodedImageOwner(), settings = kernel.color_settings(), pair: any[] = []
    const scene = () => { const s=JSON.parse(raw);s.vertices=new Float32Array(s.vertices);s.curves=new Float32Array(s.curves);return s }
    const row: any = { name, kind, sourceRoot: metadata.target, derived: !!derived, targetId: n.id, options, runs: [[],[]] };report.cases.push(row)
    try {
      for (const enabled of [false, true]) {
        const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:decodedImageScope(owner,settings),settings,current:()=>true,ownerCurrent:()=>true,resourceOwner:owner}),{key:async()=>undefined,read:async()=>undefined,write:()=>{}})
        const driver=await WebGpuDriver.create(true,false,true,true,false),renderer=new GpuRenderer(driver,true,false,loader) as any
        renderer.canvasBlurEnabled=enabled
        if (name === 'motion' && !enabled) {
          const spatial=renderer.spatialBlur.bind(renderer), seen=new Set<string>()
          renderer.spatialBlur=async(input:any,node:any,fx:any)=>{
            if(fx.kind==='motion-blur'&&!seen.has(node.id)) {
              seen.add(node.id); const stats:any={node:node.id,rect:input.rect};
              if(input.rect.w*input.rect.h<=4000000){const values=await driver.readSurface(input.texture);stats.channels=values.length;stats.outsideUnit=values.reduce((n,v)=>n+Number(v<0||v>1||!Number.isFinite(v)),0);stats.min=values.reduce((a,b)=>Math.min(a,b),Infinity);stats.max=values.reduce((a,b)=>Math.max(a,b),-Infinity)}
              (row.motionSources??=[]).push(stats)
            }
            return spatial(input,node,fx)
          }
        }
        const finish=driver.finish.bind(driver);driver.finish=(t,r,w,h,_readback,presentation,present,output)=>finish(t,r,w,h,true,presentation,present,output)
        pair.push({renderer,driver})
      }
      const outputs:Float32Array[]=[]
      for(let round=0;round<5;round++)for(const side of round%2?[1,0]:[0,1]){
        const start=performance.now(),result=await pair[side].renderer.render(scene(),false,true),wallMs=performance.now()-start
        if(!result.linear)throw Error('Missing display readback');result.bitmap?.close()
        const r={wallMs,draws:result.drawCalls,pixels:result.passPixels,peakBytes:result.peakTextureBytes,blur:pair[side].driver.canvasBlurPasses,motion:pair[side].driver.canvasMotionBlurPasses,zoom:pair[side].driver.canvasZoomBlurPasses}
        if(round===0)(row.cold??=[])[side]=r;if(round===1)outputs[side]=result.linear;if(round>=2)row.runs[side].push(r)
        await publish()
      }
      row.nonuniformChannels=outputs[0].reduce((count,v,i)=>count+Number(Math.abs(v-outputs[0][i%4])>.01),0)
      if(row.nonuniformChannels<1000)throw Error('Topology viewport does not exercise a visible edge')
      row.difference=difference(outputs[0],outputs[1]);preview(outputs,width,height,name)
      if(!outputs[0].some((v,i)=>i%4===3&&v>.01))throw Error('Empty reference')
      if(row.difference.nonfinite||row.difference.maxEncoded>=1/255||row.difference.maxAlpha>=1/255)throw Error('Topology quality gate failed')
      const exact:Float32Array[]=[]
      for(const side of [0,1]){const r=await pair[side].renderer.render(scene(),true,false);exact[side]=r.linear;if(pair[side].driver.canvasBlurPasses||pair[side].driver.canvasMotionBlurPasses||pair[side].driver.canvasZoomBlurPasses)throw Error('Display arithmetic entered exact output')}
      row.exactOutput=difference(exact[0],exact[1]);if(row.exactOutput.changedBits)throw Error('Exact topology output changed')
      const controlMs=median(row.runs[0].map((r:any)=>r.wallMs)),candidateMs=median(row.runs[1].map((r:any)=>r.wallMs))
      report.timings.push({name,controlMs,candidateMs,improvement:1-candidateMs/controlMs,counters:row.runs[1][0]});await publish()
    }finally{for(const {renderer} of pair)renderer.dispose();kernel.free()}
  }
  if (!report.cases.length) throw Error('No selected topology cases')
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
