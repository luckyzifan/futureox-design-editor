/** Independent hardware/PNG conversion probe over every valid 8-bit
 * premultiplied gray/alpha pair. Contains no reference image pixels. */
import { chromium } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output = await mkdtemp(join(tmpdir(), 'forma-alpha-readback-'))
const server = Bun.serve({ hostname:'127.0.0.1', port:0, fetch:()=>new Response('<!doctype html><canvas width="256" height="256"></canvas>',{headers:{'content-type':'text/html'}}) })
const browser = await chromium.launch({ headless:true, chromiumSandbox:true, args:['--use-angle=metal'] })
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}`)
  const result = await page.evaluate(async()=>{
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter || adapter.info.isFallbackAdapter) throw Error('Hardware GPU required')
    const device = await adapter.requestDevice(), canvas=document.querySelector('canvas')!
    const context=canvas.getContext('webgpu')!
    const format=navigator.gpu.getPreferredCanvasFormat()
    context.configure({device,format,alphaMode:'premultiplied',colorSpace:'srgb'})
    const module=device.createShaderModule({code:`
      @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
        let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
      }
      @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
        let a=floor(p.y); let c=min(floor(p.x),a); return vec4f(c,c,c,a)/255.;
      }`})
    const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]}})
    const commands=device.createCommandEncoder(), pass=commands.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
    pass.setPipeline(pipeline);pass.draw(3);pass.end();device.queue.submit([commands.finish()])
    await device.queue.onSubmittedWorkDone()
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('No PNG')),'image/png'))
    const png=Array.from(new Uint8Array(await blob.arrayBuffer()))
    const info={vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description,format}
    context.unconfigure();device.destroy();return {png,info}
  })
  await writeFile(join(output,'conversion.png'),Buffer.from(result.png))
  await writeFile(join(output,'provenance.json'),JSON.stringify({scope:'All valid 8-bit gray/alpha pairs; hardware WebGPU canvas to PNG',browser:browser.version(),...result.info},null,2))
  console.log(JSON.stringify({output,status:'captured'}))
} finally { await browser.close();server.stop(true) }
