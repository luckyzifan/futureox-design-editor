import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { DOCUMENT_BYTE_LIMIT } from './document-capacity.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Invalid large document request')
  return value
}
export function admitLargeStatus(value, expected) {
  if (!object(value) || !object(value.owner) || typeof value.owner.documentId !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(value.owner.documentId) ||
      !integer(value.owner.sessionEpoch) || !value.owner.sessionEpoch || !integer(value.revision) || !integer(value.expandedBytes) ||
      !integer(value.maxExpandedBytes) || value.maxExpandedBytes === 0 || value.expandedBytes > value.maxExpandedBytes ||
      !integer(value.indexedObjects) || typeof value.name !== 'string' || value.name.length > 4096 ||
      !['json','sketch'].includes(value.format) || typeof value.dirty !== 'boolean' || !integer(value.undoCount) || !integer(value.redoCount) ||
      expected && (value.owner.documentId !== expected.documentId || value.owner.sessionEpoch !== expected.sessionEpoch)) throw Error('Invalid large document response')
  return value
}

/** Native dialogs grant paths. Renderer content receives only a session owner
 * and bounded JSON fragments; no arbitrary path or RPC method is forwarded. */
export class LargeDocumentHost {
  #active; #epoch = 0; #busy = false
  constructor(request, dialog, window, cancel) { this.request = request; this.dialog = dialog; this.window = window; this.cancelWork=cancel }
  async #exclusive(work) {
    if (this.#busy) throw Error('Large document operation is busy')
    this.#busy = true
    try { return await work() } finally { this.#busy = false }
  }
  #check(value, keys) {
    fields(value, keys); fields(value.owner, ['documentId','sessionEpoch'])
    const active = this.#active
    if (!active || active.window !== this.window() || active.window.isDestroyed() || value.owner.documentId !== active.status.owner.documentId ||
      value.owner.sessionEpoch !== active.status.owner.sessionEpoch || value.expectedRevision !== active.status.revision) throw Error('Stale or foreign large document request')
    return active
  }
  async open(value, selectedPath) { return this.#exclusive(async () => {
    if (value !== undefined) throw Error('Unexpected large document open arguments')
    if (this.#active) {
      if (selectedPath) throw Error('Close the current large document before opening another')
      const active = this.#active
      if (active.window !== this.window()) throw Error('Large document belongs to another window')
      active.status = admitLargeStatus(await this.request('large.status', { owner: active.status.owner, expectedRevision: active.status.revision }), active.status.owner)
      return { status:'ok', ...active.status }
    }
    const window = this.window(), selected = selectedPath ? {canceled:false,filePaths:[selectedPath]} : await this.dialog.showOpenDialog(window, {
      title:'打开大型 JSON / Sketch（按需编辑）', properties:['openFile'], filters:[{name:'JSON / Sketch',extensions:['json','sketch']}],
    })
    if (selected.canceled || selected.filePaths.length !== 1 || window !== this.window() || window.isDestroyed()) return {status:'cancelled'}
    const format=path.extname(selected.filePaths[0]).slice(1).toLowerCase()
    if(!['json','sketch'].includes(format))throw Error('Choose a JSON or Sketch source')
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) throw Error('Large document session epoch exhausted')
    const owner = { documentId:randomUUID(), sessionEpoch:++this.#epoch }
    this.#active={window,status:{owner,revision:0,name:path.basename(selected.filePaths[0]),format,expandedBytes:0,maxExpandedBytes:0,indexedObjects:0,dirty:false,undoCount:0,redoCount:0}}
    let result
    try{result=admitLargeStatus(await this.request('large.open', {path:selected.filePaths[0],...owner}), owner)}
    catch(error){if(error?.outcomeUnknown!==true)this.#active=undefined;throw error}
    if (window !== this.window() || window.isDestroyed()) {
      await this.request('large.close',{owner,expectedRevision:result.revision}); this.#active=undefined;return {status:'cancelled'}
    }
    this.#active = {window,status:result}; return {status:'ok',...result}
  }) }
  async read(value) {
    const active = this.#check(value,['owner','expectedRevision','key'])
    this.#key(value.key)
    const result = await this.request('large.read',value)
    this.#check(value,['owner','expectedRevision','key'])
    if (!object(result) || typeof result.json !== 'string' || Buffer.byteLength(result.json)>2*1024**2 || !/^[0-9a-f]{64}$/.test(result.hash) || !Array.isArray(result.omittedFields) || result.omittedFields.some(x=>typeof x!=='string')) throw Error('Invalid JSON fragment response')
    return {status:'ok',...result}
  }
  #key(key) { if (typeof key!=='string'||!/^\d{1,5}:\d{1,7}$/.test(key)) throw Error('Invalid large document object key') }
  async children(value) {
    const active=this.#check(value,['owner','expectedRevision','key','offset','limit','query'])
    if(value.key!==undefined)this.#key(value.key)
    if(!integer(value.offset??0)||!integer(value.limit??100)||(value.limit??100)>200)throw Error('Invalid JSON listing range')
    if(value.query!==undefined&&(typeof value.query!=='string'||value.query.length>256))throw Error('Invalid JSON search')
    const result=await this.request('large.children',value)
    this.#check(value,['owner','expectedRevision','key','offset','limit','query'])
    if(!object(result)||!Array.isArray(result.items)||result.items.length>200||!integer(result.total))throw Error('Invalid JSON listing response')
    for(const row of result.items){this.#key(row.key);if(typeof row.name!=='string'||row.name.length>640||typeof row.kind!=='string'||!integer(row.bytes)||row.bytes>active.status.maxExpandedBytes)throw Error('Invalid JSON listing row')}
    return {status:'ok',...result}
  }
  async apply(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision','key','json','expectedHash']);this.#key(value.key)
    if(typeof value.json!=='string'||Buffer.byteLength(value.json)>2*1024**2||typeof value.expectedHash!=='string'||!/^[0-9a-f]{64}$/.test(value.expectedHash))throw Error('Invalid JSON fragment edit')
    active.status=admitLargeStatus(await this.request('large.apply',{...value,requestId:randomUUID()}),active.status.owner)
    return {status:'ok',...active.status}
  }) }
  async project(value) {
    this.#check(value,['owner','expectedRevision','key']);this.#key(value.key)
    const result=await this.request('large.project',{...value,workingDocumentId:randomUUID()})
    this.#check(value,['owner','expectedRevision','key'])
    if(!object(result)||typeof result.json!=='string'||Buffer.byteLength(result.json)>2*1024**2||!Array.isArray(result.warnings)||result.warnings.some(v=>typeof v!=='string'))throw Error('Invalid canvas working set')
    return {status:'ok',...result}
  }
  async commitCanvas(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision','key','json']);this.#key(value.key)
    if(typeof value.json!=='string'||Buffer.byteLength(value.json)>2*1024**2)throw Error('Canvas working set exceeds 2 MiB')
    active.status=admitLargeStatus(await this.request('large.commitCanvas',{...value,requestId:randomUUID()}),active.status.owner)
    return {status:'ok',...active.status}
  }) }
  async scene(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision','key']);this.#key(value.key)
    if(active.status.format==='json') {
      const result=await this.project(value)
      return {...result,bytes:Buffer.byteLength(result.json),nodes:Object.keys(JSON.parse(result.json).nodes).length}
    }
    const result=await this.request('large.scene',value)
    this.#check(value,['owner','expectedRevision','key'])
    if(!object(result)||!integer(result.bytes)||result.bytes>DOCUMENT_BYTE_LIMIT||!/^[0-9a-f]{64}$/.test(result.hash)||!Array.isArray(result.warnings)||result.warnings.some(v=>typeof v!=='string'))throw Error('Invalid source scene response')
    const bytes=Buffer.alloc(result.bytes)
    for(let offset=0;offset<bytes.length;){
      const chunk=await this.request('large.sceneRead',{...value,offset})
      this.#check(value,['owner','expectedRevision','key'])
      if(chunk?.offset!==offset||chunk.bytes!==result.bytes||chunk.hash!==result.hash||typeof chunk.data!=='string'||chunk.data.length>700000)throw Error('Invalid source scene chunk')
      const data=Buffer.from(chunk.data,'base64')
      if(!data.length||data.length>512*1024||offset+data.length>bytes.length||data.toString('base64')!==chunk.data)throw Error('Invalid source scene chunk size')
      data.copy(bytes,offset);offset+=data.length
    }
    if(createHash('sha256').update(bytes).digest('hex')!==result.hash)throw Error('Source scene transfer hash mismatch')
    return {status:'ok',...result,json:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
  }) }
  async sceneCommit(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision','key','json']);this.#key(value.key)
    if(typeof value.json!=='string'||Buffer.byteLength(value.json)>2*1024**2)throw Error('Source edit transaction exceeds 2 MiB')
    active.status=admitLargeStatus(await this.request('large.sceneCommit',{...value,requestId:randomUUID()}),active.status.owner)
    return {status:'ok',...active.status}
  }) }
  async history(kind,value) { return this.#exclusive(async()=>{
    if(!['undo','redo'].includes(kind))throw Error('Invalid JSON history action')
    const active=this.#check(value,['owner','expectedRevision'])
    active.status=admitLargeStatus(await this.request('large.'+kind,{...value,requestId:randomUUID()}),active.status.owner)
    return {status:'ok',...active.status}
  }) }
  async export(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision']),window=this.window()
    const selected=await this.dialog.showSaveDialog(window,{title:'导出完整文件',defaultPath:active.status.name.replace(/\.(json|sketch)$/i,`-edited.${active.status.format}`),filters:[{name:active.status.format,extensions:[active.status.format]}]})
    if(selected.canceled||!selected.filePath||window!==this.window()||window.isDestroyed())return {status:'cancelled'}
    this.#check(value,['owner','expectedRevision'])
    const result=await this.request('large.export',{...value,path:selected.filePath,requestId:randomUUID()})
    if(result.exported!==true)throw Error('Large document export was not confirmed')
    active.status=admitLargeStatus(result.document,active.status.owner)
    return {status:'ok',...active.status,exported:true,displayName:path.basename(selected.filePath),...(result.warning?{saveWarning:result.warning}:{})}
  }) }
  async close(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision'])
    await this.request('large.close',value);this.#active=undefined;return {status:'ok'}
  }) }
  async cancel(value) {
    if(value!==undefined||!this.#active||this.#active.window!==this.window()||this.#active.window.isDestroyed()||typeof this.cancelWork!=='function')throw Error('No owned large document operation can be cancelled')
    return {status:'ok',...await this.cancelWork()}
  }
  async progress(value) {
    if(value!==undefined)throw Error('Unexpected progress arguments')
    const active=this.#active
    if(!active||active.window!==this.window()||active.window.isDestroyed())return {status:'cancelled'}
    const result=await this.request('large.progress',{owner:active.status.owner,expectedRevision:active.status.revision})
    if(this.#active!==active)return {status:'cancelled'}
    if(!object(result)||result.owner?.documentId!==active.status.owner.documentId||result.owner?.sessionEpoch!==active.status.owner.sessionEpoch||
      !['validate','copy','expand','index','export','idle'].includes(result.phase)||!integer(result.processedBytes)||!integer(result.totalBytes))throw Error('Invalid large document progress')
    return {status:'ok',...result}
  }
}
