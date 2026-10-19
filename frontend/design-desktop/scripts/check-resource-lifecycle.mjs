// Owned macOS process-tree, document/window/application lifecycle regression.
// node scripts/check-resource-lifecycle.mjs FIXTURE_FD BUILT_HOST NEW_OUTPUT
import assert from 'node:assert/strict'
import {cp,mkdir,readFile,writeFile,symlink} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
assert.equal(process.platform,'darwin','This physical-footprint check targets macOS')
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const require=createRequire(path.join(desktop,'../design-client/package.json'))
const {_electron,expect}=require('@playwright/test')
const [fixture,builtHost,rawOutput]=process.argv.slice(2)
assert(fixture&&builtHost&&rawOutput,'Expected fixture, built host, new output directory')
const output=path.resolve(rawOutput),host=path.join(output,'host')
await mkdir(output,{recursive:false});await mkdir(host)
await cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
await cp(path.join(builtHost,'package.json'),path.join(host,'package.json'))
await symlink(path.join(path.resolve(builtHost),'dist'),path.join(host,'dist'),'dir')
const envelope=JSON.parse(await readFile(fixture,'utf8')),document=envelope.document??envelope
const footprint=String.raw`import ctypes,json,subprocess,pathlib,re,sys
root=int(sys.argv[1]);rows=[]
for line in subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True).splitlines():
 p=line.strip().split(None,2)
 if len(p)==3:rows.append((int(p[0]),int(p[1]),p[2].rsplit('/',1)[-1]))
ids={root}
for _ in range(8):
 old=len(ids);ids.update(p for p,pp,c in rows if pp in ids)
 if len(ids)==old:break
sdk=pathlib.Path(subprocess.check_output(['xcrun','--show-sdk-path'],text=True).strip());s=(sdk/'usr/include/sys/resource.h').read_text().split('struct rusage_info_v4 {',1)[1].split('};',1)[0]
class Usage(ctypes.Structure):_fields_=[('uuid',ctypes.c_uint8*16)]+[(name,ctypes.c_uint64) for name in re.findall(r'uint64_t\s+(\w+);',s)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib');result=[]
for pid,pp,name in rows:
 if pid not in ids:continue
 r=Usage()
 if lib.proc_pid_rusage(pid,4,ctypes.byref(r))==0:result.append({'pid':pid,'ppid':pp,'name':name,'physicalBytes':r.ri_phys_footprint,'residentBytes':r.ri_resident_size})
print(json.dumps(result))`
let app,page,pid;const rows=[]
const snapshot=async phase=>{
 const processes=JSON.parse(execFileSync('python3',['-c',footprint,String(pid)],{encoding:'utf8'}))
 const row={phase,at:new Date().toISOString(),physicalBytes:processes.reduce((n,p)=>n+p.physicalBytes,0),processes}
 if(page&&!page.isClosed())row.canvas=await page.locator('.kernel-tiles').evaluateAll(es=>es.map(e=>({...e.dataset})))
 rows.push(row);await writeFile(path.join(output,'results.json'),JSON.stringify({status:'running',rows},null,2))
 console.log(JSON.stringify({phase,physicalMiB:Math.round(row.physicalBytes/1048576),processes:processes.length}));return row
}
const settle=async()=>{
 await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||
  document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&
  document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true'&&
  document.querySelector('.kernel-presentation')?.getAttribute('data-displayed-document')===document.querySelector('.kernel-presentation')?.getAttribute('data-requested-document'),null,{timeout:90000})
 assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[])
}
const configure=async()=>{await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,960);w.webContents.setBackgroundThrottling(false);w.hide();w.on('show',()=>w.hide())})}
try{
 app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-gui-test'],chromiumSandbox:true,
 env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k))),TMPDIR:output}})
 pid=app.process().pid;page=await app.firstWindow();await configure()
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000});await settle();await snapshot('empty-start')
 for(let cycle=1;cycle<=3;cycle++){
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(document.name,{timeout:90000})
  await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:90000});await settle()
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:90000});await snapshot(`open-${cycle}`)
  await page.getByLabel(`关闭文档 ${document.name}`,{exact:true}).click()
  await expect(page.getByLabel('文档名称',{exact:true})).not.toHaveValue(document.name,{timeout:90000});await settle();await snapshot(`closed-${cycle}`)
 }
 const nativeDocument={schemaVersion:5,id:'lifecycle',name:'lifecycle',pages:[{id:'p',name:'p',children:['a'],background:'#ffffff'}],nodes:{a:{id:'a',kind:'rectangle',width:16,height:16,fills:[{kind:'solid',color:'#3377ee'}]}}}
 const native=await page.evaluate(async doc=>{const bridge=window.coreDesktop.nativeRender;const loaded=await bridge.load(JSON.stringify(doc));if(!loaded.ok)throw Error(loaded.error);return bridge.frame({pageId:'p',width:16,height:16,view:{x:0,y:0,zoom:1},transparent:true},0)},nativeDocument)
 assert.equal(native.ok,true,native.error);await snapshot('native-render-open')
 const closed=page.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed
 await expect.poll(async()=>{const row=await snapshot('window-closed-check');return row.processes.filter(p=>/^(design-render|design-prepare)$/.test(p.name)).length},{timeout:10000,intervals:[100,500,1000]}).toBe(0)
 const next=app.waitForEvent('window');await app.evaluate(({app})=>app.emit('activate'));page=await next;await configure()
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000});await settle();await snapshot('window-reopened')
 await app.close();app=undefined;await snapshot('application-quit')
 assert.equal(rows.at(-1).processes.length,0,'Owned application and children must exit')
 await writeFile(path.join(output,'results.json'),JSON.stringify({status:'passed',rows,notes:['Physical footprint is the sum of the owned process tree; no forced GC.','Document-close plateau is reported, not equated to instant allocator return.']},null,2))
}catch(error){await writeFile(path.join(output,'results.json'),JSON.stringify({status:'failed',error:String(error),rows},null,2));throw error}
finally{if(app)await app.close()}
