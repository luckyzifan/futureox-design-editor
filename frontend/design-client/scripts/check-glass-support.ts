/** Real GPU float-bit comparison of reduced glass support, a full frame, and
 * a larger source region retaining at least the previous conservative halo. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-glass-support-'))
await mkdir(output, { recursive: true })
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20_000)
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)) })
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage()
  await page.goto(`${base}/gpu-check.html`)
  const selectedCases = process.env.DESIGN_GLASS_SUPPORT_CASES?.split(',')
  const results = await page.evaluate(async (selectedCases) => {
    const { initializePicking } = await import('/src/kernel/picking.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    await initializePicking()
    const rows = []
    type Definition = {name:string;depth:number;refraction:number;dispersion:number;radius:number;matrix:number[];
      parentShadow?:boolean;parentOpacity?:number;lensMask?:boolean;innerPeak?:boolean;zooms?:number[];profile?:string}
    const definitions: Definition[] = [
      { name: 'fractional', depth: 8, refraction: .5, dispersion: .3, radius: 3.25, matrix: [1,0,0,1,16.125,12.375] },
      { name: 'high-depth', depth: 24, refraction: 1, dispersion: 1, radius: 1.25, matrix: [1,0,0,1,16.375,12.125] },
      { name: 'nonuniform', depth: 12, refraction: 1, dispersion: 1, radius: 2.5, matrix: [1.25,0,0,.75,16.125,12.375] },
      { name: 'rotated-fallback', depth: 8, refraction: 1, dispersion: 1, radius: 2,
        matrix: [Math.cos(.3),Math.sin(.3),-Math.sin(.3),Math.cos(.3),24.375,8.125] },
      { name: 'opaque-parent', depth:8,refraction:.5,dispersion:.3,radius:12,
        matrix:[1,0,0,1,200.125,216.375],parentShadow:true },
      { name: 'parent-opacity-fallback', depth:8,refraction:.5,dispersion:.3,radius:12,
        matrix:[1,0,0,1,200.125,216.375],parentShadow:true,parentOpacity:.75 },
      { name: 'parent-mask-fallback', depth:8,refraction:.5,dispersion:.3,radius:12,
        matrix:[1,0,0,1,200.125,216.375],parentShadow:true,lensMask:true },
      { name:'inner-bevel-dispersion-peak',depth:128,refraction:1,dispersion:1,radius:3.75,
        matrix:[1,0,0,1,0,0],innerPeak:true,zooms:[1],profile:'figmaSubpixel' },
    ]
    const compare = (a: Float32Array, aw: number, ax: number, ay: number,
                     b: Float32Array, bw: number, bx: number, by: number, w: number, h: number) => {
      const aa = new Uint32Array(a.buffer, a.byteOffset, a.length)
      const bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
      let differentValues = 0
      for (let y=0;y<h;y++) for (let x=0;x<w;x++) for (let c=0;c<4;c++) {
        if (aa[((ay+y)*aw+ax+x)*4+c] !== bb[((by+y)*bw+bx+x)*4+c]) differentValues++
      }
      return differentValues
    }
    const selected=selectedCases?definitions.filter(d=>selectedCases.includes(d.name)):definitions
    if(selectedCases&&selected.length!==new Set(selectedCases).size) throw new Error('Unknown glass support case')
    for (const definition of selected) for (const zoom of definition.zooms??[1,2]) {
      const color = defaultColorSettings()
      const document = { schemaVersion: 5, id: definition.name, name: definition.name,
        colorManagement: color, pages: [{ id: 'p', name: 'p', background: '#445566', children: ['frame'] }],
        nodes: {
          frame: { id: 'frame', kind: 'frame', width: definition.innerPeak?512:definition.parentShadow?300:160,
            height: definition.innerPeak?512:definition.parentShadow?300:128, clip: true,opacity:definition.parentOpacity??1,
            radii:definition.parentShadow?[16,16,16,16]:[0,0,0,0],
            effects:definition.parentShadow?[{kind:'shadow',radius:8,y:8,color:'#000000',opacity:.5}]:[],
            fills: [{kind:'solid',color:'#fafafa'}], children: ['red','blue','lens'] },
          red: { id:'red',kind:'rectangle',width:49,height:128,transform:[1,0,0,1,5.125,0],fills:[{kind:'solid',color:'#a13f21'}] },
          blue: { id:'blue',kind:'rectangle',width:51,height:128,transform:[1,0,0,1,64.375,0],fills:[{kind:'solid',color:'#214a8f'}] },
          lens: { id:'lens',kind:'rectangle',width:definition.innerPeak?96:80,height:definition.innerPeak?64:56,transform:definition.matrix,
            mask:definition.lensMask??false,
            radii:definition.innerPeak?[16,16,16,16]:[12,12,12,12],fills:[{kind:'solid',color:'#ffffff',opacity:.14}],
            effects:[{kind:'glass',radius:definition.radius,color:'#000000',opacity:1,
              glass:{depth:definition.depth,refraction:definition.refraction,dispersion:definition.dispersion,
                lightAngle:31.25,lightIntensity:1}}] },
        } }
      const kernel = new VectorEngine()
      kernel.load_document(JSON.stringify(document))
      const gpu = await createGpu('webgpu', true, true, color)
      const width=96,height=80,
        view={x:-(definition.innerPeak?31:definition.lensMask?200.125:definition.parentShadow?220.125:10.375)*zoom,
          y:-(definition.innerPeak?1:definition.lensMask?216.375:definition.parentShadow?220.375:6.125)*zoom,zoom}
      const options={pageId:'p',width,height,view,transparent:false,grid:false,rasterProfile:definition.profile??'figma'}
      const sampleScale=options.rasterProfile==='figma'?2:1
      const render = async (scene: any) => {
        const result=await gpu.render(scene,true,false)
        result.bitmap?.close()
        if(!result.linear) throw new Error('Missing managed float readback')
        return result.linear
      }
      try {
        const fullScene=JSON.parse(kernel.compile_gpu(JSON.stringify(options)))
        const full=await render(fullScene)
        const crops=definition.innerPeak?[{x:0,y:0,w:1,h:1},{x:0,y:0,w:4,h:4}]:[{x:0,y:0,w:25,h:21},{x:18,y:17,w:31,h:27}]
        for (const crop of crops) {
          const scene=JSON.parse(kernel.compile_gpu(JSON.stringify({...options,width:crop.w,height:crop.h,gpuViewport:crop})))
          const matrix=scene.nodes.lens.matrix
          const [a,b,c,d]=matrix, s=a*a+b*b+c*c+d*d, det=a*d-b*c
          const scale=Math.sqrt((s+Math.sqrt(Math.max(0,s*s-4*det*det)))/2)
          const oldHalo=Math.ceil((definition.radius*2+definition.depth*(1+2*(definition.refraction+definition.dispersion*.125)))*scale)
            +(definition.parentShadow?Math.ceil(24*zoom*sampleScale):0)
          const currentHalo=crop.x*sampleScale-scene.extent.x
          const extra=definition.innerPeak?0:Math.max(8,Math.ceil((oldHalo-currentHalo)/sampleScale))
          const larger={x:crop.x-extra,y:crop.y-extra,w:crop.w+extra*2,h:crop.h+extra*2}
          if(larger.w>512||larger.h>512) throw new Error('Reference crop exceeds compile contract')
          let oldScene:any
          if(definition.innerPeak){
            // A visible zero-radius blur is skipped by applySampleEffects but
            // deliberately disqualifies the single-effect support shortcut.
            // This retains the actual old halo without exceeding the 512px
            // requested-crop contract for the deep inner-bevel counterexample.
            const referenceDoc=JSON.parse(JSON.stringify(document))
            referenceDoc.nodes.lens.effects.push({kind:'blur',radius:0,color:'#000000',opacity:1})
            const referenceKernel=new VectorEngine()
            try{referenceKernel.load_document(JSON.stringify(referenceDoc));oldScene=JSON.parse(referenceKernel.compile_gpu(JSON.stringify({...options,width:crop.w,height:crop.h,gpuViewport:crop})))}finally{referenceKernel.free()}
          }else oldScene=JSON.parse(kernel.compile_gpu(JSON.stringify({...options,width:larger.w,height:larger.h,gpuViewport:larger})))
          if(oldScene.extent.x>crop.x*sampleScale-oldHalo||oldScene.extent.y>crop.y*sampleScale-oldHalo||
             oldScene.extent.x+oldScene.extent.w<(crop.x+crop.w)*sampleScale+oldHalo||
             oldScene.extent.y+oldScene.extent.h<(crop.y+crop.h)*sampleScale+oldHalo) throw new Error('Reference did not retain old support')
          const actual=await render(scene), conservative=await render(oldScene)
          const record={name:definition.name,zoom,crop,currentHalo,oldHalo,extent:scene.extent,
            referenceExtent:oldScene.extent,frameEffects:scene.nodes.frame.effects.map((e:any)=>e.kind),
            fullDifferences:compare(actual,crop.w,0,0,full,width,crop.x,crop.y,crop.w,crop.h),
            conservativeDifferences:compare(actual,crop.w,0,0,conservative,larger.w,extra,extra,crop.w,crop.h)}
          rows.push(record)
        }
      } finally { gpu.dispose(); kernel.free() }
    }
    return rows
  },selectedCases)
  const failures=results.filter(row=>row.fullDifferences||row.conservativeDifferences)
  await writeFile(join(output,'results.json'),JSON.stringify({selectedCases:selectedCases??null,rows:results,failures,passed:!failures.length},null,2))
  console.log(JSON.stringify({output,cases:results.length,failures}))
  if(failures.length) process.exitCode=1
} finally { await browser?.close(); server.kill('SIGTERM') }
