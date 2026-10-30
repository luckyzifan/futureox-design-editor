/** Exact tile cache regression. Each run snapshots current sources and reads the
 * prior worker from a pinned local Git commit; it never modifies application src.
 * See testing/review/.../exact-revision-cache/README.md for phases and boundaries. */
import { chromium } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(project, '../..')
const phase = process.env.DESIGN_CACHE_PHASE || 'guards'
if (!['guards', 'extended', 'cancel', 'eviction', 'quick-perf', 'hdr', 'all'].includes(phase))
  throw new Error('Unknown DESIGN_CACHE_PHASE')
const output = resolve(process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-exact-cache-')))
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw new Error('Use a new or empty DESIGN_TEST_OUTPUT; existing evidence is not overwritten')
const snapshot = join(output, 'snapshot')
const root = join(snapshot, 'frontend/design-client')
await mkdir(root, { recursive: true })
for (const name of ['src', 'public', 'gpu-check.html', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'])
  await cp(join(project, name), join(root, name), { recursive: true })
await cp(join(repository, 'design-studio/crates/design-kernel/shaders'), join(snapshot, 'design-studio/crates/design-kernel/shaders'), { recursive: true })
await cp(join(repository, 'testing/fixtures/design'), join(snapshot, 'testing/fixtures/design'), { recursive: true })
await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
const baseline = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.env.DESIGN_CACHE_BASELINE_REF || '1abb871946164501fa93c0d929ec0dba9d022291'}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
for (const [source, target] of [['render-worker.ts', 'render-worker-baseline.ts'], ['client.ts', 'client-baseline.ts']]) {
  let code = execFileSync('git', ['show', `${baseline}:frontend/design-client/src/kernel/${source}`], { cwd: repository, encoding: 'utf8' })
  if (source === 'client.ts') {
    const originalWorkerUrl = "new URL('./render-worker.ts', import.meta.url)"
    if (code.split(originalWorkerUrl).length !== 2)
      throw new Error('Baseline client Worker URL must match the expected adapter exactly once')
    code = code.replace(originalWorkerUrl, "new URL('./render-worker-baseline.ts', import.meta.url)")
  }
  await writeFile(join(root, 'src/kernel', target), code)
}
// Preflight every literal browser import even in prepare-only mode. This catches
// stale temporary module names before a browser can turn them into 404 responses.
const runnerSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
const browserModules = [...new Set([...runnerSource.matchAll(/import\(['"](\/src\/[^'"]+)['"]\)/g)].map((match) => match[1]))]
const moduleChecks: { module: string; exists: boolean }[] = []
for (const module of [...browserModules, '/src/kernel/render-worker-baseline.ts']) {
  try { await readFile(join(root, module.slice(1))); moduleChecks.push({ module, exists: true }) }
  catch { moduleChecks.push({ module, exists: false }) }
}
const baselineClient = await readFile(join(root, 'src/kernel/client-baseline.ts'), 'utf8')
const baselineWorkerCorrect = baselineClient.includes("new URL('./render-worker-baseline.ts', import.meta.url)") &&
  !baselineClient.includes("new URL('./render-worker.ts', import.meta.url)")
await writeFile(join(output, 'module-paths.json'), JSON.stringify({ moduleChecks, baselineWorkerCorrect }, null, 2))
if (!baselineWorkerCorrect || moduleChecks.some((entry) => !entry.exists))
  throw new Error('Snapshot browser module/Worker preflight failed: ' + moduleChecks.filter((entry) => !entry.exists).map((entry) => entry.module).join(', '))
const fixturePath = resolve(process.env.DESIGN_CACHE_FIXTURE || join(repository, 'testing/review/design-desktop-macos-gui-2026-10-10/hdr-performance/combined-fixture.forma'))
const fixtureBytes = await readFile(fixturePath)
const fixture = JSON.parse(fixtureBytes.toString('utf8'))
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const explicitFonts = [process.env.DESIGN_CACHE_FONT_A, process.env.DESIGN_CACHE_FONT_B]
if (explicitFonts.some(Boolean) && !explicitFonts.every(Boolean)) throw new Error('Supply both DESIGN_CACHE_FONT_A and DESIGN_CACHE_FONT_B')
const fontPaths = explicitFonts.every(Boolean) ? explicitFonts as string[] : process.platform === 'darwin'
  ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Courier New.ttf'] : []
const fonts: { path: string; data: string; sha256: string }[] = []
let fontSkipReason: string | undefined
if (phase === 'extended' || phase === 'all') {
  try {
    for (const path of fontPaths) {
      const bytes = await readFile(path)
      fonts.push({ path, data: bytes.toString('base64'), sha256: digest(bytes) })
    }
    if (fonts.length !== 2) fontSkipReason = 'Set two local font paths to exercise the optional real font-byte replacement case on this platform.'
  } catch (error) {
    if (explicitFonts.every(Boolean)) throw error
    fonts.length = 0
    fontSkipReason = 'Default macOS font resources are unavailable; set DESIGN_CACHE_FONT_A and DESIGN_CACHE_FONT_B.'
  }
}
await writeFile(join(output, 'font-identities.json'), JSON.stringify({ fonts: fonts.map(({ path, sha256 }) => ({ path, sha256 })), skipped: fontSkipReason || null }, null, 2))
const hashes: Record<string, string> = {}
for (const folder of ['src', 'public/kernel', 'public/fonts']) {
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) hashes[relative(root, path)] = digest(await readFile(path))
    }
  }
  await visit(join(root, folder))
}
for (const name of await readdir(join(snapshot, 'design-studio/crates/design-kernel/shaders')))
  hashes[`shaders/${name}`] = digest(await readFile(join(snapshot, 'design-studio/crates/design-kernel/shaders', name)))
