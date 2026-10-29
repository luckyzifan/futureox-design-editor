// @ts-expect-error jsdom is a test runtime dependency.
import {JSDOM} from 'jsdom'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,test,vi} from 'vitest'
import {Canvas} from './Canvas'
import {Editor} from './engine'
import {blank} from './model'
import type {SourceCanvasSnapshot} from './desktop'
const boundary=vi.hoisted(()=>({native:undefined as any}))
vi.mock('./kernel/Surface',()=>({KernelSurface:()=> <div data-testid="ordinary-surface"/>}))
vi.mock('./kernel/NativeSourceSurface',()=>({NativeSourceSurface:(props:any)=>{boundary.native=props;return <div data-testid="native-source-surface"/>}}))
vi.mock('./CanvasEditPreview',()=>({CanvasEditPreview:()=>null}))
let cleanup=()=>{}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
test('full source uses its actual surface and bounds, opens a material in hand mode, and restores the ordinary canvas',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://design.invalid/'})
 for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLCanvasElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage'])vi.stubGlobal(key,key==='window'?dom.window:(dom.window as any)[key])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('devicePixelRatio',1)
 vi.stubGlobal('CSS',{escape:(s:string)=>s});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 Object.defineProperties(dom.window.HTMLElement.prototype,{clientWidth:{configurable:true,get:()=>1000},clientHeight:{configurable:true,get:()=>800}})
 vi.spyOn(dom.window.HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:800,right:1000,bottom:800,x:0,y:0,toJSON(){}})
 vi.spyOn(dom.window.HTMLCanvasElement.prototype,'getContext').mockReturnValue(null)
 const editor=new Editor(blank()),root=createRoot(document.getElementById('root')!),open=vi.fn(),status=vi.fn()
 cleanup=()=>{act(()=>root.unmount());editor.dispose();dom.window.close()}
 editor.set({tool:'hand',view:{x:-100,y:-200,zoom:2}})
 const source={owner:{documentId:'source',sessionEpoch:1},revision:1,token:'snapshot',bytes:100,nodes:100,roots:10,pageId:'p',stageId:'s',
  bounds:{x:0,y:0,width:10000,height:8000},warnings:[],rasterProfile:'figma',colorManaged:true} as SourceCanvasSnapshot
 await act(async()=>root.render(<Canvas editor={editor} nativeSource={source} onNativeSourceStatus={status} onOpenSourcePoint={open}/>))
 expect(document.querySelector('[data-testid="native-source-surface"]')).not.toBeNull()
 expect(document.querySelector('[data-testid="ordinary-surface"]')).toBeNull()
 expect(boundary.native.source).toBe(source);expect(boundary.native.onStatus).toBe(status)
 const host=document.querySelector('[data-testid="canvas"]')!
 act(()=>host.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,button:0,clientX:300,clientY:400})))
 expect(open).toHaveBeenCalledWith({x:200,y:300})
 act(()=>document.querySelector('.horizontal')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true,button:0,clientX:300,clientY:400})))
 expect(open).toHaveBeenCalledTimes(1)
 const nativeThumb=parseFloat((document.querySelector('.horizontal .canvas-scrollbar-thumb') as HTMLElement).style.width)
 await act(async()=>root.render(<Canvas editor={editor}/>))
 expect(document.querySelector('[data-testid="native-source-surface"]')).toBeNull()
 expect(document.querySelector('[data-testid="ordinary-surface"]')).not.toBeNull()
 expect(nativeThumb).toBeLessThan(parseFloat((document.querySelector('.horizontal .canvas-scrollbar-thumb') as HTMLElement).style.width))
})
