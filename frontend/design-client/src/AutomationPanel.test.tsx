import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error jsdom runtime is a test-only dependency; no production types required.
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { unzipSync, strFromU8 } from 'fflate'
import { AutomationPanel, AutomationDialog, codeExportZip, sandboxedCodePreview } from './AutomationPanel'
import { Editor } from './engine'
import { blank,node, type DesignDocument } from './model'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { exportDesignCode } from './automation/export'
import type { DesktopBridge } from './desktop'
let dom:any, root:Root, element:HTMLDivElement, editor:Editor
const globals=new Map<string,PropertyDescriptor|undefined>()
beforeEach(()=>{
  dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    globals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  element=document.createElement('div');document.body.appendChild(element);root=createRoot(element)
  const d=blank('DOM automation'), n=node('text',0,0,200,50);n.text='你好 Hello';d.nodes[n.id]=n;d.pages[0].children.push(n.id);editor=new Editor(d)
})
afterEach(async()=>{
  await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.restoreAllMocks()
  for(const [key,descriptor] of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key]}globals.clear()
})
const button=(text:string)=>{const b=[...element.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error(`Missing ${text}`);return b}
const click=async(text:string)=>{await act(async()=>button(text).click())}
describe('automation actual DOM controls (no browser/GPU)',()=>{
  it('opens/closes an accessible dialog without auto-enabling MCP',async()=>{
    await act(async()=>root.render(<AutomationPanel editor={editor} desktop={undefined}/>));expect(element.querySelector('[role=dialog]')).toBeNull()
    await click('AI / MCP');expect(element.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('设计 API 与 MCP')
    expect(element.textContent).toContain('需要 Electron');await click('关闭');expect(element.querySelector('[role=dialog]')).toBeNull()
  })
  it('reads actual structured context and checks/font metadata',async()=>{
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={undefined} onClose={()=>{}}/>))
    await click('读取 AI 上下文');expect(element.textContent).toContain('你好 Hello');expect(element.querySelector('[role=alert]')).toBeNull()
    await click('检查当前页面');expect(element.querySelector('[role=alert]')).toBeNull()
    await click('检查字体');expect(element.querySelector('[role=alert]')).toBeNull()
  })
  it('HTML preview is sandboxed and cannot load remote assets/scripts',async()=>{
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={undefined} onClose={()=>{}}/>));await click('预览 HTML')
    const iframe=element.querySelector('iframe')!;expect(iframe).not.toBeNull();expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.srcdoc).toContain("default-src 'none'");expect(iframe.srcdoc).toContain('你好 Hello');expect(iframe.srcdoc).toContain('<style>');expect(iframe.srcdoc).toContain('font-size:');expect(iframe.srcdoc.match(/Content-Security-Policy/g)).toHaveLength(1);expect(iframe.srcdoc).not.toContain('href="styles.css"')
  })
  it('connection controls call explicit scoped native gates and unsubscribe',async()=>{
    const unsubscribe=vi.fn(), disabled={enabled:false,connectedClients:0,pendingRequests:0,journal:[]}
    const automation={status:vi.fn(async()=>disabled),onStatus:vi.fn(()=>unsubscribe),enable:vi.fn(async({scope}:{scope:'read'|'write'})=>({...disabled,enabled:true,scope})),disable:vi.fn(async()=>disabled),copyConnection:vi.fn(async()=>({copied:true}))}
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={{automation} as unknown as DesktopBridge} onClose={()=>{}}/>))
    expect(automation.enable).not.toHaveBeenCalled();await click('启用只读');expect(automation.enable).toHaveBeenLastCalledWith({scope:'read'})
    await click('启用读写');expect(automation.enable).toHaveBeenLastCalledWith({scope:'write'});await click('复制连接配置');expect(automation.copyConnection).toHaveBeenCalledTimes(1)
    await click('停用');expect(automation.disable).toHaveBeenCalledTimes(1);await act(async()=>root.render(<div/>));expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
  it('native gate errors show without claiming enabled',async()=>{
    const automation={status:async()=>({enabled:false,connectedClients:0,pendingRequests:0,journal:[]}),onStatus:()=>()=>{},enable:async()=>{throw Error('Permission declined')}}
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={{automation} as unknown as DesktopBridge} onClose={()=>{}}/>));await click('启用读写');expect(element.querySelector('[role=alert]')?.textContent).toBe('Permission declined');expect(element.textContent).toContain('未启用')
  })
  it('ZIP contains real HTML CSS node map and explicit fidelity warnings',()=>{
    const result=exportDesignCode(editor.state.doc),files=unzipSync(codeExportZip(result));expect(strFromU8(files['index.html'])).toContain('你好 Hello');expect(strFromU8(files['styles.css'])).toContain('font-size')
    const manifest=JSON.parse(strFromU8(files['design-manifest.json']));expect(Object.keys(manifest.nodeIdMap)).toEqual(Object.keys(editor.state.doc.nodes));expect(manifest.fidelity).toBe('approximate')
  })
  it('downloads genuine FD and SVG, then imports FD through the UI with one undo',async()=>{
    const blobs:Blob[]=[]
    vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{blobs.push(blob as Blob);return 'blob:fixture'})
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    vi.spyOn(dom.window.HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={undefined} onClose={()=>{}}/>))
    await click('导出完整 FD');expect(element.querySelector('[role=alert]')).toBeNull();expect(blobs).toHaveLength(1)
    const decoded=decodeDocumentBinary(new Uint8Array(await blobs[0].arrayBuffer())) as DesignDocument;expect(decoded.id).toBe(editor.state.doc.id);expect(Object.keys(decoded.nodes)).toEqual(Object.keys(editor.state.doc.nodes))
    await click('导出 SVG');expect(element.querySelector('[role=alert]')).toBeNull();expect(await blobs[1].text()).toContain('<svg')
    const before=editor.state.doc,bytes=encodeDocumentBinary(before),input=element.querySelector('input[type=file]')!
    Object.defineProperty(input,'files',{configurable:true,value:[{name:'fixture.fd',size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]})
    await act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})))
    expect(element.querySelector('[role=alert]')).toBeNull();expect(Object.keys(editor.state.doc.nodes).length).toBeGreaterThan(Object.keys(before.nodes).length)
    editor.undo();expect(editor.state.doc).toBe(before)
  })
  it('reads and saves SQLite audit preferences only on explicit interaction',async()=>{
    const config={auditEnabled:false,retentionDays:30,maxAuditEntries:1000,preferredScope:'read' as const,updatedAt:0}
    const automation={status:async()=>({enabled:false,connectedClients:0,pendingRequests:0,journal:[]}),onStatus:()=>()=>{},config:vi.fn(async()=>config),configure:vi.fn(async()=>config),auditHistory:vi.fn(async()=>({entries:[],hasMore:false}))}
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={{automation} as unknown as DesktopBridge} onClose={()=>{}}/>))
    expect(automation.config).not.toHaveBeenCalled();await click('读取记录设置');expect(automation.config).toHaveBeenCalledTimes(1)
    await click('保存记录设置');expect(automation.configure).toHaveBeenCalledWith({auditEnabled:false,retentionDays:30})
    await click('查看持久化记录');expect(automation.auditHistory).toHaveBeenCalledWith({limit:50,documentId:editor.state.doc.id})
  })

  it('preview stylesheet cannot terminate its style tag',()=>{const r=exportDesignCode(editor.state.doc);r.css+='\n/* </style><script>bad()</script> */';const html=sandboxedCodePreview(r);expect(html).not.toContain('<script>');expect(html.match(/<\/style>/g)).toHaveLength(1)})

  it('downloads an actual Sketch archive and reimports through the file control with fidelity notices',async()=>{
    const blobs:Blob[]=[]
    vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{blobs.push(blob as Blob);return 'blob:sketch-fixture'})
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    vi.spyOn(dom.window.HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={undefined} onClose={()=>{}}/>))
    await click('导出 Sketch');expect(element.querySelector('[role=alert]')).toBeNull();expect(blobs).toHaveLength(1)
    const bytes=new Uint8Array(await blobs[0].arrayBuffer()),entries=unzipSync(bytes);expect(entries['document.json']).toBeDefined();expect(element.textContent).toContain('lossless')
    const before=editor.state.doc,input=element.querySelector('input[type=file]')!
    Object.defineProperty(input,'files',{configurable:true,value:[{name:'fixture.sketch',size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]})
    await act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})))
    expect(element.querySelector('[role=alert]')).toBeNull();expect(Object.keys(editor.state.doc.nodes).length).toBeGreaterThan(Object.keys(before.nodes).length);expect(element.textContent).toContain('warnings')
    editor.undo();expect(editor.state.doc).toBe(before)
  })

})