hashes['runner'] = digest(await readFile(fileURLToPath(import.meta.url)))
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2))
await writeFile(join(output, 'run.json'), JSON.stringify({ phase, baseline, fixture: relative(repository, fixturePath), fixtureSha256: digest(fixtureBytes), platform: process.platform, node: process.version, sourceManifestSha256: digest(JSON.stringify(hashes, null, 2)), prepareOnly: process.env.DESIGN_CACHE_PREPARE_ONLY === '1' }, null, 2))
console.log(JSON.stringify({ output, phase, baseline, fontSkipReason }))
if (process.env.DESIGN_CACHE_PREPARE_ONLY === '1') process.exit(0)
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
const errors: string[] = []
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try{
 const base=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite startup timeout')),20000);server.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0])}});server.once('exit',c=>reject(Error('Vite exited '+c)))})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]})
 const page=await browser.newPage()
 page.on('pageerror',(e:any)=>errors.push(String(e)))
 page.on('console',(m:any)=>{if(m.type()==='error')errors.push(m.text())})
 const progress:any[]=[]
 await page.exposeFunction('recordRevision',(r:any)=>{progress.push(r);console.log(JSON.stringify(r));return writeFile(join(output,'progress.json'),JSON.stringify(progress,null,2))})
 await page.goto(base+'/gpu-check.html')
 const result=await page.evaluate(async({fixture,phase,fonts,fontSkipReason})=>{
  const {KernelClient}=await import('/src/kernel/client.ts')
  const {KernelClient:OriginalClient}=await import('/src/kernel/client-baseline.ts')
  const {planTiles,devicePixelPhase}=await import('/src/kernel/tile-cache.ts')
  const {blank,node}=await import('/src/model.ts')
  const {defaultColorSettings}=await import('/src/color.ts')
  const results:any[]=[]
  const record=async(r:any)=>{results.push(r);await (window as any).recordRevision(r)}
  function difference(a:Uint8Array|Uint32Array,b:Uint8Array|Uint32Array){
   if(a.length!==b.length)throw Error('Different pixel dimensions')
   let count=0,first=-1
   for(let i=0;i<a.length;i++)if(a[i]!==b[i]){count++;if(first<0)first=i}
   return{count,first}
  }
  async function render(c:any,d:any,options:any,debug?:any){
   const tiles=new Map<string,any>(),started=performance.now()
   const stats=await c.render(d,options,false,'webgpu',true,false,debug,(t:any)=>{
    if(t.backend!=='webgpu')throw Error('Unexpected backend '+t.backend)
    if(tiles.has(t.key))throw Error('Duplicate tile '+t.key)
    if(t.bytes.length!==t.width*t.height*4||t.linear?.length!==t.width*t.height*4)throw Error('Wrong managed pixel buffers')
    tiles.set(t.key,t)
   })
   const elapsed=performance.now()-started
   if(stats.backend!=='webgpu'||tiles.size!==options.tileViewport.length)throw Error('Incomplete real GPU frame')
   if(stats.tileCacheBytes>128*1024*1024)throw Error('Cache exceeds 128 MiB')
   return{tiles,stats,elapsed}
  }
  function compare(a:any,b:any,options:any){
   let byteViolations=0,floatBitViolations=0
   const pixels=options.width*options.height*4
   const assembledA=new Uint32Array(pixels),assembledB=new Uint32Array(pixels)
   const rgbaA=new Uint8Array(pixels),rgbaB=new Uint8Array(pixels)
   for(const descriptor of options.tileViewport){
    const ta=a.tiles.get(descriptor.key),tb=b.tiles.get(descriptor.key)
    if(!ta||!tb)throw Error('Missing tile')
    byteViolations+=difference(ta.bytes,tb.bytes).count
    const fa=new Uint32Array(ta.linear.buffer,ta.linear.byteOffset,ta.linear.length),fb=new Uint32Array(tb.linear.buffer,tb.linear.byteOffset,tb.linear.length)
    floatBitViolations+=difference(fa,fb).count
    const ox=ta.x+Math.floor(options.view.x),oy=ta.y+Math.floor(options.view.y)
    for(let y=Math.max(0,-oy);y<Math.min(ta.height,options.height-oy);y++){
     const x0=Math.max(0,-ox),x1=Math.min(ta.width,options.width-ox)
     if(x1<=x0)continue
     const start=(y*ta.width+x0)*4,end=(y*ta.width+x1)*4,to=((y+oy)*options.width+x0+ox)*4
     assembledA.set(fa.subarray(start,end),to);assembledB.set(fb.subarray(start,end),to)
     rgbaA.set(ta.bytes.subarray(start,end),to);rgbaB.set(tb.bytes.subarray(start,end),to)
    }
   }
   const assembledFloatBitViolations=difference(assembledA,assembledB).count,assembledByteViolations=difference(rgbaA,rgbaB).count
   if(byteViolations||floatBitViolations||assembledFloatBitViolations||assembledByteViolations)throw Error('Cross revision pixel mismatch '+JSON.stringify({byteViolations,floatBitViolations,assembledFloatBitViolations,assembledByteViolations}))
   return{byteViolations,floatBitViolations,assembledFloatBitViolations,assembledByteViolations}
  }
  const metrics=(r:any)=>({cacheEvictions:r.stats.tileCacheEvictions,previewLeaves:r.stats.previewLeaves,injectedBudgetFailures:r.stats.injectedBudgetFailures,elapsed:r.elapsed,hits:r.stats.tileCacheHits,rendered:r.stats.previewTiles,cacheBytes:r.stats.tileCacheBytes,compileMs:r.stats.compileMs,graphMs:r.stats.graphMs,checkpointMs:r.stats.checkpointMs,finishMs:r.stats.finishMs,peakTextureBytes:r.stats.peakTextureBytes})
  if(phase==='cancel'||phase==='all'){
  const {KernelClient}=await import('/src/kernel/client.ts'),{blank,node}=await import('/src/model.ts'),{defaultColorSettings}=await import('/src/color.ts')
  const d=blank('all hit cancellation');d.schemaVersion=3;d.colorManagement=defaultColorSettings();d.rasterProfile='figma';const n=node('rectangle',4,5,24,22);d.nodes[n.id]=n;d.pages[0].children=[n.id]
  const tiles=Array.from({length:128},(_,i)=>({key:'t'+i,x:(i%32)*64,y:Math.floor(i/32)*64,width:64,height:64,zoom:1,phaseX:0,phaseY:0}))
  const options={pageId:d.pages[0].id,width:2048,height:256,view:{x:0,y:0,zoom:1},transparent:false,grid:false,rasterProfile:'figma',tileViewport:tiles,tileOwner:{documentId:d.id,sessionEpoch:1}}
  const c=new KernelClient()
  try{
   const warm=await c.render(d,options,false,'webgpu',true,false,undefined,()=>{})
   const next={...d,nodes:{...d.nodes,[n.id]:{...n,name:'renamed while preserving every pixel'}}},worker=(c as any).worker,id=(c as any).next+1
   let delivered=0,rawTiles=0,rawCached=0,afterCancelDelivered=0,cancelled=false
   const rawFinal=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing raw worker final')),10000);const listener=(e:any)=>{if(e.data.id!==id)return;if(e.data.tile){rawTiles++;if(e.data.tile.cached)rawCached++}else{clearTimeout(timer);worker.removeEventListener('message',listener);resolve(e.data)}};worker.addEventListener('message',listener)})
   try{await c.render(next,options,false,'webgpu',true,false,undefined,()=>{delivered++;if(delivered===1)c.cancelPreview();else afterCancelDelivered++})}catch(e){cancelled=String(e).includes('PREVIEW_CANCELLED')}
   const final=await rawFinal
   const row={kind:'cancel',name:'all-hit-first-progress-cancel',warmTiles:warm.previewTiles,warmBytes:warm.tileCacheBytes,requestedTiles:tiles.length,delivered,afterCancelDelivered,rawTiles,rawCached,cancelled,workerError:final.error||null,passed:cancelled&&afterCancelDelivered===0&&rawTiles<tiles.length&&rawCached===rawTiles&&String(final.error).includes('PREVIEW_CANCELLED')};await record(row);if(!row.passed)throw Error('All-hit cancellation regression')
  }finally{c.dispose()}
  }
  if(phase==='guards'||phase==='all'){
   const d=blank('exact cache owner guards');d.schemaVersion=3;d.colorManagement=defaultColorSettings();d.rasterProfile='figma'
   const n=node('rectangle',8.25,7.5,33.5,25.75);n.fills[0].color='#bb6633';d.nodes[n.id]=n;d.pages[0].children=[n.id]
   const c=new KernelClient(),off=new OriginalClient(),tile={key:'probe',x:0,y:0,width:64,height:64,zoom:1,phaseX:0,phaseY:0}
   const options={pageId:d.pages[0].id,width:64,height:64,view:{x:0,y:0,zoom:1},grid:false,transparent:false,rasterProfile:'figma',tileViewport:[tile]}
   let current=d
   const withName=(name:string)=>({...current,nodes:{...current.nodes,[n.id]:{...current.nodes[n.id],name}}})
   async function probe(name:string,next:any,owner:any,expectedHits:number,custom:any={}){
    current=next
    const o={...options,...custom},a=await render(c,current,{...o,...(owner?{tileOwner:{documentId:current.id,sessionEpoch:owner}}:{})}),b=await render(off,current,o)
    if(a.stats.tileCacheHits!==expectedHits)throw Error(name+' expected hits '+expectedHits+' got '+a.stats.tileCacheHits)
    await record({kind:'guard',name,on:metrics(a),off:metrics(b),...compare(a,b,o)})
   }
   try{
    await probe('baseline-owner-1',current,1,0)
    await probe('node-name-same-owner',withName('name1'),1,1)
    await probe('same-document-new-owner',withName('name2'),2,0)
    await probe('missing-owner-new-revision',withName('name3'),undefined,0)
    await probe('missing-owner-second-revision',withName('name4'),undefined,0)
    await probe('owner-restored',withName('name5'),2,0)
    await probe('font-registry-updated', {...current,fonts:{}},2,0)
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d')!
    const uri=(color:string)=>{context.fillStyle=color;context.fillRect(0,0,2,2);return canvas.toDataURL('image/png')}
    const imageDoc=(image:string)=>({...current,nodes:{...current.nodes,[n.id]:{...current.nodes[n.id],fills:[{...current.nodes[n.id].fills[0],kind:'image',image,fit:'stretch'}]}}})
    await probe('image-uri-red',imageDoc(uri('#ff0000')),2,0)
    await probe('image-uri-blue',imageDoc(uri('#0000ff')),2,0)
    await probe('same-image-node-name',withName('same-blue'),2,1)
    await probe('integer-pan-distinct-slot',current,2,0,{view:{x:1,y:0,zoom:1}})
    await c.loseDeviceForTesting()
    await probe('driver-loss-invalidates',withName('after-loss'),2,0)
    let rejected=false,delivered=0
    try{await c.render(current,{...options,tileOwner:{documentId:'wrong-id',sessionEpoch:2}},false,'webgpu',true,false,undefined,()=>{delivered++})}catch(e){rejected=String(e).includes('Invalid tile session owner')}
    if(!rejected||delivered)throw Error('Invalid owner was not rejected before publishing')
    await record({kind:'guard',name:'invalid-owner-rejected',rejected,delivered})
    // Reopening same authored id with a new session remains a miss after the explicit failure resync.
    await probe('same-id-resynchronization',withName('resync'),3,0)
    const cancellation=c.render(withName('cancel-this'),{...options,tileViewport:[tile,{...tile,key:'probe2',x:64}],tileOwner:{documentId:current.id,sessionEpoch:3}},false,'webgpu',true,false,undefined,()=>{c.cancelPreview()})
    let cancelled=false
    try{await cancellation}catch(e){cancelled=String(e).includes('PREVIEW_CANCELLED')}
    if(!cancelled)throw Error('Queued cancellation fence did not reject')
    await record({kind:'guard',name:'cancel-preview-rejected',cancelled})
    await probe('cancelled-new-tile-was-not-cached',withName('after-cancel'),3,1,{tileViewport:[tile,{...tile,key:'probe2',x:64}]})
   }finally{c.dispose();off.dispose()}
  }
  if(phase==='extended'||phase==='all'){
   const {effect,paint,defaultTextStyle}=await import('/src/model.ts')
   const one=(d:any,w=160,h=120)=>({pageId:d.pages[0].id,width:w,height:h,view:{x:.25,y:.125,zoom:1},grid:false,transparent:false,rasterProfile:'figma',tileViewport:[{key:'whole',x:0,y:0,width:w,height:h,zoom:1,phaseX:.25,phaseY:.125}]})
   async function pair(c:any,off:any,name:string,d:any,o:any,expectHits?:number,debug?:any){
    const a=await render(c,d,{...o,tileOwner:{documentId:d.id,sessionEpoch:7}},debug),b=await render(off,d,o)
    if(expectHits!==undefined&&a.stats.tileCacheHits!==expectHits)throw Error(name+' hits '+a.stats.tileCacheHits+' expected '+expectHits)
    await record({kind:'extended',name,on:metrics(a),off:metrics(b),...compare(a,b,o)})
    return a
   }
   // Font bytes stay in runtime memory; only paths and SHA digests are written.
   if(fonts.length===2){
    let d=blank('font bytes');d.schemaVersion=5;d.colorManagement=defaultColorSettings();d.rasterProfile='figma'
    d.fonts={probe:{family:'same resource family',data:fonts[0].data}}
    const n=node('text',8.25,12.125,230,72);n.text='WWii 012345';n.fontSize=28;n.textStyle={...defaultTextStyle(),fontId:'probe'};d.nodes[n.id]=n;d.pages[0].children=[n.id]
    const c=new KernelClient(),off=new OriginalClient(),o=one(d,256,96)
    try{
     const first=await pair(c,off,'font-A-baseline',d,o,0)
     d={...d,fonts:{probe:{family:'same resource family',data:fonts[1].data}}}
     const second=await pair(c,off,'same-font-id-family-new-font-B-bytes',d,o,0)
     const changed=difference(first.tiles.get('whole').bytes,second.tiles.get('whole').bytes).count
     if(!changed)throw Error('Font bytes test did not change rendered glyphs')
     await record({kind:'extended',name:'font-glyph-change-confirmed',differentRgbaBytes:changed})
     d={...d,nodes:{...d.nodes,[n.id]:{...n,name:'metadata after font replacement'}}}
     await pair(c,off,'unchanged-real-font-reuses',d,o,1)
     const bad={...d,fonts:{probe:{family:'same resource family',data:'not valid base64!'}}};let delivered=0,error=''
     try{await c.render(bad,{...o,tileOwner:{documentId:d.id,sessionEpoch:7}},false,'webgpu',true,false,undefined,()=>delivered++)}catch(e){error=String(e)}
     if(!/font|base64/i.test(error)||delivered)throw Error('Invalid font was hidden or published pixels '+error)
     await record({kind:'extended',name:'bad-font-rejected',delivered,error})
     await pair(c,off,'font-failure-full-resync-recovers',d,o,0)
    }finally{c.dispose();off.dispose()}
   }
   else await record({kind:'skipped',name:'real-font-byte-replacement',reason:fontSkipReason})
   // Complex parent/mask/backdrop changes retain all compiler structure in the witness.
   let d=blank('mask optics support');d.schemaVersion=5;d.colorManagement=defaultColorSettings();d.rasterProfile='figma'
   const frame=node('frame',3.25,4.125,152,104);frame.clip=true;frame.fills=[paint('#b0b8cc')]
   const red=node('rectangle',0,0,55,104);red.fills=[paint('#bf4433')]
   const blue=node('rectangle',66.125,0,52,104);blue.fills=[paint('#234cbb')]
   const lens=node('rectangle',30.125,22.375,80,56);lens.radii=[12,12,12,12];lens.fills=[{...paint('#ffffff'),opacity:.14}]
   lens.effects=[{...effect('glass'),radius:3.25,opacity:1,glass:{depth:8,refraction:.5,dispersion:.3,lightAngle:31.25,lightIntensity:1}}]
   const mask=node('ellipse',20.125,10.25,88,77);mask.mask=true;mask.visible=false;mask.fills=[paint('#ffffff')]
   frame.children=[red.id,blue.id,lens.id,mask.id];d.pages[0].children=[frame.id]
   for(const n of [frame,red,blue,lens,mask])d.nodes[n.id]=n
   const o={...one(d),tileViewport:Array.from({length:4},(_,i)=>({key:'m'+i,x:i%2*80,y:Math.floor(i/2)*60,width:80,height:60,zoom:1,phaseX:.25,phaseY:.125}))}
   const c=new KernelClient(),off=new OriginalClient()
   const edit=(id:string,values:any)=>{d={...d,nodes:{...d.nodes,[id]:{...d.nodes[id],...values}}}}
   try{
    await pair(c,off,'complex-glass-baseline',d,o,0)
    edit(mask.id,{visible:true});await pair(c,off,'parent-mask-enabled',d,o)
    edit(lens.id,{name:'exact same masked pixels'});await pair(c,off,'masked-metadata-reuses',d,o,4)
    edit(mask.id,{transform:[1,0,0,1,300,10.25]});await pair(c,off,'mask-leaves-crop-retains-maskId',d,o)
    edit(mask.id,{transform:[1,0,0,1,20.125,10.25]});edit(frame.id,{opacity:.625});await pair(c,off,'parent-opacity-changes',d,o)
    edit(frame.id,{blend:'multiply'});await pair(c,off,'parent-nonnormal-blend',d,o)
    edit(frame.id,{clip:false});await pair(c,off,'parent-clip-disabled',d,o)
    const far=node('rectangle',1000,1000,24,24);far.effects=[{...effect('background-blur'),radius:9}]
    d={...d,pages:[{...d.pages[0],children:[...d.pages[0].children,far.id]}],nodes:{...d.nodes,[far.id]:far}}
    await pair(c,off,'offscreen-backdrop-effect-changes-page-support',d,o)
    edit(lens.id,{name:'unchanged complex fallback'});await pair(c,off,'complex-fallback-metadata-reuses',d,o,4)
   }finally{c.dispose();off.dispose()}
   // One declared failure at the parent crop; both children really render on GPU.
   {
    const c=new KernelClient(),off=new OriginalClient(),o2=one(d,128,96)
    try{
     const first=await pair(c,off,'explicit-budget-fault-real-two-child-render',d,o2,0,{forceFirstTileBudgetFailure:true})
     if(first.stats.injectedBudgetFailures!==1||first.stats.previewLeaves!==2)throw Error('Budget injection did not execute exactly two actual children')
     const next={...d,nodes:{...d.nodes,[lens.id]:{...d.nodes[lens.id],name:'after split'}}}
     const normal=await pair(c,off,'split-assembly-was-not-cached',next,o2,0)
     if(normal.stats.injectedBudgetFailures!==0||normal.stats.previewLeaves!==1)throw Error('Unforced retry did not render one actual scene')
     await pair(c,off,'single-scene-after-split-can-reuse',{...next,nodes:{...next.nodes,[lens.id]:{...next.nodes[lens.id],name:'single scene hit'}}},o2,1)
    }finally{c.dispose();off.dispose()}
   }
   // Invalid immutable image bytes must fail, and a repaired document must recover.
   {
    const d=blank('asset failures');d.schemaVersion=3;d.colorManagement=defaultColorSettings();d.rasterProfile='figma'
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#3388ff';ctx.fillRect(0,0,2,2)
    const n=node('rectangle',4,5,56,50);n.fills=[{...paint('#ffffff'),kind:'image',image:canvas.toDataURL('image/png')}];d.nodes[n.id]=n;d.pages[0].children=[n.id]
    const c=new KernelClient(),off=new OriginalClient(),o=one(d,64,64)
    try{
     await pair(c,off,'valid-image-before-failure',d,o,0)
     const bad={...d,nodes:{...d.nodes,[n.id]:{...n,fills:[{...n.fills[0],image:'data:image/png;base64,AA=='}]}}};let delivered=0,error=''
     try{await c.render(bad,{...o,tileOwner:{documentId:d.id,sessionEpoch:7}},false,'webgpu',true,false,undefined,()=>delivered++)}catch(e){error=String(e)}
     if(!error||delivered)throw Error('Invalid image was hidden or published pixels')
     await record({kind:'extended',name:'bad-image-rejected',delivered,error})
     await pair(c,off,'image-failure-full-resync-recovers',d,o,0)
    }finally{c.dispose();off.dispose()}
   }
  }
  if(phase==='eviction'||phase==='all'){
   const c=new KernelClient(),off=new OriginalClient()
   try{
    for(const [index,zoom]of [2,4,2].entries()){
     const view=zoom===2?{x:-213.33333333333326,y:-194,zoom}:{x:-1306.6666666666665,y:-1250,zoom},width=1760,height=1724
     const plan=planTiles({x:-view.x/zoom,y:-view.y/zoom,width:width/zoom,height:height/zoom},zoom,256,{x:devicePixelPhase(view.x,1),y:devicePixelPhase(view.y,1)})
     const options={pageId:fixture.pages[0].id,width,height,view,grid:true,transparent:false,rasterProfile:'figma',tileViewport:plan}
     const a=await render(c,fixture,{...options,tileOwner:{documentId:fixture.id,sessionEpoch:92}}),b=await render(off,fixture,options)
     if(index>0&&a.stats.tileCacheEvictions<=0)throw Error('Two-camera case did not actually exercise budget eviction')
     await record({kind:'eviction',index,zoom,on:metrics(a),off:metrics(b),...compare(a,b,options)})
    }
   }finally{c.dispose();off.dispose()}
  }
  if(phase==='hdr'||phase==='all'||phase==='quick-perf'){
   for(const zoom of (phase==='quick-perf'?[2]:[2,4])){
    const view=zoom===2?{x:-213.33333333333326,y:-194,zoom}:{x:-1306.6666666666665,y:-1250,zoom},width=1760,height=1724
    const plan=planTiles({x:-view.x/zoom,y:-view.y/zoom,width:width/zoom,height:height/zoom},zoom,256,{x:devicePixelPhase(view.x,1),y:devicePixelPhase(view.y,1)})
    const options={pageId:fixture.pages[0].id,width,height,view,grid:true,transparent:false,rasterProfile:'figma',tileViewport:plan}
    const glass:any=Object.values(fixture.nodes).find((n:any)=>n.effects.some((e:any)=>e.kind==='glass')),star:any=Object.values(fixture.nodes).find((n:any)=>n.kind==='star')
    const changed={...fixture,nodes:{...fixture.nodes,[glass.id]:{...glass,width:glass.width+1}}}
    const painted={...changed,nodes:{...changed.nodes,[star.id]:{...star,fills:[{...star.fills[0],color:'#22cc77'},...star.fills.slice(1)]}}}
    const sequence=(phase==='quick-perf'?[['baseline',fixture],['visible-star-fill',{...fixture,nodes:{...fixture.nodes,[star.id]:painted.nodes[star.id]}}]]:[['baseline',fixture],['glass-width-plus-one',changed],['star-fill-after-glass',painted],['undo-star-fill',changed],['undo-glass-width',fixture]]) as const
    const c=new KernelClient(),off=new OriginalClient()
    try{
     for(let i=0;i<sequence.length;i++){
      const [name,d]=sequence[i],withOwner={...options,tileOwner:{documentId:fixture.id,sessionEpoch:41}}
      let a:any,b:any
      // Alternate reference order to avoid systematically granting either renderer warm wall time.
      if(i%2){b=await render(off,d,options);a=await render(c,d,withOwner)}else{a=await render(c,d,withOwner);b=await render(off,d,options)}
      await record({kind:'hdr',zoom,name,tiles:plan.length,on:metrics(a),off:metrics(b),...compare(a,b,options)})
     }
    }finally{c.dispose();off.dispose()}
   }
  }
  return{scope:'Current production worker compared with a pinned prior worker, sharing the recorded current renderer/WASM. All pixel assertions use actual GPU readbacks.',results}
 },{fixture,phase,fonts,fontSkipReason})
 await writeFile(join(output,'results.json'),JSON.stringify({...result,errors},null,2))
 if(errors.length)throw new Error('Browser page/console errors: '+errors.join(' | '))
 console.log(JSON.stringify({output,rows:result.results.length,errors}))
} catch(error) {
 await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors},null,2))
 throw error
} finally {await browser?.close();server.kill('SIGTERM')}
