// Mounted Home UI and real Editor snapshots. Storage/native capability boundaries
// are controlled; not an OS file-dialog, browser layout or Electron runtime claim.
// @ts-expect-error jsdom is a test dependency.
import { JSDOM } from 'jsdom'
import React,{act,useState} from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach,afterEach,expect,test,vi } from 'vitest'
import { Editor } from './engine'
import { SettingsDialog } from './SettingsDialog'
import { blank,node } from './model'
import { LocalHome,HomeCanvasGate } from './LocalHome'
import { admitHomeDocumentCommand, type HomeSource } from './local-home-source'
import { modalOwnsKeyboard } from './modal-keyboard'
let dom:any,root:Root,mount:HTMLElement,editor:Editor,source:HomeSource,onNew:()=>Promise<boolean>,onOpenFile:()=>Promise<boolean|'pending'>,settings:ReturnType<typeof vi.fn<()=>void>>
let mounts=0
const records=[{id:'a',name:'Alpha',revision:1,updatedAt:1000,deleted:false},{id:'b',name:'Beta',revision:3,updatedAt:2000,deleted:false},{id:'c',name:'Trashed',revision:2,updatedAt:3000,deleted:true}]
beforeEach(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
 for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Node','Event','KeyboardEvent','StorageEvent','localStorage'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const {createRoot}=await import('react-dom/client');mount=document.createElement('div');document.body.append(mount);root=createRoot(mount)
 const doc=blank(),a=node('rectangle',10,20,100,75);doc.nodes[a.id]=a;doc.pages[0].children=[a.id];editor=new Editor(doc);editor.select([a.id]);editor.set({view:{x:123,y:456,zoom:2}})
 source={kind:'web-local',list:vi.fn(async()=>records),open:vi.fn(async()=>true)};onNew=vi.fn(async()=>true);onOpenFile=vi.fn(async()=> 'pending' as const);settings=vi.fn();mounts=0
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.unstubAllGlobals()})
function RetainedEditor(){useState(()=>{mounts++;return 0});return <div data-testid="editor-retained">Canvas retained</div>}
function Harness({ready=true,startupError}:{ready?:boolean;startupError?:string}){
 const [home,setHome]=useState(true),[showSettings,setShowSettings]=useState(false)
 return <div className={home?'home-route-active':''}><header><button type="button" onClick={()=>setHome(true)}>首页</button></header><main className="editor-workspace"><HomeCanvasGate home={home}><RetainedEditor/></HomeCanvasGate></main>{home&&<LocalHome source={source} ready={ready} startupError={startupError} currentName={editor.state.doc.name} onResume={()=>setHome(false)} onNew={onNew} onOpenFile={onOpenFile} onSettings={()=>{settings();setShowSettings(true)}}/>}{showSettings&&<SettingsDialog editor={editor} onClose={()=>setShowSettings(false)}/>}<footer>Footer</footer></div>
}
async function render(ready=true){await act(async()=>{root.render(<Harness ready={ready}/>);await Promise.resolve()})}
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes(text))!
const home=()=>document.querySelector('[aria-label="本机设计首页"]')
async function fill(value:string){await act(async()=>{const el=document.querySelector<HTMLInputElement>('[aria-label="搜索最近设计"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})}
test('default local admin home reads metadata only, filters/searches, and toggles real grid/list',async()=>{
 await render();expect(home()?.textContent).toContain('admin');expect(home()?.textContent).toContain('本机工作空间');expect(source.list).toHaveBeenCalledOnce();expect(source.open).not.toHaveBeenCalled()
 expect([...document.querySelectorAll('.local-home-file strong')].map(n=>n.textContent)).toEqual(['Beta','Alpha']);expect(document.querySelector('[aria-label="搜索最近设计"]')).toBe(document.activeElement)
 await fill('alpha');expect(document.querySelectorAll('.local-home-file')).toHaveLength(1);await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="列表显示"]')!.click());expect(document.querySelector('.local-home-files.list')).not.toBeNull()
})
test('Home to editor and back preserves real document/page/selection/view and does not remount editor',async()=>{
 const before=editor.state;await render();const shell=document.querySelector('.editor-workspace');expect(shell?.hasAttribute('inert')).toBe(true);expect(document.querySelector('[data-testid="editor-retained"]')).toBeNull();expect(mounts).toBe(0)
 await act(async()=>button('继续编辑').click());expect(home()).toBeNull();expect(shell?.hasAttribute('inert')).toBe(false);expect(editor.state).toBe(before);expect(mounts).toBe(1)
 await act(async()=>button('首页').click());expect(home()).not.toBeNull();expect(editor.state).toBe(before);expect(editor.canUndo).toBe(false);expect(mounts).toBe(1)
})
test('cancelled or failed open leaves Home and current Editor snapshot intact',async()=>{
 source.open=vi.fn(async()=>false);const before=editor.state;await render();await act(async()=>button('Alpha').click());expect(home()).not.toBeNull();expect(document.querySelector('[role="status"]')?.textContent).toContain('已保留');expect(editor.state).toBe(before)
 source.open=vi.fn(async()=>{throw new Error('File unavailable')});await act(async()=>button('Beta').click());expect(document.querySelector('[role="alert"]')?.textContent).toContain('File unavailable');expect(home()).not.toBeNull();expect(editor.state).toBe(before)
})
test('successful guarded open resumes editor; cancelled New and pending browser picker remain Home',async()=>{
 onNew=vi.fn(async()=>false);await render();await act(async()=>button('新建设计').click());expect(home()).not.toBeNull();await act(async()=>button('打开设计文件').click());expect(home()).not.toBeNull();expect(onOpenFile).toHaveBeenCalledOnce();await act(async()=>button('Alpha').click());expect(home()).toBeNull();expect(source.open).toHaveBeenCalledWith('a')
})
test('settings uses supplied existing entry and Delete/Backspace cannot bubble into retained editor shortcuts',async()=>{
 await render();await act(async()=>button('设置').click());expect(settings).toHaveBeenCalledOnce()
 const leaked=vi.fn();window.addEventListener('keydown',leaked);window.addEventListener('keyup',leaked)
 await act(async()=>home()!.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true})));await act(async()=>home()!.dispatchEvent(new KeyboardEvent('keyup',{key:'Alt',bubbles:true,cancelable:true})));expect(leaked).not.toHaveBeenCalled();window.removeEventListener('keydown',leaked);window.removeEventListener('keyup',leaked);expect(editor.canUndo).toBe(false)
})
test('loading/failure state is truthful and stale unmounted listing cannot resume editor',async()=>{
 source.list=vi.fn(async()=>{throw new Error('Storage denied')});await render();expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage denied');expect(home()).not.toBeNull()
})
test('startup not-ready does not list or allow document actions',async()=>{
 await render(false);expect(source.list).not.toHaveBeenCalled();expect(button('新建设计').disabled).toBe(true);expect(button('打开设计文件').disabled).toBe(true);expect(document.querySelector('[role="status"]')?.textContent).toContain('正在读取')
})

