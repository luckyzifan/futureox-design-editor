/** Private CPU Chromium acceptance of actual canvas input. Fixtures enter through
 * the real file input; no Editor instance, selection, or pointer handler is injected.
 * IndexedDB and DOM are read only as evidence. A frozen source copy avoids HMR
 * changes from other work during the run. */
import { chromium, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, worldMatrix, multiply, rotate, inverse, around } from '../src/geometry'
import { blank, node, uid, defaultLayout, paint, type DesignDocument } from '../src/model'

const project = fileURLToPath(new URL('..', import.meta.url))
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-canvas-release-'))
// Keep the repo's relative layout. vite.config.ts imports ../design-desktop/scripts,
// that module imports ../../design-client/scripts, the editor imports
// ../../design-mcp and ../../../../design-studio shaders. A folder named `client`
// resolves none of those.
const frontend = join(output, 'frontend')
const snapshot = join(frontend, 'design-client')
await mkdir(snapshot, { recursive: true })
for (const name of ['src', 'public', 'plugins', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'scripts'])
  await cp(join(project, name), join(snapshot, name), { recursive: true })
if (process.env.DESIGN_CANVAS_SOURCE) await cp(process.env.DESIGN_CANVAS_SOURCE, join(snapshot, 'src/Canvas.tsx'))
await symlink(join(project, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
// The desktop bridge now shares versioned Sketch contracts with the web UI.
// Freeze those actual source dependencies alongside the isolated client.
await cp(join(project,'../design-desktop/src'),join(frontend,'design-desktop/src'),{recursive:true})
await cp(join(project,'../design-desktop/scripts'),join(frontend,'design-desktop/scripts'),{recursive:true})
await cp(join(project,'../design-mcp/src'),join(frontend,'design-mcp/src'),{recursive:true})
await symlink(join(project,'../../design-studio'),join(output,'design-studio'),'dir')
const sourceHashes: Record<string, string> = {}
for (const name of ['Canvas.tsx', 'engine.ts', 'Layers.tsx', 'App.tsx', 'modal-keyboard.ts', 'canvas-pointer-intent.ts', 'selection-hierarchy.ts', 'selection-handles.ts', 'canvas-view.ts', 'styles.css'])
  sourceHashes[name] = createHash('sha256').update(await readFile(join(snapshot, 'src', name))).digest('hex')
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(sourceHashes, null, 2))
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: snapshot, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
const errors: string[] = [], checks: { name: string; evidence?: unknown }[] = []
server.stdout.on('data', chunk => { log += String(chunk) }); server.stderr.on('data', chunk => { log += String(chunk) })
const scope = [
  'Actual Playwright mouse/keyboard events against React, Rust WASM CPU reference, and IndexedDB in a private Chromium profile.',
  'Fixtures are imported as portable .fd files through the actual file input; model injection does not stand in for selection or dragging.',
  'No Electron, OS-native keyboard behavior, stylus/trackpad, GPU performance, or exact Figma drag threshold is claimed.',
  'A test-only capture listener intentionally drops held-pointer move delivery; down/up remain trusted Chromium mouse events. This probes missing/coalesced moves, not physical-device timing.',
]
function passed(name: string, evidence?: unknown) { checks.push({ name, ...(evidence === undefined ? {} : { evidence }) }); console.log(`RELEASE_CHECK ${name}`) }

try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite startup timeout')), 20_000)
    const inspect = () => { const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    server.stdout.on('data', inspect); inspect()
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Owned Vite exited ${code}`)) })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-gpu'] })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 })
  const p = page, canvas = p.getByTestId('canvas'), surface = p.locator('.kernel-reference'), mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await p.addInitScript(() => localStorage.setItem('forma-render-backend', 'cpu'))
  p.on('pageerror', error => errors.push(String(error)))
  await p.goto(base)
  await p.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base})
  // The web editor now reports the workspace copy. "已保存到本机" is no longer rendered.
  await expect(p.locator('.save-status')).toHaveText('已自动保存到工作副本', { timeout: 30_000 })
  const record = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())! })
  const stored = async () => (await record()).document as DesignDocument
  const settle = async () => {
    await expect(surface).toHaveAttribute('data-detail-ready', 'true', { timeout: 30_000 })
    await expect(p.locator('canvas[data-frame-visible=true]')).toHaveAttribute('data-renderer', 'cpu')
    await expect(p.locator('.kernel-status.error')).toHaveCount(0)
  }
  const selected = () => p.locator('[role=treeitem][aria-selected=true]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')!.slice(6)).sort())
  const selection = async (...ids: string[]) => expect.poll(selected).toEqual([...ids].sort())
  const row = (id: string) => p.getByTestId(`layer-${id}`)
  const screenshot = async (name: string) => { await settle(); await p.screenshot({ path: join(output, `${name}.png`) }) }
  let sequence = 0
  const fresh = async (document: DesignDocument) => {
    const filename = join(output, `${++sequence}.fd`)
    await writeFile(filename, JSON.stringify(document))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(filename)
    await expect(p.getByLabel('文档名称')).toHaveValue(document.name)
    await expect.poll(async () => (await stored()).name, { timeout: 20_000 }).toBe(document.name)
    await settle(); await canvas.focus()
    await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }
  const nodePoint = async (id: string) => {
    const d = await stored(), n = d.nodes[id], bounds = (await canvas.boundingBox())!
    const world = apply(worldMatrix(d, id), { x: n.width / 2, y: n.height / 2 })
    const view = await surface.evaluate(el => ({ x: Number(el.getAttribute('data-camera-x')), y: Number(el.getAttribute('data-camera-y')), zoom: Number(el.getAttribute('data-camera-zoom')) }))
    return { x: bounds.x + view.x + world.x * view.zoom, y: bounds.y + view.y + world.y * view.zoom }
  }
  const click = async (id: string, modifiers: string[] = [], double = false) => {
    const at = await nodePoint(id)
    for (const key of modifiers) await p.keyboard.down(key)
    if (double) await p.mouse.dblclick(at.x, at.y)
    else await p.mouse.click(at.x, at.y)
    for (const key of [...modifiers].reverse()) await p.keyboard.up(key)
  }
  const key = async (value: string) => { await canvas.focus(); await p.keyboard.press(value) }
  const unmodified = async (before: Awaited<ReturnType<typeof record>>) => {
    await p.waitForTimeout(500) // Beyond the product's 350 ms save debounce.
    const after = await record()
    expect(after.revision).toBe(before.revision)
    expect(after.document).toEqual(before.document)
    await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }
  const undo = async (before: DesignDocument) => {
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => (await stored()).nodes, { timeout: 20_000 }).toEqual(before.nodes)
    await expect.poll(async () => (await stored()).pages).toEqual(before.pages)
    await settle(); await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }

  const observeProbe = () => {
    const probe = { dropMoves: false, events: [] as {type:string;trusted:boolean;x:number;y:number;dropped:boolean}[] }
    ;(window as any).__releaseProbe = probe
    const observe = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest?.('[data-testid="canvas"]')) return
      const dropped=event.type==='pointermove' && !!event.buttons && probe.dropMoves
      if(event.type!=='pointermove'||dropped) probe.events.push({type:event.type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,dropped})
      if(dropped) event.stopImmediatePropagation()
    }
    for(const type of ['pointerdown','pointermove','pointerup']) document.addEventListener(type,observe as EventListener,true)
  }
  await p.addInitScript(observeProbe)
  await p.evaluate(observeProbe)
  const releaseOnly=async(start:{x:number;y:number},end:{x:number;y:number})=>{
    await p.mouse.move(start.x,start.y);await p.mouse.down()
    await p.evaluate(()=>{(window as any).__releaseProbe.dropMoves=true})
    await p.mouse.move(end.x,end.y);await p.mouse.up()
    await p.evaluate(()=>{(window as any).__releaseProbe.dropMoves=false})
  }
  const handle=async(id:string)=>{const b=(await p.getByTestId(id).boundingBox())!;return{x:b.x+b.width/2,y:b.y+b.height/2}}
  const camera=()=>surface.evaluate(el=>({x:Number(el.getAttribute('data-camera-x')),y:Number(el.getAttribute('data-camera-y')),zoom:Number(el.getAttribute('data-camera-zoom'))}))
  const worldPoint=async(x:number,y:number)=>{const b=(await canvas.boundingBox())!,v=await camera();return{x:b.x+v.x+x*v.zoom,y:b.y+v.y+y*v.zoom}}
  const make=(name:string,kind:'rectangle'|'polygon'='rectangle')=>{
    const doc=blank(name),a=node(kind,70,80,100,80),b=node('ellipse',300,80,100,80)
    doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id];return{doc,a,b}
  }
  {
    const {doc,a,b}=make('Move from multiselection gap');await fresh(doc)
    await row(a.id).click();await row(b.id).click({modifiers:[mod]});await selection(a.id,b.id);const before=await stored(),v=await camera()
    const start=await worldPoint(230,100)
    await releaseOnly(start,{x:start.x+30*v.zoom,y:start.y+20*v.zoom})
    await expect.poll(async()=>[(await stored()).nodes[a.id].transform[4],(await stored()).nodes[b.id].transform[4]]).toEqual([100,330])
    await selection(a.id,b.id);await undo(before);passed('Empty space inside a multiselection drags every selected layer in one transaction')
  }
  {
    const {doc,a}=make('Movable rotation origin');await fresh(doc);await row(a.id).click();await settle();const before=await stored(),recordBefore=await record()
    await key('Alt+r');const pivot=await handle('rotation-origin'),target=await worldPoint(a.transform[4],a.transform[5])
    await releaseOnly(pivot,target);await unmodified(recordBefore)
    const anchor=await p.getByTestId('rotate-corner-1').evaluate(el=>({x:Number(el.getAttribute('data-anchor-x')),y:Number(el.getAttribute('data-anchor-y'))})),start=await worldPoint(anchor.x,anchor.y)
    await releaseOnly(start,{x:target.x-(start.y-target.y),y:target.y+(start.x-target.x)})
    await expect.poll(async()=>Math.atan2((await stored()).nodes[a.id].transform[1],(await stored()).nodes[a.id].transform[0])).toBeCloseTo(Math.PI/2,8)
    const after=(await stored()).nodes[a.id];expect(after.transform[4]).toBeCloseTo(a.transform[4],8);expect(after.transform[5]).toBeCloseTo(a.transform[5],8)
    await screenshot('09-custom-rotation-origin');await undo(before);passed('Option+R origin drag is metadata-only; corner rotation keeps the chosen local point fixed')
  }
  for(const modifier of ['Shift','Control']){
    const {doc,a}=make('Locked aspect modifier '+modifier);doc.schemaVersion=7;a.constrainProportions=true
    await fresh(doc);await row(a.id).click();await settle();const before=await stored(),start=await handle('resize-2'),v=await camera()
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.keyboard.down(modifier)
    await p.mouse.move(start.x+40*v.zoom,start.y+10*v.zoom,{steps:4});await p.mouse.up();await p.keyboard.up(modifier)
    await expect.poll(async()=>[(await stored()).nodes[a.id].width,(await stored()).nodes[a.id].height]).toEqual(modifier==='Shift'?[140,112]:[140,90])
    await undo(before);passed(modifier+' applies the documented temporary aspect-ratio rule')
  }
  {
    const {doc,a,b}=make('Option hover measurements');b.transform[4]=190;await fresh(doc);await row(a.id).click();const before=await record(),target=await nodePoint(b.id)
    await p.keyboard.down('Alt');await p.mouse.move(target.x,target.y)
    await expect(p.getByTestId('canvas-measurement').getByText('20',{exact:true})).toBeVisible()
    await p.keyboard.up('Alt');await expect(p.getByTestId('canvas-measurement')).toHaveCount(0);await unmodified(before)
    passed('Option hover measures the geometric edge gap without changing the document')
  }
  {
    const {doc}=make('Zoom area tool');await fresh(doc);const before=await record(),v=await camera()
    await key('z');await expect(canvas).toHaveClass(/canvas-zoom/)
    await releaseOnly(await worldPoint(70,80),await worldPoint(170,160))
    await expect.poll(async()=>(await camera()).zoom).toBeGreaterThan(v.zoom)
    await unmodified(before);passed('Z marquee zoom changes only the camera and creates no undo entry')
  }
  {
    const {doc}=make('Persistent page ruler guides');await fresh(doc)
    if(!await p.getByTestId('horizontal-ruler').count())await key('Shift+r')
    const box=(await canvas.boundingBox())!,v=await camera(),start={x:box.x+200,y:box.y+10},end={x:box.x+200,y:box.y+320}
    await releaseOnly(start,end)
    await expect.poll(async()=>(await stored()).pages[0].guides?.length).toBe(1)
    const first=(await stored()).pages[0].guides![0]
    expect(first.axis).toBe('y');expect(first.position).toBe(Math.round((320-v.y)/v.zoom));expect((await stored()).schemaVersion).toBe(11)
    const guidePoint={x:box.x+450,y:box.y+first.position*v.zoom+v.y},beforeClick=await record()
    await p.mouse.click(guidePoint.x,guidePoint.y);await p.waitForTimeout(500);expect((await record()).revision).toBe(beforeClick.revision)
    await p.keyboard.down('Alt');await releaseOnly(guidePoint,{x:guidePoint.x,y:guidePoint.y+30});await p.keyboard.up('Alt')
    await expect.poll(async()=>(await stored()).pages[0].guides?.length).toBe(2)
    await p.keyboard.press('Delete');await expect.poll(async()=>(await stored()).pages[0].guides?.length).toBe(1)
    await p.reload()
    const resume=p.getByRole('button',{name:/继续编辑/})
    if(await resume.count())await resume.click()
    await settle();expect((await stored()).pages[0].guides).toEqual([first])
    if(!await p.getByTestId('horizontal-ruler').count())await key('Shift+r')
    await expect(p.getByTestId('ruler-guide')).toHaveCount(1);await screenshot('10-persistent-ruler-guide')
    passed('Ruler drag persists schema-11 page guides; click is a no-op, Option duplicates, Delete removes, reload preserves authored position')
  }
  {
    const d=blank('Frame ruler coordinates'),f=node('frame',70,80,240,160);d.nodes[f.id]=f;d.pages[0].children=[f.id]
    await fresh(d);await row(f.id).click();await settle();if(!await p.getByTestId('horizontal-ruler').count())await key('Shift+r')
    const box=(await canvas.boundingBox())!,end=await worldPoint(190,120)
    await releaseOnly({x:box.x+200,y:box.y+10},end)
    await expect.poll(async()=>(await stored()).nodes[f.id].guides?.[0]?.position).toBe(40)
    expect((await stored()).pages[0].guides||[]).toEqual([])
    await expect(p.getByTestId('ruler-guide')).toHaveAttribute('data-owner-id',f.id)
    passed('Guides created with a frame selected use and persist its local coordinate system')
  }
  {
    const d=blank('Smart spacing and reorder'),ns=[node('rectangle',70,80,60,60),node('rectangle',150,80,60,60),node('rectangle',230,80,60,60)]
    d.nodes=Object.fromEntries(ns.map(n=>[n.id,n]));d.pages[0].children=ns.map(n=>n.id)
    await fresh(d);await key(`${mod}+a`);await settle();const before=await stored(),v=await camera()
    const h=p.getByTestId('smart-gap-x').first(),b=(await h.boundingBox())!,start={x:b.x+b.width/2,y:b.y+b.height/2}
    await releaseOnly(start,{x:start.x+20*v.zoom,y:start.y})
    await expect.poll(async()=>{const d=await stored();return ns.map(n=>d.nodes[n.id].transform[4])}).toEqual([70,170,270])
    await screenshot('11-smart-spacing');await undo(before)
    const from=(await p.getByTestId('smart-reorder').first().boundingBox())!,to=(await p.getByTestId('smart-reorder').last().boundingBox())!
    await releaseOnly({x:from.x+from.width/2,y:from.y+from.height/2},{x:to.x+to.width/2,y:to.y+to.height/2})
    await expect.poll(async()=>{const d=await stored();return ns.map(n=>d.nodes[n.id].transform[4])}).toEqual([230,70,150])
    expect((await stored()).pages[0].children).toEqual(before.pages[0].children);await undo(before)
    passed('Smart selection spacing and centre-handle reorder use trusted release input, preserve hierarchy and undo exactly')
  }
  {
    const d=blank('Auto layout on-canvas handles'),f=node('frame',70,80,300,150),a=node('rectangle',0,0,60,60),b=node('ellipse',0,0,60,60)
    f.layout={...defaultLayout(),gap:20,padding:[20,20,20,20]};f.children=[a.id,b.id];d.nodes={[f.id]:f,[a.id]:a,[b.id]:b};d.pages[0].children=[f.id]
    await fresh(d);await row(f.id).click();await settle();const before=await stored(),v=await camera(),start=await handle('layout-handle-top')
    await p.keyboard.down('Alt');await p.keyboard.down('Shift');await releaseOnly(start,{x:start.x,y:start.y+12*v.zoom});await p.keyboard.up('Shift');await p.keyboard.up('Alt')
    await expect.poll(async()=>(await stored()).nodes[f.id].layout!.padding).toEqual([32,32,32,32]);await undo(before)
    const gap=await handle('layout-handle-x-0');await releaseOnly(gap,{x:gap.x+15*v.zoom,y:gap.y})
    await expect.poll(async()=>(await stored()).nodes[f.id].layout!.gap).toBe(35)
    await screenshot('12-layout-spacing');await undo(before)
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(start.x,start.y+15);await p.keyboard.press('Escape');await p.mouse.up()
    await expect.poll(async()=>(await stored()).nodes).toEqual(before.nodes)
    passed('On-canvas layout padding supports Option+Shift all sides, gap changes flow positions, release-only input and Escape remain atomic')
  }
  {
    const {doc,a,b}=make('System property clipboard');doc.nodes[a.id].fills=[paint('#b531f7')];doc.nodes[a.id].opacity=.65
    await fresh(doc);await row(a.id).click();await key(`${mod}+Alt+c`);await row(b.id).click();const before=await stored()
    await key(`${mod}+Alt+v`)
    await expect.poll(async()=>(await stored()).nodes[b.id].fills[0].color).toBe('#b531f7')
    expect((await stored()).nodes[b.id].transform).toEqual(before.nodes[b.id].transform);expect((await stored()).nodes[b.id].opacity).toBe(.65)
    await undo(before);passed('Option+Command copy/paste properties transfers appearance through the actual system clipboard without changing geometry')
  }
  {
    const {doc,b}=make('Navigation without minimap');doc.nodes[b.id].transform[4]=5000;await fresh(doc);await key(`${mod}+0`);await settle()
    const before=await record(),v=await camera();await expect(p.getByTestId('canvas-minimap')).toHaveCount(0)
    const canvas=p.getByTestId('canvas'),box=(await canvas.boundingBox())!
    await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.wheel(120,80)
    await expect.poll(async()=>(await camera()).x).not.toBe(v.x);await unmodified(before)
    await expect(p.getByText('显示缩略导航',{exact:true})).toHaveCount(0)
    passed('Main canvas wheel navigation works without a minimap, preserves document and history, and exposes no minimap setting')
  }
  {
    const {doc,a}=make('Pointer release resize');await fresh(doc);await row(a.id).click();await settle()
    const before=await stored(),start=await handle('resize-2'),v=await camera()
    await releaseOnly(start,{x:start.x+40*v.zoom,y:start.y+20*v.zoom})
    await expect.poll(async()=>[(await stored()).nodes[a.id].width,(await stored()).nodes[a.id].height]).toEqual([140,100])
    await screenshot('01-release-resize');await undo(before);passed('Resize uses release-only final position and one undo transaction')
  }
  {
    const {doc,a}=make('Pointer release rotate');await fresh(doc);await row(a.id).click();await settle()
    const before=await stored(),h=await p.getByTestId('rotate-corner-1').evaluate(el=>({x:Number(el.getAttribute('data-anchor-x')),y:Number(el.getAttribute('data-anchor-y'))})),start=await worldPoint(h.x,h.y),center=await nodePoint(a.id)
    await releaseOnly(start,{x:center.x-(start.y-center.y),y:center.y+(start.x-center.x)})
    await expect.poll(async()=>Math.atan2((await stored()).nodes[a.id].transform[1],(await stored()).nodes[a.id].transform[0])).toBeCloseTo(Math.PI/2,9)
    await screenshot('02-release-rotate');await undo(before);passed('Rotate uses release-only angle')
  }
  {
    const doc=blank('Nested rotated reflected parent'),parent=node('group',70,80,250,180),a=node('rectangle',40,35,100,80)
    parent.fills=[];parent.children=[a.id];parent.transform=multiply([1,0,0,1,340,90],multiply(rotate(29),[-1.4,0.15,0.2,0.8,0,0]))
    a.transform=multiply(a.transform,rotate(-17));doc.nodes={[parent.id]:parent,[a.id]:a};doc.pages[0].children=[parent.id]
    await fresh(doc);await row(a.id).click();await settle();const before=await stored(),recordBefore=await record()
    const h=await p.getByTestId('rotate-corner-2').evaluate(el=>({x:Number(el.getAttribute('data-anchor-x')),y:Number(el.getAttribute('data-anchor-y'))})),start=await worldPoint(h.x,h.y),c=await nodePoint(a.id)
    await p.mouse.move(start.x,start.y);await p.mouse.click(start.x,start.y);await unmodified(recordBefore)
    const degrees=38,r=degrees*Math.PI/180,end={x:c.x+(start.x-c.x)*Math.cos(r)-(start.y-c.y)*Math.sin(r),y:c.y+(start.x-c.x)*Math.sin(r)+(start.y-c.y)*Math.cos(r)}
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:10});await p.mouse.up()
    await expect.poll(async()=>JSON.stringify((await stored()).nodes[a.id].transform)).not.toBe(JSON.stringify(before.nodes[a.id].transform))
    // Chromium's input transport rounds screen coordinates to float32. Derive
    // the oracle from the actual trusted events, not the pre-transport request.
    const native=await p.evaluate(()=>{const events=(window as any).__releaseProbe.events;return{down:events.findLast((e:any)=>e.type==='pointerdown'),up:events.findLast((e:any)=>e.type==='pointerup')}})
    const actualDegrees=(Math.atan2(native.up.y-c.y,native.up.x-c.x)-Math.atan2(native.down.y-c.y,native.down.x-c.x))*180/Math.PI
    const after=await stored(),world=worldMatrix(before,a.id),middle=apply(world,{x:a.width/2,y:a.height/2}),expected=multiply(inverse(worldMatrix(before,parent.id)),multiply(around(middle,rotate(actualDegrees)),world))
    for(let i=0;i<6;i++)expect(after.nodes[a.id].transform[i]).toBeCloseTo(expected[i],8)
    expect(after.nodes[parent.id]).toEqual(before.nodes[parent.id]);expect(after.nodes[a.id].width).toBe(a.width);expect(after.nodes[a.id].height).toBe(a.height)
    await screenshot('08-nested-reflected-rotation');await undo(before)
    passed('Nested reflected/nonuniform parent rotation preserves all six child matrix values, dimensions and parent; one undo restores exact authored values')
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(end.x,end.y,{steps:4});await p.keyboard.press('Escape');await p.mouse.up()
    await expect.poll(async()=>(await stored()).nodes).toEqual(before.nodes);await expect(p.getByRole('button',{name:'撤销',exact:true})).toBeDisabled()
    passed('Escape cancels a held corner rotation without committing a history entry')
  }
  {
    const {doc,a}=make('Pointer release polygon','polygon');await fresh(doc);await row(a.id).click();await settle()
    const before=await stored(),start=await handle('shape-points-handle')
    await releaseOnly(start,{x:start.x,y:start.y-36})
    await expect.poll(async()=>(await stored()).nodes[a.id].points).toBe(a.points+3)
    await screenshot('03-release-polygon');await undo(before);passed('Polygon commits release-only point-count change')
  }
  {
    const {doc,a,b}=make('Pointer release marquee');await fresh(doc);const before=await record()
    await releaseOnly(await worldPoint(50,60),await worldPoint(420,180))
    await selection(a.id,b.id);await unmodified(before);await screenshot('04-release-marquee')
    passed('Marquee uses final coordinates without stale React rubber-band state')
  }
  {
    const {doc}=make('Pointer release pan');await fresh(doc);const before=await record(),v=await camera(),start=await worldPoint(200,240)
    await canvas.focus();await p.keyboard.down('Space');await releaseOnly(start,{x:start.x+37.5,y:start.y-12.25});await p.keyboard.up('Space')
    await expect.poll(async()=>(await camera()).x).toBeCloseTo(v.x+37.5,9)
    await expect.poll(async()=>(await camera()).y).toBeCloseTo(v.y-12.25,9)
    await unmodified(before);await screenshot('05-release-pan');passed('Pan uses release-only displacement without document history')
  }
  {
    const doc=blank('Modifier-only fractional frame resize'),a=node('frame',70,80,100.25,80.25)
    doc.nodes={[a.id]:a};doc.pages[0].children=[a.id]
    await fresh(doc);await row(a.id).click();await settle();const before=await record(),start=await handle('resize-2')
    await p.mouse.move(start.x,start.y);await p.mouse.down();await p.keyboard.down('Shift');await p.mouse.up();await p.keyboard.up('Shift')
    await unmodified(before);passed('Modifier-only release preserves fractional frame geometry and empty history')
  }
  {
    const {doc,a}=make('No motion resize');await fresh(doc);await row(a.id).click();const before=await record()
    await p.getByTestId('resize-2').click();await unmodified(before);passed('No-motion handle click preserves exact document and undo stack')
  }
  {
    const {doc,b}=make('Pointer release vector anchor');await fresh(doc);await row(b.id).click();await canvas.focus()
    await p.keyboard.press('Enter')
    await expect(p.getByTestId('vector-anchor')).toHaveCount(4)
    const entered=await stored()
    expect(entered.nodes[b.id].kind).toBe('ellipse')
    expect(entered.nodes[b.id].network).toBeUndefined()
    await expect(p.getByRole('button',{name:'撤销',exact:true})).toBeDisabled()
    await expect(canvas).toHaveClass(/canvas-vector/)
    const before=await stored(),anchor=p.getByTestId('vector-anchor').first(),box=(await anchor.boundingBox())!,v=await camera()
    const start={x:box.x+box.width/2,y:box.y+box.height/2}
    await releaseOnly(start,{x:start.x+20*v.zoom,y:start.y})
    await expect.poll(async()=>(await stored()).nodes[b.id].kind).toBe('vector')
    expect((await stored()).nodes[b.id].network?.vertices.length).toBeGreaterThan(0)
    await screenshot('06-release-vector-anchor');await undo(before)
    expect((await stored()).nodes[b.id].kind).toBe('ellipse')
    expect((await stored()).nodes[b.id].network).toBeUndefined()
    await p.keyboard.press('Escape')
    await expect(p.getByTestId('vector-anchor')).toHaveCount(0)
    await click(b.id,[],true)
    await expect(p.getByTestId('vector-anchor')).toHaveCount(4)
    expect((await stored()).nodes[b.id].kind).toBe('ellipse')
    passed('Ellipse Enter and double-click show four anchors; one release drag undoes to the original arc')
  }
  {
    const {doc,a}=make('Rectangle outline entry');await fresh(doc);await row(a.id).click();await canvas.focus()
    const clean=await record()
    await click(a.id,[],true)
    await expect(p.getByTestId('vector-anchor')).toHaveCount(4)
    expect((await stored()).nodes[a.id].kind).toBe('rectangle')
    expect((await stored()).nodes[a.id].network).toBeUndefined()
    await p.keyboard.press('Escape');await expect(p.getByTestId('vector-anchor')).toHaveCount(0)
    await unmodified(clean)
    await canvas.focus();await p.keyboard.press('Enter')
    await expect(p.getByTestId('vector-anchor')).toHaveCount(4)
    const before=await stored(),anchor=p.getByTestId('vector-anchor').first(),box=(await anchor.boundingBox())!,v=await camera()
    const start={x:box.x+box.width/2,y:box.y+box.height/2}
    await releaseOnly(start,{x:start.x+18*v.zoom,y:start.y})
    await expect.poll(async()=>(await stored()).nodes[a.id].kind).toBe('vector')
    expect((await stored()).nodes[a.id].network?.vertices).toHaveLength(4)
    await undo(before)
    expect((await stored()).nodes[a.id].kind).toBe('rectangle')
    expect((await stored()).nodes[a.id].network).toBeUndefined()
    passed('Rectangle double-click and Enter show four anchors; one release drag undoes to the original rectangle')
  }
  {
    const doc=blank('Network enter outline'),path=node('vector',80,240,120,40)
    path.network={vertices:[{id:'a',x:0,y:0},{id:'b',x:120,y:40}],edges:[{id:'e',from:'a',to:'b'}],fillRule:'nonzero'}
    doc.nodes[path.id]=path;doc.pages[0].children=[path.id]
    await fresh(doc);await row(path.id).click();await canvas.focus();const clean=await record()
    await p.keyboard.press('Enter')
    await expect(p.getByTestId('vector-anchor')).toHaveCount(2)
    expect((await stored()).nodes[path.id].network?.vertices).toEqual(path.network.vertices)
    await unmodified(clean)
    const before=await stored(),anchor=p.getByTestId('vector-anchor').first(),box=(await anchor.boundingBox())!,v=await camera()
    const start={x:box.x+box.width/2,y:box.y+box.height/2}
    await releaseOnly(start,{x:start.x+14*v.zoom,y:start.y+6*v.zoom})
    await expect.poll(async()=>(await stored()).nodes[path.id].network?.vertices[0]).not.toEqual(before.nodes[path.id].network!.vertices[0])
    await undo(before)
    expect((await stored()).nodes[path.id].network).toEqual(before.nodes[path.id].network)
    await p.keyboard.press('Escape');await expect(p.getByTestId('vector-anchor')).toHaveCount(0)
    const at=await worldPoint(path.transform[4],path.transform[5])
    await p.mouse.dblclick(at.x,at.y)
    await expect(p.getByTestId('vector-anchor')).toHaveCount(2)
    expect((await stored()).nodes[path.id].network).toEqual(before.nodes[path.id].network)
    passed('Network Enter and double-click show both anchors; one release drag undoes to the original vertices')
  }
  {
    const {doc}=make('Pointer release pen tangent');await fresh(doc);const before=await stored(),ids=new Set(Object.keys(before.nodes))
    await canvas.focus();await p.keyboard.press('p');await expect(canvas).toHaveClass(/canvas-pen/)
    const a=await worldPoint(100,280),b=await worldPoint(200,280),c=await worldPoint(220,310)
    await p.mouse.click(a.x,a.y);await releaseOnly(b,c);await p.keyboard.press('Enter')
    await expect.poll(async()=>Object.keys((await stored()).nodes).length).toBe(ids.size+1)
    const d=await stored(),created=Object.values(d.nodes).find(n=>!ids.has(n.id))!,control=created.network?.edges[0].c2
    expect(control).toBeDefined();const world=apply(worldMatrix(d,created.id),control!)
    expect(world.x).toBeCloseTo(180,9);expect(world.y).toBeCloseTo(250,9)
    await screenshot('07-release-pen-tangent');await undo(before)
    passed('Pen tangent captures release-only drag rather than silently committing a straight segment')
  }
  const events=await p.evaluate(()=>(window as any).__releaseProbe.events)
  expect(events.filter((e:any)=>e.type==='pointerup').length).toBeGreaterThan(5)
  expect(events.some((e:any)=>e.dropped)).toBe(true);expect(events.every((e:any)=>e.trusted)).toBe(true)
  await writeFile(join(output,'pointer-events.json'),JSON.stringify(events,null,2))
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', scope, sourceHashes, checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', scope, sourceHashes, checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally { await writeFile(join(output, 'vite.log'), log); await browser?.close(); server.kill('SIGTERM') }
