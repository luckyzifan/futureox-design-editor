import { useEffect, useMemo, useRef, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { useInterfacePreferences } from './interface-preference'
import { automationScopeLabel, automationText } from './automation-interface-messages'
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
  const text = automationText[useInterfacePreferences().locale]
  const scopeLabel = (scope?: 'read' | 'write') => automationScopeLabel(text, scope)
  const api=useMemo(()=>createEditorDesignAutomation(editor),[editor])
  const [status,setStatus]=useState<AutomationBridgeStatus|null>(null)
  const [workspaceScope,setWorkspaceScope]=useState<'none'|'read'|'write'>('none'),[settingsScope,setSettingsScope]=useState<'none'|'read'|'write'>('none')
  const selectedScopes=()=>({...workspaceScope==='none'?{}:{workspaceScope},...settingsScope==='none'?{}:{settingsScope}})
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
  return <div className="modal-backdrop"><section className="remote-modal automation-dialog" role="dialog" aria-modal="true" aria-label={text.title} style={{width:'min(920px, calc(100vw - 32px))',maxHeight:'90vh',overflow:'auto'}} onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose()}
    if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,iframe')];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
  }}>
    <h2>{text.title} <button autoFocus aria-label={text.closeLabel} onClick={onClose}>{text.close}</button></h2>
    <p>{text.intro}{editor.state.doc.name}{text.introRest}</p>
    <fieldset disabled={busy}><legend>{text.connection}</legend>
      {bridge?<><p role="status">{status?.enabled?`${text.enabled} · ${status.scope==='write'?text.documentReadWrite:text.documentReadOnly} · ${status.connectedClients} ${text.connections}`:text.disabled}{text.revokeNote}</p>
        {status?.enabled&&<p>{text.grants}{text.workspace}{scopeLabel(status.grants?.workspace)} · {text.settings}{scopeLabel(status.grants?.settings)}</p>}
        <label>{text.workspaceLibrary} <select aria-label={text.workspacePermission} value={workspaceScope} onChange={event=>setWorkspaceScope(event.target.value as typeof workspaceScope)}><option value="none">{text.none}</option><option value="read">{text.read}</option><option value="write">{text.write}</option></select></label>
        <label>{text.preferences} <select aria-label={text.settingsPermission} value={settingsScope} onChange={event=>setSettingsScope(event.target.value as typeof settingsScope)}><option value="none">{text.none}</option><option value="read">{text.read}</option><option value="write">{text.write}</option></select></label>
        <p>{text.scopeHelp}</p>
        <button onClick={()=>void task(async()=>setStatus(await bridge.enable({scope:'read',...selectedScopes()})))}>{text.enableRead}</button>
        <button onClick={()=>void task(async()=>setStatus(await bridge.enable({scope:'write',...selectedScopes()})))}>{text.enableWrite}</button>
        <button disabled={!status?.enabled} onClick={()=>void task(async()=>setStatus(await bridge.disable()))}>{text.disable}</button>
        <button disabled={!status?.enabled} onClick={()=>void task(async()=>{const r=await bridge.copyConnection();setResult(r.copied?text.copied:text.notCopied)})}>{text.copyConnection}</button>
      </>:<p>{text.webOnly}</p>}
    </fieldset>
    <fieldset disabled={busy}><legend>{text.inspect}</legend>
      <button onClick={()=>void task(()=>{execute('context.get',{pageId:editor.state.page,limit:100})})}>{text.readContext}</button>
      <button onClick={()=>void task(()=>{execute('design.check',{pageId:editor.state.page})})}>{text.checkPage}</button>
      <button onClick={()=>void task(async signal=>{const doc=editor.state.doc,session=editor.sessionGeneration;const output=await captureDesignPreview(doc,{pageId:editor.state.page,signal});if(signal.aborted||!mounted.current||session!==editor.sessionGeneration||doc!==editor.state.doc)throw new Error(text.stalePreview);setPreview(output.dataUrl)})}>{text.previewPage}</button>
      <button onClick={()=>void task(()=>{execute('font.list')})}>{text.checkFonts}</button>
      <button onClick={()=>void task(()=>{const r=api.execute({method:'document.export',params:{format:'fd'}});if(!r.ok)throw new Error(r.error.message);const out=r.result as {base64:string;encoding?:string;filename?:string;mimeType?:string};if(out.encoding!=='base64')throw new Error(text.fdNotReady);const bytes=Uint8Array.from(atob(out.base64),c=>c.charCodeAt(0));download(out.filename??'design.fd',bytes,'application/octet-stream')})}>{text.exportFd}</button>
      <button onClick={()=>void task(saveNative)}>{text.exportJson}</button>
      <button onClick={()=>void task(()=>{const r=api.execute({method:'sketch.export',params:{}});if(!r.ok)throw new Error(r.error.message);const out=r.result as {base64:string;filename:string;mimeType:string;warnings:unknown[];lossless:boolean};const bytes=Uint8Array.from(atob(out.base64),c=>c.charCodeAt(0));download(out.filename,bytes,out.mimeType);setResult(JSON.stringify({lossless:out.lossless,warnings:out.warnings},null,2))})}>{text.exportSketch}</button>
      <button onClick={()=>void task(()=>{const out=exportDesignSvg(editor.state.doc,{pageId:editor.state.page,maxNodes:500});download(out.filename,out.content ?? Uint8Array.from(atob(out.base64!), c => c.charCodeAt(0)),out.mimeType);setResult(JSON.stringify(out.warnings,null,2))})}>{text.exportSvg}</button>
      <button onClick={()=>void task(()=>exportHtml(false))}>{text.exportHtml}</button>
      <button onClick={()=>void task(()=>exportHtml(true))}>{text.previewHtml}</button>
      <label>{text.importLabel}<input type="file" accept=".fd,.sketch,.json,application/json" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;const revision=editor.state.version,session=editor.sessionGeneration;void task(async signal=>{if(file.size>24*1024*1024)throw new Error(text.importTooLarge);const isFd=file.name.toLowerCase().endsWith('.fd'),isSketch=file.name.toLowerCase().endsWith('.sketch');let content:string;if(isFd||isSketch){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));content=btoa(binary)}else content=await file.text();if(signal.aborted||!mounted.current||revision!==editor.state.version||session!==editor.sessionGeneration)throw new Error(text.importCancelled);if(isSketch)execute('sketch.import',{base64:content,name:file.name.slice(0,200),pageId:editor.state.page});else execute('document.import',{format:isFd?'fd':'native-json',...(isFd?{base64:content}:{content}),pageId:editor.state.page})})}}/></label>
    </fieldset>
    {bridge&&<fieldset disabled={busy}><legend>{text.audit}</legend>
      <p>{text.auditHelp}</p>
      <button onClick={()=>void task(async()=>{const next=await bridge.config();if(mounted.current)setConfig(next)})}>{text.readAuditSettings}</button>
      <label><input type="checkbox" checked={currentDocOnly} onChange={e=>{setCurrentDocOnly(e.target.checked);setAuditRows([]);setNextAudit(null)}}/>{text.currentDocumentOnly}</label>
      <label>{text.source} <select aria-label={text.sourceLabel} value={auditSource} onChange={e=>{setAuditSource(e.target.value as typeof auditSource);setAuditRows([]);setNextAudit(null)}}><option value="all">{text.all}</option><option value="user">{text.manual}</option><option value="automation">{text.aiApi}</option></select></label>
      <button onClick={()=>void task(()=>readAudit())}>{text.viewAudit}</button>
      {nextAudit!==null&&<button onClick={()=>void task(()=>readAudit(true))}>{text.loadOlder}</button>}
      {onHistory&&<button onClick={()=>{onClose();onHistory()}}>{text.versions}</button>}
      <p>{text.auditNote}</p>
      {!!auditRows.length&&<table><thead><tr><th>{text.time}</th><th>{text.source}</th><th>{text.operation}</th><th>{text.revision}</th><th>{text.status}</th><th>{text.detail}</th></tr></thead><tbody>{auditRows.map((row,i)=><tr key={String(row.id??i)}><td>{typeof row.createdAt==='number'?new Date(row.createdAt).toLocaleString():String(row.createdAt??'')}</td><td>{row.source==='user'?text.manual:row.source==='automation'?text.aiApi:text.connectionEvent}</td><td>{String(row.summary??row.method??row.event??'')}</td><td>{String(row.revision??'—')}</td><td>{String(row.status??'')}</td><td><details><summary>{text.view}</summary><pre>{JSON.stringify(row,null,2)}</pre></details></td></tr>)}</tbody></table>}
      {config&&<><label><input type="checkbox" checked={config.auditEnabled} onChange={e=>setConfig({...config,auditEnabled:e.target.checked})}/>{text.recordMetadata}</label>
      <label>{text.retentionDays} <input type="number" min={1} max={365} value={config.retentionDays} onChange={e=>setConfig({...config,retentionDays:Number(e.target.value)})}/></label>
      <button onClick={()=>void task(async()=>{const next=await bridge.configure({auditEnabled:config.auditEnabled,retentionDays:config.retentionDays});if(mounted.current)setConfig(next)})}>{text.saveAuditSettings}</button></>}
    </fieldset>}
    {busy&&<button onClick={()=>active.current?.abort()}>{text.cancelAction}</button>}
    {error&&<p role="alert">{error}</p>}
    {preview&&<img src={preview} alt={text.previewAlt} style={{maxWidth:'100%',maxHeight:320,objectFit:'contain'}}/>}
    {html&&<iframe title={text.htmlPreview} sandbox="" srcDoc={html} style={{width:'100%',height:400,border:'1px solid #999'}}/>}
    <details><summary>{text.aiHelpTitle}</summary><p>{text.aiHelp}</p><p>{text.htmlNote}</p></details>
    <label>{text.filterTools} <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder={text.filterPlaceholder}/></label>
    <p>{methods.length} {text.toolCount}</p>
    {methods.map(m=><details key={m.name}><summary>{m.name} · {m.mutates?text.mutates:text.reads}</summary><p>{m.description}</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(m.inputSchema,null,2)}</pre></details>)}
    {!!result&&<details open><summary>{text.result}</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:300,overflow:'auto'}}>{result}</pre></details>}
    {!!status?.journal.length&&<details><summary>{text.recent}</summary>{status.journal.slice(-50).reverse().map(entry=><p key={entry.id}>{entry.method} · {entry.status} {entry.code??''} {entry.durationMs===undefined?'':`${entry.durationMs.toFixed(1)} ms`}</p>)}</details>}
    {status?.auditError&&<p role="alert">{text.auditUnavailable}{status.auditError}</p>}
  </section></div>
}
