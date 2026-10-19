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
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-native-authoring-'))
const snapshot = join(output, 'client')
await mkdir(snapshot, { recursive: true })
for (const name of ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'])
  await cp(join(project, name), join(snapshot, name), { recursive: true })
if (process.env.DESIGN_CANVAS_SOURCE) await cp(process.env.DESIGN_CANVAS_SOURCE, join(snapshot, 'src/Canvas.tsx'))
await symlink(join(project, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
const sourceHashes: Record<string, string> = {}
for (const name of ['Canvas.tsx', 'engine.ts', 'Layers.tsx', 'App.tsx', 'modal-keyboard.ts', 'canvas-pointer-intent.ts', 'selection-hierarchy.ts', 'styles.css', 'PageList.tsx', 'duplicate-graph.ts', 'fields.tsx', 'numeric-expression.ts', 'model.ts', 'Inspector.tsx', 'MixedNumberField.tsx', 'MultiSelectionInspector.tsx', 'selection-colors.ts', 'SelectionColorsPanel.tsx', 'selection-properties.ts', 'kernel/picking.ts', 'generated/design-kernel/design_kernel_bg.wasm'])
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
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 })
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
    const doc=blank('Native option duplicate'),frame=node('frame',60,70,400,250),a=node('rectangle',20.5,30.25,80,60)
    frame.fills=[];frame.children=[a.id];doc.nodes={[frame.id]:frame,[a.id]:a};doc.pages[0].children=[frame.id]
    await fresh(doc);await row(a.id).click();await settle();const before=await stored(),start=await nodePoint(a.id),v=await camera()
    await p.keyboard.down('Alt');await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(start.x+35.25*v.zoom,start.y+12.5*v.zoom,{steps:5});await p.mouse.up();await p.keyboard.up('Alt')
    await expect.poll(async()=>Object.keys((await stored()).nodes).length).toBe(3)
    const d=await stored(),copy=Object.values(d.nodes).find(n=>n.id!==a.id&&n.id!==frame.id)!
    expect(d.nodes[frame.id].children).toContain(copy.id);expect(d.nodes[a.id]).toEqual(before.nodes[a.id])
    expect(copy.transform[4]-a.transform[4]).toBeCloseTo(35.25,9);expect(copy.transform[5]-a.transform[5]).toBeCloseTo(12.5,9)
    await screenshot('01-option-copy');await undo(before);passed('Option copy preserves source and parent, exact fractional displacement, one Undo')
  }
  {
    const {doc,a}=make('Property expressions and scrub');await fresh(doc);await row(a.id).click();await settle()
    const width=p.getByLabel('W',{exact:true});await width.fill('100 + 11 / 16');await width.press('Enter')
    await expect.poll(async()=>(await stored()).nodes[a.id].width).toBe(100.6875)
    const before=await stored(),label=p.getByRole('button',{name:'拖动调整 W',exact:true}),box=(await label.boundingBox())!
    await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.mouse.move(box.x+box.width/2+25,box.y+box.height/2,{steps:5});await p.mouse.up()
    await expect.poll(async()=>(await stored()).nodes[a.id].width).toBe(125.6875)
    await p.getByRole('button',{name:'撤销',exact:true}).click();await expect.poll(async()=>(await stored()).nodes[a.id].width).toBe(before.nodes[a.id].width)
    await screenshot('02-expression-scrub');passed('Property arithmetic and scrub preserve fractional value; scrub Undo is one transaction')
    await width.fill('1/0');await width.press('Enter');await p.getByTitle('添加页面').click()
    expect((await stored()).pages.length).toBe(1)
    await width.press('Escape');await canvas.focus();passed('Invalid arithmetic remains visible and vetoes page creation')
  }
  {
    const {doc,a}=make('No motion property scrub');a.width=100.0625;await fresh(doc);await row(a.id).click();await settle();const before=await record()
    const label=p.getByRole('button',{name:'拖动调整 W',exact:true})
    await label.click();await unmodified(before)
    const box=(await label.boundingBox())!;await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.mouse.move(box.x+box.width/2+20,box.y+box.height/2,{steps:3});await p.keyboard.press('Escape');await p.mouse.up();await unmodified(before)
    passed('No-motion scrub and Escape preserve document and empty history')
  }
  {
    const doc=blank('Deep marquee'),frame=node('frame',60,60,350,250),a=node('rectangle',20,20,40,40),b=node('ellipse',200,100,40,40)
    frame.children=[a.id,b.id];doc.nodes={[frame.id]:frame,[a.id]:a,[b.id]:b};doc.pages[0].children=[frame.id]
    await fresh(doc);const before=await record(),from=await worldPoint(40,40),to=await worldPoint(140,140)
    await p.keyboard.down(mod);await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:5});await p.mouse.up();await p.keyboard.up(mod)
    await selection(a.id);await unmodified(before);await screenshot('03-deep-marquee');passed('Cmd marquee selects nested child without selecting its containing frame')
  }
  {
    const {doc}=make('Page management');await fresh(doc);const before=await stored(),original=before.pages[0].id
    await p.getByLabel(`页面操作：${before.pages[0].name}`,{exact:true}).click();await p.getByRole('menuitem',{name:'复制页面',exact:true}).click()
    await expect.poll(async()=>(await stored()).pages.length).toBe(2)
    const copied=(await stored()).pages[1]
    expect(copied.children.some(id=>before.nodes[id])).toBe(false)
    await p.getByLabel(`页面操作：${copied.name}`,{exact:true}).click();await p.getByRole('menuitem',{name:'页面上移',exact:true}).click()
    await expect.poll(async()=>(await stored()).pages[0].id).toBe(copied.id)
    await p.getByLabel('搜索页面',{exact:true}).fill(copied.name)
    await expect(p.locator('.page-row')).toHaveCount(1)
    await p.getByLabel('搜索页面',{exact:true}).fill('')
    await expect(p.locator('.page-row')).toHaveCount(2)
    await screenshot('04-page-management');passed('Page copy, reorder and search operate on real persisted page identities')
  }
  {
    const {doc}=make('Keyboard camera');await fresh(doc);const before=await record(),view=await camera()
    await canvas.focus();await p.keyboard.press('ArrowRight');await p.keyboard.press('Shift+ArrowDown')
    await expect.poll(async()=>(await camera()).x).toBe(view.x-20)
    await expect.poll(async()=>(await camera()).y).toBe(view.y-100)
    await unmodified(before);passed('Arrow navigation with no selection pans camera without document edits')
  }
  {
    const doc=blank('Flow copy and live modifiers'),frame=node('frame',60,60,420,220),a=node('rectangle',0,0,80,60),b=node('ellipse',0,0,80,60)
    frame.layout={...defaultLayout(),mode:'horizontal'};frame.children=[a.id,b.id]
    doc.nodes={[frame.id]:frame,[a.id]:a,[b.id]:b};doc.pages[0].children=[frame.id]
    await fresh(doc);await row(a.id).click();await settle();const before=await stored(),from=await nodePoint(a.id),to=await worldPoint(430,150)
    await p.keyboard.down('Alt');await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:5})
    await expect.poll(selected).not.toEqual([a.id]);const copied=(await selected())[0]
    await p.keyboard.up('Alt');await selection(a.id)
    await p.keyboard.down('Alt');await selection(copied)
    await p.mouse.up();await p.keyboard.up('Alt')
    await expect.poll(async()=>(await stored()).nodes[frame.id].children.at(-1)).toBe(copied)
    expect((await stored()).nodes[copied].sizing).toEqual(before.nodes[a.id].sizing)
    await undo(before);passed('Auto-layout Option-copy restores flow sizing; stationary modifier changes reuse the same copy; one Undo')
  }
  {
    const doc=blank('Native parametric shapes'),a=node('ellipse',100,100,120,80),b=node('polygon',300,100,120,100)
    a.fills[0].color='#426bdf';b.fills[0].color='#426bdf'
    doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
    await fresh(doc);await row(a.id).click();await settle()
    for (const [label,value] of [['圆弧起始 °','22.5'],['圆弧扫过 °','270'],['圆环内径 %','62.5']]) {
      const field=p.getByLabel(label,{exact:true});await field.fill(value);await field.press('Enter')
    }
    await expect.poll(async()=>(await stored()).nodes[a.id].arc).toEqual({startAngle:Math.PI/8,sweepAngle:Math.PI*1.5,innerRadius:.625})
    await p.getByLabel('锁定宽高比',{exact:true}).check()
    await p.getByLabel('W',{exact:true}).fill('240');await p.getByLabel('W',{exact:true}).press('Enter')
    await expect.poll(async()=>(await stored()).nodes[a.id].height).toBe(160)
    await screenshot('05-native-arc')
    const before=await stored(),handle=p.getByTestId('shape-arcInner-handle'),box=(await handle.boundingBox())!
    await handle.click();await expect.poll(async()=>(await stored()).nodes[a.id]).toEqual(before.nodes[a.id])
    const center=await nodePoint(a.id),dx=box.x+box.width/2-center.x,dy=box.y+box.height/2-center.y
    await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.mouse.move(center.x+dx*.75,center.y+dy*.75,{steps:4});await p.mouse.up()
    await expect.poll(async()=>(await stored()).nodes[a.id].arc!.innerRadius).toBeLessThan(.625)
    await p.getByRole('button',{name:'撤销',exact:true}).click();await expect.poll(async()=>(await stored()).nodes[a.id]).toEqual(before.nodes[a.id])
    await row(b.id).click();await p.getByLabel('顶点圆角',{exact:true}).fill('7.125');await p.getByLabel('顶点圆角',{exact:true}).press('Enter')
    await expect.poll(async()=>(await stored()).nodes[b.id].cornerRadius).toBe(7.125)
    const saved=await stored();expect(saved.schemaVersion).toBe(7)
    const recorded=await p.evaluate(()=>(window as any).__releaseProbe.events);expect(recorded.filter((e:any)=>e.type==='pointerup').length).toBe(8);expect(recorded.every((e:any)=>e.trusted)).toBe(true);await writeFile(join(output,'pointer-events.json'),JSON.stringify(recorded,null,2))
    await p.reload();await settle();await expect.poll(async()=>(await stored()).nodes).toEqual(saved.nodes)
    await row(b.id).click();await expect(p.getByLabel('顶点圆角',{exact:true})).toHaveAttribute('title','7.125')
    await screenshot('06-native-reopen');passed('Native arc/ring/corners, ratio lock, drag/Undo and local reload preserve exact parameters')
  }
  {
    const doc=blank('Mixed expressions and selection colors'),a=node('rectangle',100,100,100,80),b=node('rectangle',300,100,200,80)
    a.fills[0].color='#426bdf';b.fills[0].color='#426bdf';doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
    await fresh(doc);await row(a.id).click();await row(b.id).click({modifiers:['Shift']})
    await p.getByLabel('W',{exact:true}).fill('+=12.5');await p.getByLabel('W',{exact:true}).press('Enter')
    await expect.poll(async()=>{const d=await stored();return [d.nodes[a.id].width,d.nodes[b.id].width]}).toEqual([112.5,212.5])
    await p.getByLabel('选区颜色 1',{exact:true}).fill('#dd6633')
    await expect.poll(async()=>{const d=await stored();return [d.nodes[a.id].fills[0].color,d.nodes[b.id].fills[0].color]}).toEqual(['#dd6633','#dd6633'])
    await screenshot('07-mixed-colors');passed('Mixed arithmetic applies per-layer baselines; selection color changes both actual paints')
  }
  const events=JSON.parse(await readFile(join(output,'pointer-events.json'),'utf8'))
  // Reload starts a new document and resets the event observer; trusted gesture counts are asserted before it.
  expect(checks.length).toBe(10)
  expect(events.every((e:any)=>e.trusted)).toBe(true)
  await writeFile(join(output,'pointer-events.json'),JSON.stringify(events,null,2))
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', scope, sourceHashes, checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', scope, sourceHashes, checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally { await writeFile(join(output, 'vite.log'), log); await browser?.close(); server.kill('SIGTERM') }