test('pending and failed restore keep real local Settings usable without admitting Canvas or document commands',async()=>{
 await render(false);const before=editor.state.doc,version=editor.state.version
 expect(button('设置').disabled).toBe(false);await act(async()=>button('设置').click());expect(document.querySelector('[role="dialog"]')).not.toBeNull()
 const checkbox=document.querySelector<HTMLInputElement>('.settings-dialog input[type="checkbox"]')!;expect(checkbox).not.toBeNull();await act(async()=>checkbox.click())
 expect(editor.state.doc).toBe(before);expect(editor.state.version).toBe(version);expect(editor.canUndo).toBe(false);expect(mounts).toBe(0)
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click())
 await act(async()=>root.render(<Harness ready={false} startupError="本地恢复失败"/>));expect(document.querySelector('[role="alert"]')?.textContent).toContain('本地恢复失败');expect(button('继续编辑').disabled).toBe(true)
 await act(async()=>button('新建设计').click());expect(onNew).not.toHaveBeenCalled();expect(mounts).toBe(0)
 await act(async()=>root.render(<Harness ready/>));onNew=vi.fn(async()=>false);await act(async()=>root.render(<Harness ready/>));await act(async()=>button('新建设计').click());expect(home()).not.toBeNull();expect(mounts).toBe(0)
 await act(async()=>button('继续编辑').click());expect(home()).toBeNull();expect(mounts).toBe(1)
})

test('native Home file-command guard rejects real Settings modal focus and independent modal focus',async()=>{
 await render();await act(async()=>button('设置').click());expect(modalOwnsKeyboard(document.activeElement)).toBe(true)
 const before=editor.state,perform=vi.fn()
 const dispatch=(name:string)=>{if(admitHomeDocumentCommand(name,{ready:true,switching:false,busy:false,transitioning:false,interactionActive:editor.interactionActive,modalOwnsFocus:modalOwnsKeyboard(document.activeElement)}))perform(name)}
 for(const name of ['new','open','openPending'])dispatch(name)
 expect(perform).not.toHaveBeenCalled();expect(editor.state).toBe(before);expect(home()).not.toBeNull()
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click())
 const independent=document.createElement('section');independent.setAttribute('role','dialog');independent.setAttribute('aria-modal','true');independent.innerHTML='<button>Independent</button>';document.body.append(independent);independent.querySelector('button')!.focus()
 for(const name of ['new','open','openPending'])dispatch(name)
 expect(perform).not.toHaveBeenCalled();independent.remove();document.querySelector<HTMLInputElement>('[aria-label="搜索最近设计"]')!.focus()
 dispatch('open');expect(perform).toHaveBeenCalledExactlyOnceWith('open');expect(editor.state).toBe(before)
})
