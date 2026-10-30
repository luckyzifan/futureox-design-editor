/** Real product import/pointer/menu/prototype acceptance plus real GPU pixels.
 * The source fixtures use production file input. No editor/state injection. */
import { chromium, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, paint, defaultImageAdjust, defaultPatternTile, type DesignDocument } from '../src/model'
import { emptySystem } from '../src/design-system'

const output = await mkdtemp(join(tmpdir(), 'design-canvas-repair-'))
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
const checks: unknown[] = [], errors: string[] = []
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, acceptDownloads: true })
  const p = page
  p.on('pageerror', e => errors.push(String(e)))
  await p.goto(server.resolvedUrls!.local[0])
  await expect(p.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60000 })
  const canvas = p.getByTestId('canvas')
  const saved = () => p.evaluate(async () => (await (await import('/src/local-store.ts')).localOpen())!.document)
  const settle = async () => {
    await p.waitForFunction(() => document.querySelector('.kernel-status.error') ||
      (document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.presentationReady === 'true' &&
       document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.revision === document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.requestedRevision), null, { timeout: 90000 })
    expect(await p.locator('.kernel-status.error').allTextContents()).toEqual([])
  }
  const load = async (doc: DesignDocument) => {
    const filename = join(output, doc.name + '.fd'); await writeFile(filename, JSON.stringify(doc))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(filename)
    await expect(p.getByLabel('文档名称', { exact: true })).toHaveValue(doc.name, { timeout: 60000 })
    await expect(p.locator('.document-transition')).toHaveCount(0, { timeout: 60000 })
    await expect.poll(async () => (await saved()).name).toBe(doc.name)
    await p.getByLabel('缩放与视图设置', { exact: true }).click()
    await p.getByRole('button', { name: '100%', exact: true }).click()
    await settle()
  }
  const screen = async (x: number, y: number) => {
    const b = await canvas.boundingBox(); if (!b) throw Error('Missing canvas')
    const v = await p.locator('.kernel-presentation').evaluate(el => ({ ...((el as HTMLElement).dataset) }))
    return { x: b.x + Number(v.cameraX) + x * Number(v.cameraZoom), y: b.y + Number(v.cameraY) + y * Number(v.cameraZoom) }
  }
  const uri = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 8
    const x = c.getContext('2d')!; x.fillStyle = '#385d82'; x.fillRect(0, 0, 8, 8)
    x.fillStyle = '#b84a27'; x.fillRect(0, 0, 4, 4); x.fillRect(4, 4, 4, 4)
    return c.toDataURL()
  })
  const d = blank('预览参数与版本验收'); d.schemaVersion = 14
  const back = node('rectangle', 0, 0, 700, 500), image = node('rectangle', 100, 100, 180, 140)
  back.fills = [paint('#dfdfdf')]; image.name = '调色平铺图片'
  image.fills = [{ ...paint('#000000', 'image'), image: uri,
    adjust: { ...defaultImageAdjust(), exposure: .4 }, tile: { ...defaultPatternTile(), size: [24,24] } }]
  d.nodes = { [back.id]: back, [image.id]: image }; d.pages[0].children = [back.id, image.id]
  await load(d)
  await p.getByTestId(`layer-${image.id}`).click()
  await settle()
  const at = await screen(190,170)
  await p.mouse.move(at.x, at.y); await p.mouse.down(); await p.mouse.move(at.x+40,at.y+20,{steps:8})
  // These paints must retain kernel pixels; the SVG renderer cannot silently
  // replace them while the pointer is held. Non-overlapping retained snapshots
  // are separately covered by the existing suite.
  await expect(p.getByTestId('canvas-edit-preview')).toHaveAttribute('data-active', 'false')
  await p.screenshot({ path: join(output, 'image-drag.png') })
  await p.mouse.up()
  await expect.poll(async () => (await saved()).nodes[image.id].transform[4]).toBe(140)
  await settle()
  expect((await saved()).nodes[image.id].fills).toEqual(image.fills)
  await canvas.focus(); await p.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await saved()).nodes[image.id].transform[4]).toBe(100)
  await settle()
  checks.push({ name: 'adjusted patterned image real drag + undo', svgUsed: false, parametersPreserved: true })

  await p.getByRole('button', { name: '实用工具', exact: true }).click()
  await p.getByRole('menuitemradio', { name: '切片', exact: true }).click()
  const a = await screen(70,70), b = await screen(320,270)
  await p.mouse.move(a.x,a.y); await p.mouse.down(); await p.mouse.move(b.x,b.y,{steps:8})
  await p.screenshot({ path: join(output,'schema14-slice-draft.png') }); await p.mouse.up(); await settle()
  await expect.poll(async () => Object.values((await saved()).nodes).filter(n => n.kind === 'slice').length).toBe(1)
  expect((await saved()).schemaVersion).toBe(14)
  checks.push({ name: 'slice draft on schema14 document', schemaVersion: 14 })
  await canvas.focus(); await p.keyboard.press('Escape'); await p.keyboard.press('v')
  await p.getByTestId(`layer-${image.id}`).click()
  for (const mode of ['linear-burn','linear-dodge']) {
    await p.getByLabel('混合模式', { exact: true }).selectOption(mode)
    await expect.poll(async () => (await saved()).nodes[image.id].blend).toBe(mode)
    await settle()
  }
  await p.screenshot({ path: join(output,'blend-ui.png') })
  checks.push({ name: 'both new blend modes selected through Inspector', backend: await p.locator('.kernel-tiles').getAttribute('data-backend') })

  const proto = blank('原型播放字段验收'); proto.schemaVersion = 12
  const f = node('frame',0,0,400,1200), g = node('frame',500,0,400,1200), overlay = node('frame',1000,0,80,60)
  const go = node('rectangle',20,400,100,80), reset = node('rectangle',20,400,100,80), pop = node('rectangle',160,400,100,80), smart = node('rectangle',160,600,100,60)
  f.name='起点'; g.name='目标'; overlay.name='浮层'; go.name='保留滚动跳转'; reset.name='重置滚动返回'; pop.name='打开指定浮层'
  smart.name='智能跳转'
  f.children=[go.id,smart.id]; g.children=[reset.id,pop.id]; f.fills=[paint('#f0f4ff')];g.fills=[paint('#fff4e8')]
  proto.nodes=Object.fromEntries([f,g,overlay,go,reset,pop,smart].map(n=>[n.id,n]));proto.pages[0].children=[f.id,g.id,overlay.id]
  proto.designSystem={...emptySystem(),collections:{c:{name:'播放',modes:['base'],defaultMode:'base'}},variables:{
    duration:{name:'时长',collection:'c',kind:'number',values:{base:350}},easing:{name:'曲线',collection:'c',kind:'string',values:{base:'ease-out-cubic'}}}}
  proto.prototype={startNode:f.id,interactions:{
    [go.id]:[{trigger:'click',actions:[{kind:'navigate',target:g.id,transitionDurationVar:'duration',transitionEasingVar:'easing',transitionShouldSmartAnimate:false,transitionPreserveScroll:true}]}],
    [reset.id]:[{trigger:'click',actions:[{kind:'navigate',target:f.id,transitionShouldSmartAnimate:false,transitionResetScrollPosition:true}]}],
    [pop.id]:[{trigger:'click',actions:[{kind:'overlay',target:overlay.id,overlayPosition:{origin:'manual',x:27,y:35,padding:0,background:false}}]}],
    [overlay.id]:[{trigger:'click',actions:[{kind:'close-overlay'}]}],
    [smart.id]:[{trigger:'click',actions:[{kind:'navigate',target:g.id,durationMs:1200,transitionShouldSmartAnimate:true}]}],
  }}
  await load(proto); await p.getByLabel('预览原型', {exact:true}).click()
  const player=p.getByRole('dialog',{name:'交互原型预览'}), scroller=p.getByTestId('prototype-scroll')
  await expect(player).toBeVisible(); await scroller.hover(); await p.mouse.wheel(0,250)
  await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBeGreaterThan(100)
  const previous=await scroller.evaluate(el=>el.scrollTop)
  await player.getByRole('button',{name:'保留滚动跳转',exact:true}).click()
  await expect(player.locator('header strong')).toHaveText('原型 · 目标')
  await expect(player).toHaveAttribute('data-transition-ms','350');await expect(player).toHaveAttribute('data-transition-easing','ease-out-cubic')
  await expect(player).toHaveAttribute('data-animation-plan','none')
  expect(Math.abs(await scroller.evaluate(el=>el.scrollTop)-previous)).toBeLessThan(2)
  await player.getByRole('button',{name:'打开指定浮层',exact:true}).click()
  const placed=await player.locator('.prototype-overlay').evaluate(el=>({left:(el.parentElement as HTMLElement).style.left,top:(el.parentElement as HTMLElement).style.top}))
  expect(placed).toEqual({left:'27px',top:'35px'})
  await player.getByRole('button',{name:'浮层',exact:true}).click()
  await player.getByRole('button',{name:'重置滚动返回',exact:true}).click()
  await expect(player.locator('header strong')).toHaveText('原型 · 起点')
  await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBe(0)
  await player.getByRole('button',{name:'智能跳转',exact:true}).click()
  await expect(player).toHaveAttribute('data-animation-plan','kernel-baked')
  await expect.poll(async()=>Number(await player.getAttribute('data-transition-progress'))).toBe(1)
  await expect(player.getByRole('alert')).toHaveCount(0)
  await p.screenshot({path:join(output,'prototype.png')})
  await player.getByRole('button',{name:'关闭预览',exact:true}).click()
  expect((await saved()).designSystem!.variables.duration.values.base).toBe(350)
  checks.push({name:'real prototype clicks + wheel',durationMs:350,easing:'ease-out-cubic',preservedScroll:previous,resetScroll:0,overlay:placed})

  const pixels=await p.evaluate(async()=>{
    const {KernelClient}=await import('/src/kernel/client.ts')
    const {blank,node,paint,stroke}=await import('/src/model.ts')
    const c=new KernelClient(), rows:unknown[]=[]
    try{
      for(const profile of ['analytic','byte-figma','managed-figma'])for(const mode of ['linear-burn','linear-dodge'] as const)for(const scope of ['node','fill','stroke']){
        const doc=blank('blend pixels');doc.schemaVersion=3;doc.rasterProfile=profile==='analytic'?'analytic':'figma'
        if(profile==='managed-figma')doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
        const back=node('rectangle',0,0,32,32),front=node('rectangle',7,6,18,19)
        back.fills=[paint('#5599bb')];front.fills=[paint('#a87744')];front.opacity=.7
        if(scope==='node')front.blend=mode
        if(scope==='fill')front.fills[0].blend=mode
        if(scope==='stroke'){front.strokes=[stroke('#976853')];front.strokes[0].width=4;front.strokes[0].paint.blend=mode}
        doc.nodes={[back.id]:back,[front.id]:front};doc.pages[0].children=[back.id,front.id]
        const options={pageId:doc.pages[0].id,width:32,height:32,view:{x:.25,y:.5,zoom:1},grid:false,transparent:false,rasterProfile:doc.rasterProfile,renderIntent:'settled' as const}
        const cpu=await c.render(doc,options,false,'cpu',true)
        for(const backend of ['webgpu','webgl2'] as const){
          const gpu=await c.render(doc,options,false,backend,true)
          if(gpu.backend!==backend)throw Error('Unexpected backend '+gpu.backend)
          let max=0,changed=0;for(let i=0;i<cpu.bytes.length;i++){const delta=Math.abs(cpu.bytes[i]-gpu.bytes[i]);max=Math.max(max,delta);if(delta)changed++}
          rows.push({profile,mode,scope,backend,max,changed})
          if(max!==0)throw Error(JSON.stringify(rows.at(-1)))
        }
      }
    }finally{c.dispose()}
    return rows
  })
  checks.push({name:'actual CPU/WebGPU/WebGL pixel parity',pixels})
  expect(errors).toEqual([])
  await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',checks,errors},null,2))
  console.log(JSON.stringify({status:'passed',checks:checks.length,pixelCases:pixels.length,output}))
} catch(error){
  await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{})
  const diagnostics=await page?.evaluate(()=>({text:document.body.innerText,status:[...document.querySelectorAll('.kernel-status')].map(e=>({text:e.textContent,title:e.getAttribute('title')}))})).catch(()=>null)
  await writeFile(join(output,'results.json'),JSON.stringify({status:'failed',error:String(error),checks,errors,diagnostics},null,2))
  console.error(JSON.stringify({status:'failed',error:String(error),output}));process.exitCode=1
} finally{await browser?.close();await server.close()}
