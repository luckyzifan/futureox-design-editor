import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error jsdom runtime is a test-only dependency; no production types required.
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate'
import { AutomationPanel, AutomationDialog, codeExportZip, sandboxedCodePreview } from './AutomationPanel'
import { Editor } from './engine'
import { blank,node, type DesignDocument } from './model'
// @ts-expect-error desktop host module has no TypeScript declarations
import { validateProductExport } from '../../design-desktop/src/product-export.mjs'
// @ts-expect-error desktop host module has no TypeScript declarations
import { desktopText } from '../../design-desktop/src/native-locale.mjs'
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
    await click('设计 API');expect(element.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('设计 API 与 MCP')
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
  it('additional scopes default to none and require explicit enable after selecting their independent values',async()=>{
    const disabled={enabled:false,connectedClients:0,pendingRequests:0,journal:[]}
    const enable=vi.fn(async(value:{scope:'read'|'write';workspaceScope?:'read'|'write';settingsScope?:'read'|'write'})=>({...disabled,enabled:true,scope:value.scope,grants:{workspace:value.workspaceScope,settings:value.settingsScope}}))
    const automation={status:async()=>disabled,onStatus:()=>()=>{},enable}
    const render=()=>root.render(<AutomationDialog editor={editor} desktop={{automation} as unknown as DesktopBridge} onClose={()=>{}}/>)
    await act(async()=>render())
    const workspace=element.querySelector<HTMLSelectElement>('[aria-label="工作区 MCP 权限"]')!,settings=element.querySelector<HTMLSelectElement>('[aria-label="设置 MCP 权限"]')!
    expect(workspace.value).toBe('none');expect(settings.value).toBe('none')
    await act(async()=>{workspace.value='write';workspace.dispatchEvent(new dom.window.Event('change',{bubbles:true}));settings.value='read';settings.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
    expect(enable).not.toHaveBeenCalled();expect(element.textContent).toContain('未启用')
    await click('启用只读');expect(enable).toHaveBeenLastCalledWith({scope:'read',workspaceScope:'write',settingsScope:'read'})
    expect(element.textContent).toContain('当前文档只读');expect(element.textContent).toContain('工作区读写 · 应用设置只读')
    await act(async()=>root.render(<div/>));await act(async()=>render())
    expect(element.querySelector<HTMLSelectElement>('[aria-label="工作区 MCP 权限"]')!.value).toBe('none')
    expect(element.querySelector<HTMLSelectElement>('[aria-label="设置 MCP 权限"]')!.value).toBe('none')
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
  it('sends real FD and HTML ZIP bytes through the desktop channel instead of a blob download',async()=>{
    editor.dispose()
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const d=blank('DOM automation'), text=node('text',0,0,200,50), rect=node('rectangle',0,0,80,60)
    text.text='你好 Hello'
    rect.fills=[{...rect.fills[0],kind:'image',image:png}]
    d.nodes[text.id]=text;d.nodes[rect.id]=rect;d.pages[0].children.push(text.id,rect.id);editor=new Editor(d)
    const calls:{kind:string;filename:string;bytes:Uint8Array}[]=[]
    const exportProductFile=vi.fn(async(request:{kind:'fd'|'html-zip';filename:string;bytes:Uint8Array}):Promise<{status:'ok'|'error';displayName?:string;code?:string;message?:string}>=>{calls.push({kind:request.kind,filename:request.filename,bytes:request.bytes});return {status:'ok',displayName:request.filename}})
    const blobs:Blob[]=[]
    vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{blobs.push(blob as Blob);return 'blob:channel'})
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    vi.spyOn(dom.window.HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={{exportProductFile} as unknown as DesktopBridge} onClose={()=>{}}/>))
    await click('导出完整 FD')
    expect(element.querySelector('[role=alert]')).toBeNull();expect(blobs).toHaveLength(0);expect(calls.map(call=>call.kind)).toEqual(['fd'])
    expect(calls[0].filename).toBe('design.fd')
    const fd=calls[0].bytes
    expect(validateProductExport('fd',fd).equals(Buffer.from(fd))).toBe(true)
    const decoded=decodeDocumentBinary(fd) as DesignDocument
    expect(decoded.id).toBe(editor.state.doc.id);expect(decoded.nodes[rect.id].width).toBe(80);expect(decoded.nodes[rect.id].height).toBe(60)
    const tampered=Uint8Array.from(fd);tampered[tampered.length-1]^=1
    expect(()=>validateProductExport('fd',tampered)).toThrow()
    await click('导出 HTML / 素材 ZIP')
    expect(element.querySelector('[role=alert]')).toBeNull();expect(blobs).toHaveLength(0);expect(calls[1].kind).toBe('html-zip');expect(calls[1].filename).toBe('design-html.zip')
    const zip=calls[1].bytes
    expect(validateProductExport('html-zip',zip).length).toBe(zip.byteLength)
    const files=unzipSync(zip)
    expect(strFromU8(files['index.html'])).toContain('你好 Hello');expect(strFromU8(files['styles.css'])).toContain('.design-scene{')
    const assetName=Object.keys(files).find(name=>name.startsWith('assets/'))
    expect(assetName).toMatch(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/)
    expect(files[assetName!][0]).toBe(0x89)
    const manifest=JSON.parse(strFromU8(files['design-manifest.json']))
    expect(manifest.format).toBe('futureox.design-code.v1');expect(manifest.fidelity).toBe('approximate')
    expect(manifest.assets.some((asset:{path:string;emitted:boolean;dataUrl?:string})=>asset.path===assetName&&asset.emitted===true&&asset.dataUrl===undefined)).toBe(true)
    expect(()=>validateProductExport('html-zip',zipSync({...files,'payload.exe':strToU8('MZ')}))).toThrow()
    await click('导出设计 JSON');expect(blobs).toHaveLength(1);expect(await blobs[0].text()).toContain('你好 Hello')
    const rejected=desktopText['zh-CN'].productExportRejected('html-zip')
    exportProductFile.mockResolvedValueOnce({status:'error',code:'PRODUCT_EXPORT_REJECTED',message:rejected})
    await click('导出 HTML / 素材 ZIP')
    expect(element.querySelector('[role=alert]')?.textContent).toBe(rejected)
    expect(rejected).not.toContain('.fd')
    expect(desktopText['zh-CN'].rejectedDownload('.zip')).not.toContain('.fd')
    expect(desktopText['zh-CN'].rejectedDownload('.zip')).toContain('.zip')
    expect(desktopText.en.rejectedDownload('.sh')).not.toContain('.fd')
  })

  it('reports a missing desktop FD or ZIP channel without starting a blob download',async()=>{
    const blobs:Blob[]=[]
    vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{blobs.push(blob as Blob);return 'blob:missing'})
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    vi.spyOn(dom.window.HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await act(async()=>root.render(<AutomationDialog editor={editor} desktop={{} as DesktopBridge} onClose={()=>{}}/>))
    await click('导出完整 FD')
    expect(blobs).toHaveLength(0);expect(element.querySelector('[role=alert]')?.textContent).toContain('.fd')
    await click('导出 HTML / 素材 ZIP')
    const alert=element.querySelector('[role=alert]')?.textContent??''
    expect(blobs).toHaveLength(0);expect(alert).toContain('ZIP');expect(alert).not.toContain('.fd')
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
