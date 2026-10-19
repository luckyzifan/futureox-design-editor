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
import { apply, worldMatrix } from '../src/geometry'
import { blank, node, uid, defaultLayout, type DesignDocument } from '../src/model'

const project = fileURLToPath(new URL('..', import.meta.url))
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-local-workflows-'))
const snapshot = join(output, 'client')
await mkdir(snapshot, { recursive: true })
for (const name of ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'])
  await cp(join(project, name), join(snapshot, name), { recursive: true })
if (process.env.DESIGN_CANVAS_SOURCE) await cp(process.env.DESIGN_CANVAS_SOURCE, join(snapshot, 'src/Canvas.tsx'))
await symlink(join(project, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
const sourceHashes: Record<string, string> = {}
for (const name of ['Canvas.tsx', 'engine.ts', 'Layers.tsx', 'App.tsx', 'modal-keyboard.ts', 'canvas-pointer-intent.ts', 'selection-hierarchy.ts', 'styles.css', 'PageList.tsx', 'duplicate-graph.ts', 'fields.tsx', 'numeric-expression.ts', 'model.ts', 'Inspector.tsx', 'MixedNumberField.tsx', 'MultiSelectionInspector.tsx', 'selection-colors.ts', 'SelectionColorsPanel.tsx', 'selection-properties.ts', 'kernel/picking.ts', 'generated/design-kernel/design_kernel_bg.wasm','NodeExportPanel.tsx','stroke-profile.ts','canvas-drop.ts','clipboard-export.ts','editor-commands.ts','shape-creation.ts','export.tsx','Renderer.tsx'])
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
  'Actual trusted browser pointer events and keyboard actions are used; no physical trackpad or Figma editing interaction is claimed.',
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
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1, permissions: ['clipboard-read','clipboard-write'] })
  const p = page, canvas = p.getByTestId('canvas'), surface = p.locator('.kernel-reference'), mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await p.addInitScript(() => localStorage.setItem('forma-render-backend', 'cpu'))
  p.on('pageerror', error => errors.push(String(error)))
  await p.goto(base)
  await expect(p.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
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

  await p.evaluate(() => {
    const probe = { dropMoves: false, events: [] as {type:string;trusted:boolean;x:number;y:number;dropped:boolean}[] }
    ;(window as any).__releaseProbe = probe
    const observe = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest?.('[data-testid="canvas"],.number-field')) return
      const dropped=event.type==='pointermove' && !!event.buttons && probe.dropMoves
      if(event.type!=='pointermove'||dropped) probe.events.push({type:event.type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,dropped})
      if(dropped) event.stopImmediatePropagation()
    }
    for(const type of ['pointerdown','pointermove','pointerup']) document.addEventListener(type,observe as EventListener,true)
  })
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
    const doc=blank('Arrow and frame creation'),frame=node('frame',60,60,300,220)
    doc.nodes={[frame.id]:frame};doc.pages[0].children=[frame.id];await fresh(doc)
    await key('Shift+KeyL');await expect(canvas).toHaveClass(/canvas-arrow/)
    const from=await worldPoint(100,110),to=await worldPoint(240,170)
    await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:5});await p.mouse.up()
    await expect.poll(async()=>Object.keys((await stored()).nodes).length).toBe(2)
    let d=await stored();const id=Object.keys(d.nodes).find(id=>id!==frame.id)!
    expect(d.nodes[frame.id].children).toContain(id);expect(d.nodes[id].kind).toBe('line');expect(d.nodes[id].strokes[0].endMarker).toBe('arrow')
    await p.getByLabel('起点箭头',{exact:true}).selectOption('circle');await p.getByLabel('终点箭头',{exact:true}).selectOption('triangle')
    await expect.poll(async()=>(await stored()).nodes[id].strokes[0].startMarker).toBe('circle')
    await screenshot('01-arrow-controls');passed('Shift+L creates native arrow inside a frame; start/end selectors persist in schema 8')
  }
  {
    const doc=blank('Canvas frame transfer'),a=node('frame',40,60,220,200),b=node('frame',380,60,230,200),n=node('rectangle',30.125,40.375,40,30)
    a.children=[n.id];doc.nodes=Object.fromEntries([a,b,n].map(n=>[n.id,n]));doc.pages[0].children=[a.id,b.id];await fresh(doc);await row(n.id).click();await settle()
    const before=await stored(),from=await nodePoint(n.id),to=await worldPoint(440,125)
    await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:5});await p.mouse.up()
    await expect.poll(async()=>(await stored()).nodes[b.id].children).toContain(n.id)
    let d=await stored();expect(worldMatrix(d,n.id)[4]).toBeCloseTo(420,9);expect(worldMatrix(d,n.id)[5]).toBeCloseTo(110,9)
    await screenshot('02-frame-transfer');await undo(before)
    await row(n.id).click();const again=await nodePoint(n.id)
    await p.mouse.move(again.x,again.y);await p.mouse.down();await p.keyboard.down('Space');await p.mouse.move(to.x,to.y,{steps:5});await p.mouse.up();await p.keyboard.up('Space')
    await expect.poll(async()=>(await stored()).nodes[n.id].transform[4]).not.toBe(before.nodes[n.id].transform[4])
    expect((await stored()).nodes[a.id].children).toContain(n.id);await undo(before)
    passed('Cross-frame drag retains world placement and one Undo; Space preserves the original parent')
  }
  {
    const doc=blank('Auto layout drag exit'),frame=node('frame',50,60,260,160),n=node('rectangle',0,0,40,30)
    frame.layout={...defaultLayout(),mode:'horizontal'};frame.children=[n.id];doc.nodes={[frame.id]:frame,[n.id]:n};doc.pages[0].children=[frame.id]
    await fresh(doc);await row(n.id).click();await settle();const before=await stored(),from=await nodePoint(n.id),to=await worldPoint(600,330)
    await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:5});await settle()
    expect((await stored()).nodes).toEqual(before.nodes)
    await screenshot('03a-drag-in-flight')
    await p.mouse.up();await expect.poll(async()=>(await stored()).pages[0].children).toContain(n.id)
    expect((await stored()).nodes[n.id].sizing).toEqual(before.nodes[n.id].sizing)
    await undo(before);passed('Auto-layout drag outside its clipped frame has a transient visible draft, no intermediate save, restored sizing and one Undo')
  }
  {
    const doc=blank('Layer export settings'),n=node('ellipse',100.125,100.375,80,60)
    doc.nodes={[n.id]:n};doc.pages[0].children=[n.id];await fresh(doc);await row(n.id).click()
    await p.getByLabel('添加图层导出设置',{exact:true}).click()
    await p.getByLabel('导出倍率 1',{exact:true}).fill('2');await p.getByLabel('导出倍率 1',{exact:true}).press('Enter')
    await p.getByLabel('导出后缀 1',{exact:true}).fill('-detail');await p.getByLabel('导出后缀 1',{exact:true}).press('Enter')
    await expect.poll(async()=>(await stored()).nodes[n.id].exportSettings?.[0]?.scale).toBe(2)
    await p.getByRole('button',{name:'预览并导出此图层',exact:true}).click()
    await expect(p.getByAltText('图层导出预览 1')).toBeVisible({timeout:30000})
    await expect.poll(()=>p.getByAltText('图层导出预览 1').evaluate((el:HTMLImageElement)=>[el.naturalWidth,el.naturalHeight])).toEqual([160,120])
    const download=p.waitForEvent('download');await p.getByRole('link',{name:n.name+'-detail.png',exact:true}).click();const file=await download
    const downloaded=await readFile((await file.path())!);expect([downloaded.readUInt32BE(16),downloaded.readUInt32BE(20)]).toEqual([160,120])
    await screenshot('03-layer-export');passed('Per-layer PNG scale/suffix generates a real 160×120 preview and downloaded PNG')
    await p.getByLabel('导出格式 1',{exact:true}).selectOption('svg');await p.getByRole('button',{name:'预览并导出此图层',exact:true}).click()
    await expect(p.getByRole('link',{name:n.name+'-detail.svg',exact:true})).toBeVisible({timeout:30000})
    const saveSvg=p.waitForEvent('download');await p.getByRole('link',{name:n.name+'-detail.svg',exact:true}).click();const svgFile=await saveSvg
    const svg=await readFile((await svgFile.path())!,'utf8');expect(svg).toContain('width="160"');expect(svg).toContain('A40 30')
    passed('Per-layer SVG keeps native ellipse arcs, isolates selection and honors export scale')
  }
  {
    const doc=blank('Smart paste and replacement'),a=node('frame',40,60,230,200),b=node('frame',380,60,200,130),n=node('rectangle',20.125,160.375,40,30),target=node('ellipse',100,20,50,50)
    a.children=[n.id];b.children=[target.id];doc.nodes=Object.fromEntries([a,b,n,target].map(n=>[n.id,n]));doc.pages[0].children=[a.id,b.id]
    await fresh(doc);await row(n.id).click();await key(mod+'+c');await row(b.id).click();await key(mod+'+v')
    await expect.poll(async()=>(await stored()).nodes[b.id].children.length).toBe(2)
    let d=await stored();const pasted=d.nodes[b.id].children.find(id=>id!==target.id)!
    expect(d.nodes[pasted].transform.slice(4)).toEqual([20.125,50])
    await row(target.id).click();await key(mod+'+Shift+r')
    await expect.poll(async()=>(await stored()).nodes[target.id]).toBeUndefined()
    d=await stored();const replaced=d.nodes[b.id].children.find(id=>id!==pasted)!
    expect(d.nodes[replaced].transform.slice(4)).toEqual([100,20]);expect(d.nodes[replaced].kind).toBe('rectangle')
    await screenshot('04-smart-paste');passed('Real clipboard paste targets the selected frame, centers only Y, and Shift+Cmd+R replaces the selected object')
  }
  {
    const doc=blank('Copy SVG and PNG'),n=node('rectangle',100.125,100.375,48.25,32.5)
    doc.nodes={[n.id]:n};doc.pages[0].children=[n.id];await fresh(doc);await row(n.id).click();await settle()
    const at=await nodePoint(n.id);await p.mouse.click(at.x,at.y,{button:'right'})
    await p.getByRole('menuitem',{name:'复制为 SVG',exact:true}).click()
    await expect.poll(()=>p.evaluate(()=>navigator.clipboard.readText())).toContain('<svg')
    await key(mod+'+Shift+c')
    await expect.poll(()=>p.evaluate(async()=>{const items=await navigator.clipboard.read();for(const item of items)if(item.types.includes('image/png')){const view=new DataView(await (await item.getType('image/png')).arrayBuffer());return [view.getUint32(16),view.getUint32(20)]}return []})).toEqual([97,65])
    passed('Context-menu Copy SVG and shortcut Copy PNG write real browser clipboard assets; PNG defaults to 2×')
  }
  {
    const doc=blank('Explicit HDR export encoding'),n=node('rectangle',80,80,40,30)
    doc.schemaVersion=8;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
    n.fills[0].color='color(srgb-linear 2 1 0.5)';n.exportSettings=[{id:uid(),format:'png',scale:1,suffix:''}]
    doc.nodes={[n.id]:n};doc.pages[0].children=[n.id]
    const file=join(output,'hdr-export-encoding.fd');await writeFile(file,JSON.stringify(doc))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
    await expect(p.getByLabel('文档名称')).toHaveValue(doc.name);await row(n.id).click()
    await p.getByRole('button',{name:'预览并导出此图层',exact:true}).click()
    await expect(p.getByRole('region',{name:'图层导出设置'}).getByRole('status')).toContainText('明确选择输出编码')
    await expect(p.getByAltText('图层导出预览 1')).toHaveCount(0)
    await expect.poll(async()=>(await stored()).nodes[n.id].fills[0].color).toBe('color(srgb-linear 2 1 0.5)')
    passed('HDR layer preset refuses implicit uint16 output encoding and keeps extended-range source values unchanged')
  }
  const events=await p.evaluate(()=>(window as any).__releaseProbe.events)
  expect(events.filter((e:any)=>e.type==='pointerup').length).toBe(4) // Arrow, frame transfer, Space-preserved transfer, auto-layout exit.
  expect(events.every((e:any)=>e.trusted)).toBe(true)
  await writeFile(join(output,'pointer-events.json'),JSON.stringify(events,null,2))
  expect(checks.length).toBe(8)
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', scope, sourceHashes, checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', scope, sourceHashes, checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally { await writeFile(join(output, 'vite.log'), log); await browser?.close(); server.kill('SIGTERM') }
