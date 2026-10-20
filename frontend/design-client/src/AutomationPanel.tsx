import { useEffect, useMemo, useRef, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { createEditorDesignAutomation } from './automation'
import { captureDesignPreview, exportDesignCode, exportNativeDocument, exportDesignSvg } from './automation/export'
import type { AutomationBridgeStatus, AutomationConfig, AutomationAuditRecord } from './automation/bridge'

function download(name: string, bytes: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function codeExportZip(result: ReturnType<typeof exportDesignCode>): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(result.html), 'styles.css': strToU8(result.css),
    'design-manifest.json': strToU8(JSON.stringify({ ...result, html: undefined, css: undefined, assets: result.assets.map(a => ({ ...a, dataUrl: undefined })) }, null, 2)),
  }
  for (const asset of result.assets) {
    if (!asset.emitted || !asset.dataUrl) continue
    if (!/^assets\/[a-zA-Z0-9._-]+$/.test(asset.path)) throw new Error('Invalid asset output path')
    const base64 = asset.dataUrl.split(',')[1]
    if (!base64) throw new Error('Invalid embedded asset')
    files[asset.path] = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  }
  return zipSync(files)
}
export function sandboxedCodePreview(result: ReturnType<typeof exportDesignCode>): string {
  let css=result.css
  for(const asset of result.assets)if(asset.emitted&&asset.dataUrl&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(asset.dataUrl))css=css.split(asset.path).join(asset.dataUrl)
  // Inline only our generated stylesheet; CSS '<' must never close the HTML style element.
  css=css.replace(/</g,'\\3c ')
  const policy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`
  return result.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/gi,'').replace('<link rel="stylesheet" href="styles.css">',()=>`<style>${css}</style>`).replace('<head>',()=>`<head>${policy}`)
}
// Compatibility entry: callers keep the same public button component while
// App imports its lightweight launcher without loading this optional dialog.
export { AutomationPanel } from './AutomationPanelLauncher'
export function AutomationDialog({editor,desktop,onClose,onHistory}:{editor:Editor;desktop:DesktopBridge|null|undefined;onClose:()=>void;onHistory?:()=>void}) {
  const api=useMemo(()=>createEditorDesignAutomation(editor),[editor])
  const [status,setStatus]=useState<AutomationBridgeStatus|null>(null)
  const [workspaceScope,setWorkspaceScope]=useState<'none'|'read'|'write'>('none'),[settingsScope,setSettingsScope]=useState<'none'|'read'|'write'>('none')
  const selectedScopes=()=>({...workspaceScope==='none'?{}:{workspaceScope},...settingsScope==='none'?{}:{settingsScope}})
  const scopeLabel=(scope?:'read'|'write')=>scope==='write'?'读写':scope==='read'?'只读':'未授权'
  const [auditSource,setAuditSource]=useState<'all'|'user'|'automation'>('all'),[currentDocOnly,setCurrentDocOnly]=useState(true)
  const [auditRows,setAuditRows]=useState<AutomationAuditRecord[]>([]),[nextAudit,setNextAudit]=useState<number|null>(null)
  const [config,setConfig]=useState<AutomationConfig|null>(null)
  const [filter,setFilter]=useState(''),[result,setResult]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [preview,setPreview]=useState<string|null>(null),[html,setHtml]=useState<string|null>(null)
  const active=useRef<AbortController|null>(null), mounted=useRef(true)
  const bridge=desktop?.automation
  const methods=api.methods().filter(m=>m.name.includes(filter)||m.description.toLowerCase().includes(filter.toLowerCase()))
  useEffect(()=>{
    mounted.current=true
    return()=>{mounted.current=false;active.current?.abort();api.dispose()}
  },[api])
  useEffect(()=>{
    if(!bridge)return
    let alive=true
    void bridge.status().then(s=>{if(alive)setStatus(s)}).catch(e=>{if(alive)setError(String(e))})
    const unsubscribe=bridge.onStatus(s=>{if(alive)setStatus(s)})
    return()=>{alive=false;unsubscribe()}
  },[bridge])
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview)},[preview])
  async function task(action:(signal:AbortSignal)=>Promise<void>|void){
    if(active.current)return
    const controller=new AbortController();active.current=controller;setBusy(true);setError('')
    try{await action(controller.signal)}catch(e){if(mounted.current)setError(e instanceof Error?e.message:String(e))}
    finally{if(active.current===controller)active.current=null;if(mounted.current)setBusy(false)}
  }
  const execute=(method:string,params:Record<string,unknown>={})=>{
    const response=api.execute({method,params,documentId:editor.state.doc.id,expectedRevision:editor.state.version,session:editor.sessionGeneration})
    if(!response.ok)throw new Error(`${response.error.code}: ${response.error.message}`)
    setResult(JSON.stringify(response.result,null,2).slice(0,30000));return response.result
  }
  const readAudit=async(append=false)=>{
    if(!bridge)return
    const rows=await bridge.auditHistory({limit:50,...(currentDocOnly?{documentId:editor.state.doc.id}:{}),...(auditSource==='all'?{}:{source:auditSource}),...(append&&nextAudit!==null?{beforeId:nextAudit}:{})})
    if(!mounted.current)return
    setAuditRows(previous=>append?[...previous,...rows.entries].slice(-500):rows.entries);setNextAudit(rows.hasMore?rows.nextBeforeId??null:null)
  }
  const saveNative=()=>{const data=exportNativeDocument(editor.state.doc);download('design.json',data.content,'application/json')}
  const exportHtml=(view=false)=>{
    const data=exportDesignCode(editor.state.doc,{pageId:editor.state.page,maxNodes:500})
    setResult(JSON.stringify({warnings:data.warnings,assets:data.assets.map(a=>({...a,dataUrl:undefined}))},null,2))
    if(view)setHtml(sandboxedCodePreview(data))
    else download('design-html.zip',codeExportZip(data) as Uint8Array<ArrayBuffer>,'application/zip')
  }
  return <div className="modal-backdrop"><section className="remote-modal" role="dialog" aria-modal="true" aria-label="设计 API 与 MCP" style={{width:'min(900px,95vw)',maxHeight:'90vh',overflow:'auto'}} onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose()}
    if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,iframe')];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
  }}>
    <h2>设计 API 与 MCP <button autoFocus aria-label="关闭设计 API 与 MCP" onClick={onClose}>关闭</button></h2>
    <p>当前文档：{editor.state.doc.name}。共享编辑 API 支持原子修改、撤销、版本冲突检查。模型服务需由你的 AI 客户端提供。</p>
    <fieldset disabled={busy}><legend>本地 MCP 连接</legend>
      {bridge?<><p role="status">{status?.enabled?`已启用 · 当前文档${status.scope==='write'?'可读写':'只读'} · ${status.connectedClients} 个连接`:'未启用'}；文档切换将撤销连接授权。</p>
        {status?.enabled&&<p>已授权范围：工作区{scopeLabel(status.grants?.workspace)} · 应用设置{scopeLabel(status.grants?.settings)}</p>}
        <label>工作区与文档库 <select aria-label="工作区 MCP 权限" value={workspaceScope} onChange={event=>setWorkspaceScope(event.target.value as typeof workspaceScope)}><option value="none">不授权</option><option value="read">只读</option><option value="write">读写</option></select></label>
        <label>应用偏好 <select aria-label="设置 MCP 权限" value={settingsScope} onChange={event=>setSettingsScope(event.target.value as typeof settingsScope)}><option value="none">不授权</option><option value="read">只读</option><option value="write">读写</option></select></label>
        <p>附加范围默认不授权。选择后需点击启用并通过原生确认；访问授权绑定当前工作区，应用偏好仍按当前应用配置保存。切换文档、恢复历史和工作区重启会再次确认，未保存内容或输入草稿会阻止切换。</p>
        <button onClick={()=>void task(async()=>setStatus(await bridge.enable({scope:'read',...selectedScopes()})))}>启用只读</button>
        <button onClick={()=>void task(async()=>setStatus(await bridge.enable({scope:'write',...selectedScopes()})))}>启用读写</button>
        <button disabled={!status?.enabled} onClick={()=>void task(async()=>setStatus(await bridge.disable()))}>停用</button>
        <button disabled={!status?.enabled} onClick={()=>void task(async()=>{const r=await bridge.copyConnection();setResult(r.copied?'连接配置已复制，请仅粘贴到可信本地 AI 客户端。不要分享其中的临时凭据。':'未复制连接配置')})}>复制连接配置</button>
      </>:<p>Web 版可使用下方编辑 API、检查和导出；本地外部 MCP 连接需要 Electron 桌面版。</p>}
    </fieldset>
    <fieldset disabled={busy}><legend>检查、预览与导入导出</legend>
      <button onClick={()=>void task(()=>{execute('context.get',{pageId:editor.state.page,limit:100})})}>读取 AI 上下文</button>
      <button onClick={()=>void task(()=>{execute('design.check',{pageId:editor.state.page})})}>检查当前页面</button>
      <button onClick={()=>void task(async signal=>{const doc=editor.state.doc,session=editor.sessionGeneration;const output=await captureDesignPreview(doc,{pageId:editor.state.page,signal});if(signal.aborted||!mounted.current||session!==editor.sessionGeneration||doc!==editor.state.doc)throw new Error('预览已过时，请重试');setPreview(output.dataUrl)})}>生成页面预览</button>
      <button onClick={()=>void task(()=>{execute('font.list')})}>检查字体</button>
      <button onClick={()=>void task(()=>{const r=api.execute({method:'document.export',params:{format:'fd'}});if(!r.ok)throw new Error(r.error.message);const out=r.result as {base64:string;encoding?:string;filename?:string;mimeType?:string};if(out.encoding!=='base64')throw new Error('FD 编码未就绪');const bytes=Uint8Array.from(atob(out.base64),c=>c.charCodeAt(0));download(out.filename??'design.fd',bytes,'application/octet-stream')})}>导出完整 FD</button>
      <button onClick={()=>void task(saveNative)}>导出设计 JSON</button>
      <button onClick={()=>void task(()=>{const r=api.execute({method:'sketch.export',params:{}});if(!r.ok)throw new Error(r.error.message);const out=r.result as {base64:string;filename:string;mimeType:string;warnings:unknown[];lossless:boolean};const bytes=Uint8Array.from(atob(out.base64),c=>c.charCodeAt(0));download(out.filename,bytes,out.mimeType);setResult(JSON.stringify({lossless:out.lossless,warnings:out.warnings},null,2))})}>导出 Sketch</button>
      <button onClick={()=>void task(()=>{const out=exportDesignSvg(editor.state.doc,{pageId:editor.state.page,maxNodes:500});download(out.filename,out.content ?? Uint8Array.from(atob(out.base64!), c => c.charCodeAt(0)),out.mimeType);setResult(JSON.stringify(out.warnings,null,2))})}>导出 SVG</button>
      <button onClick={()=>void task(()=>exportHtml(false))}>导出 HTML / 素材 ZIP</button>
      <button onClick={()=>void task(()=>exportHtml(true))}>预览 HTML</button>
      <label>导入 FD / Sketch / JSON（追加）<input type="file" accept=".fd,.sketch,.json,application/json" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;const revision=editor.state.version,session=editor.sessionGeneration;void task(async signal=>{if(file.size>24*1024*1024)throw new Error('导入文件超过 24 MiB');const isFd=file.name.toLowerCase().endsWith('.fd'),isSketch=file.name.toLowerCase().endsWith('.sketch');let content:string;if(isFd||isSketch){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));content=btoa(binary)}else content=await file.text();if(signal.aborted||!mounted.current||revision!==editor.state.version||session!==editor.sessionGeneration)throw new Error('文档已变化，导入取消');if(isSketch)execute('sketch.import',{base64:content,name:file.name.slice(0,200),pageId:editor.state.page});else execute('document.import',{format:isFd?'fd':'native-json',...(isFd?{base64:content}:{content}),pageId:editor.state.page})})}}/></label>
    </fieldset>
    {bridge&&<fieldset disabled={busy}><legend>SQLite 本地记录</legend>
      <p>只记录操作名称、状态、耗时等元数据，不保存临时令牌、设计内容或 AI 提示词。</p>
      <button onClick={()=>void task(async()=>{const next=await bridge.config();if(mounted.current)setConfig(next)})}>读取记录设置</button>
      <label><input type="checkbox" checked={currentDocOnly} onChange={e=>{setCurrentDocOnly(e.target.checked);setAuditRows([]);setNextAudit(null)}}/>仅当前文档</label>
      <label>来源 <select aria-label="编辑记录来源" value={auditSource} onChange={e=>{setAuditSource(e.target.value as typeof auditSource);setAuditRows([]);setNextAudit(null)}}><option value="all">全部</option><option value="user">手动编辑</option><option value="automation">AI / API</option></select></label>
      <button onClick={()=>void task(()=>readAudit())}>查看持久化记录</button>
      {nextAudit!==null&&<button onClick={()=>void task(()=>readAudit(true))}>加载更早记录</button>}
      {onHistory&&<button onClick={()=>{onClose();onHistory()}}>文档版本与恢复</button>}
      <p>编辑日志不是历史快照；恢复请使用“文档版本与恢复”。手动编辑与 API 修改单独标记，API 来源也可能是其它自动化客户端。</p>
      {!!auditRows.length&&<table><thead><tr><th>时间</th><th>来源</th><th>操作</th><th>版本</th><th>状态</th><th>详情</th></tr></thead><tbody>{auditRows.map((row,i)=><tr key={String(row.id??i)}><td>{typeof row.createdAt==='number'?new Date(row.createdAt).toLocaleString():String(row.createdAt??'')}</td><td>{row.source==='user'?'手动':row.source==='automation'?'AI / API':'连接'}</td><td>{String(row.summary??row.method??row.event??'')}</td><td>{String(row.revision??'—')}</td><td>{String(row.status??'')}</td><td><details><summary>查看</summary><pre>{JSON.stringify(row,null,2)}</pre></details></td></tr>)}</tbody></table>}
      {config&&<><label><input type="checkbox" checked={config.auditEnabled} onChange={e=>setConfig({...config,auditEnabled:e.target.checked})}/>记录操作元数据</label>
      <label>保留天数 <input type="number" min={1} max={365} value={config.retentionDays} onChange={e=>setConfig({...config,retentionDays:Number(e.target.value)})}/></label>
      <button onClick={()=>void task(async()=>{const next=await bridge.configure({auditEnabled:config.auditEnabled,retentionDays:config.retentionDays});if(mounted.current)setConfig(next)})}>保存记录设置</button></>}
    </fieldset>}
    {busy&&<button onClick={()=>active.current?.abort()}>取消当前操作</button>}
    {error&&<p role="alert">{error}</p>}
    {preview&&<img src={preview} alt="当前设计页面预览" style={{maxWidth:'100%',maxHeight:320,objectFit:'contain'}}/>}
    {html&&<iframe title="HTML 隔离预览" sandbox="" srcDoc={html} style={{width:'100%',height:400,border:'1px solid #999'}}/>}
    <details><summary>AI 调用说明</summary><p>先获取 api.capabilities 和 context.get；写操作携带 documentId、session、expectedRevision。使用 batch.apply 一次提交关联修改，调用 design.check 和 preview.capture 检查结果，按节点 ID 局部调整。遇到版本冲突重新读取，不能盲目覆盖。建议每次最多 5 轮修正；不能将启发式检查等同于审美或像素验收。</p><p>HTML 是可编辑近似表达；原生 JSON 保留设计结构。字体、素材或效果无法导出时查看警告。</p></details>
    <label>筛选工具 <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="node / component / variable / export"/></label>
    <p>{methods.length} 个共享编辑工具；桌面 MCP 另提供 preview.capture 异步预览；显式授权后另有 10 个工作区与设置工具。</p>
    {methods.map(m=><details key={m.name}><summary>{m.name} · {m.mutates?'修改':'读取'}</summary><p>{m.description}</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(m.inputSchema,null,2)}</pre></details>)}
    {!!result&&<details open><summary>操作结果（最多显示 30,000 字符）</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:300,overflow:'auto'}}>{result}</pre></details>}
    {!!status?.journal.length&&<details><summary>近期执行记录</summary>{status.journal.slice(-50).reverse().map(entry=><p key={entry.id}>{entry.method} · {entry.status} {entry.code??''} {entry.durationMs===undefined?'':`${entry.durationMs.toFixed(1)} ms`}</p>)}</details>}
    {status?.auditError&&<p role="alert">持久化记录不可用：{status.auditError}</p>}
  </section></div>
}
