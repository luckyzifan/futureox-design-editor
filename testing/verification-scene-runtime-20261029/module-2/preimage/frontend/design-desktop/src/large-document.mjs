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
  #key(key) {
    if(typeof key!=='string')throw Error('Invalid large document object key')
    const parts=key.split(':')
    if(parts.length!==2||parts.some(part=>!/^(0|[1-9][0-9]*)$/.test(part)||!integer(Number(part))||String(Number(part))!==part))throw Error('Invalid large document object key')
  }
  async canvasLayout(value) {
    this.#check(value,['owner','expectedRevision','offset','limit'])
    if(!integer(value.offset??0)||!integer(value.limit??200)||(value.limit??200)<1||(value.limit??200)>200)throw Error('Invalid canvas catalogue range')
    const result=await this.request('large.canvasLayout',value)
    this.#check(value,['owner','expectedRevision','offset','limit'])
    const box=(value)=>object(value)&&['x','y','width','height'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))&&value.width>=0&&value.height>=0
    if(!object(result)||!object(result.owner)||result.owner.documentId!==value.owner.documentId||result.owner.sessionEpoch!==value.owner.sessionEpoch||
      result.revision!==value.expectedRevision||!box(result.bounds)||!Array.isArray(result.items)||result.items.length>(value.limit??200)||
      !integer(result.total)||result.offset!==(value.offset??0)||result.items.length>Math.max(0,result.total-result.offset)||
      result.hasMore!==(result.offset+result.items.length<result.total)||result.boundsAreLayoutHints!==true||
      result.offset<result.total&&!result.items.length)throw Error('Invalid canvas catalogue response')
    for(const row of result.items){
      this.#key(row.key)
      if(!box(row.source)||!box(row.placed)||!integer(row.bytes)||
        ['id','name','kind','pageId','pageName'].some(key=>typeof row[key]!=='string'))throw Error('Invalid canvas catalogue item')
    }
    return {status:'ok',...result}
  }
  async canvasSnapshot(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision'])
    if(active.snapshot?.revision===active.status.revision)return {status:'ok',...active.snapshot.public}
    const result=await this.request('large.canvasSnapshot',value)
    this.#check(value,['owner','expectedRevision'])
    const box=result?.bounds
    if(!object(result)||result.owner?.documentId!==value.owner.documentId||result.owner?.sessionEpoch!==value.owner.sessionEpoch||result.revision!==value.expectedRevision||
      typeof result.path!=='string'||!path.isAbsolute(result.path)||path.normalize(result.path)!==result.path||path.basename(result.path)!==`canvas-native-${result.revision}.json`||
      !integer(result.bytes)||result.bytes===0||!integer(result.nodes)||!result.nodes||!integer(result.roots)||!result.roots||
      typeof result.hash!=='string'||!/^[0-9a-f]{64}$/.test(result.hash)||
      ['pageId','stageId'].some(key=>typeof result[key]!=='string'||!/^[a-z0-9-]{1,128}$/i.test(result[key]))||
      !object(box)||!['x','y','width','height'].every(key=>typeof box[key]==='number'&&Number.isFinite(box[key]))||box.width<=0||box.height<=0||
      !['analytic','figma','figmaSubpixel','figmaSoftware'].includes(result.rasterProfile)||typeof result.colorManaged!=='boolean'||
      !Array.isArray(result.warnings)||result.warnings.some(value=>typeof value!=='string'))throw Error('Invalid native canvas snapshot')
    const token=randomUUID(),revision=result.revision
    const descriptor=Object.freeze({path:result.path,bytes:result.bytes,hash:result.hash,documentId:value.owner.documentId,pageId:result.pageId,stageId:result.stageId,nodes:result.nodes})
    const snapshot={token,revision,descriptor,public:{owner:{...value.owner},revision,token,bytes:result.bytes,nodes:result.nodes,roots:result.roots,
      pageId:result.pageId,stageId:result.stageId,bounds:{...box},warnings:[...result.warnings],rasterProfile:result.rasterProfile,colorManaged:result.colorManaged}}
    active.snapshot=snapshot
    return {status:'ok',...snapshot.public}
  }) }
  /** Host-only capability resolution. A renderer token never supplies a path. */
  resolveCanvasSnapshot(token,senderId) {
    const active=this.#active,snapshot=active?.snapshot
    const current=()=>{
      if(!snapshot||typeof token!=='string'||snapshot.token!==token||this.#active!==active||active.window!==this.window()||
        active.window.isDestroyed()||active.window.webContents?.id!==senderId||active.status.revision!==snapshot.revision)
        throw Error('Stale or foreign source canvas capability')
    }
    current()
    return {descriptor:snapshot.descriptor,assertCurrent:current}
  }
  async children(value) {
    const active=this.#check(value,['owner','expectedRevision','key','offset','limit','query','canvasOnly'])
    if(value.key!==undefined)this.#key(value.key)
    if(!integer(value.offset??0)||!integer(value.limit??100)||(value.limit??100)>200)throw Error('Invalid JSON listing range')
    if(value.query!==undefined&&(typeof value.query!=='string'||value.query.length>256))throw Error('Invalid JSON search')
    if(value.canvasOnly!==undefined&&typeof value.canvasOnly!=='boolean')throw Error('Invalid source listing scope')
    const result=await this.request('large.children',value)
    this.#check(value,['owner','expectedRevision','key','offset','limit','query','canvasOnly'])
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
    const active=this.#check(value,['owner','expectedRevision','key','offset','limit']);this.#key(value.key)
    if(!integer(value.offset??0))throw Error('Invalid page working-set offset')
    if(value.limit!==undefined&&(!integer(value.limit)||value.limit<1))throw Error('Invalid page working-set limit')
    if(active.status.format==='json') {
      if(value.offset||value.limit!==undefined)throw Error('JSON objects do not have page working sets')
      const {offset,...projectRequest}=value
      const result=await this.project(projectRequest)
      return {...result,bytes:Buffer.byteLength(result.json),nodes:Object.keys(JSON.parse(result.json).nodes).length}
    }
    const result=await this.request('large.scene',value)
    this.#check(value,['owner','expectedRevision','key','offset','limit'])
    if(!object(result)||!integer(result.bytes)||result.bytes>DOCUMENT_BYTE_LIMIT||!/^[0-9a-f]{64}$/.test(result.hash)||!Array.isArray(result.warnings)||result.warnings.some(v=>typeof v!=='string'))throw Error('Invalid source scene response')
    const range=result.pageRange
    if((value.offset||value.limit!==undefined)&&range==null)throw Error('Missing source page range')
    if(range!=null&&(!object(range)||!integer(range.offset)||!integer(range.end)||!integer(range.totalRoots)||range.offset!==(value.offset??0)||range.end<=range.offset||range.end>range.totalRoots||value.limit!==undefined&&range.end-range.offset>value.limit||range.nextOffset!==(range.end<range.totalRoots?range.end:null)))throw Error('Invalid source page range')
    const bytes=Buffer.alloc(result.bytes)
    for(let offset=0;offset<bytes.length;){
      const chunk=await this.request('large.sceneRead',{...value,offset})
      this.#check(value,['owner','expectedRevision','key','offset','limit'])
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
