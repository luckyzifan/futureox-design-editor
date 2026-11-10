import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { assertIndependentExport } from './independent-export.mjs'
import { DOCUMENT_BYTE_LIMIT } from './document-capacity.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const bitmapScope = value => typeof value==='string' && /^[a-zA-Z0-9-]{1,160}$/.test(value)
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
      value.bitmapScope!==undefined&&!bitmapScope(value.bitmapScope) ||
      expected && (value.owner.documentId !== expected.documentId || value.owner.sessionEpoch !== expected.sessionEpoch)) throw Error('Invalid large document response')
  return value
}

/** Native dialogs grant paths. Renderer content receives only a session owner
 * and bounded JSON fragments; no arbitrary path or RPC method is forwarded. */
export class LargeDocumentHost {
  #active; #epoch = 0; #busy = false
  // Same-revision material scenes are immutable. Remember a few so a direction
  // reversal restores the previous token instead of building and publishing
  // another scene. A new revision or document drops the map. Only the active
  // snapshot remains resolvable; remembered entries are not extra capabilities.
  #rememberedScenes = new Map()
  constructor(request, dialog, window, cancel) { this.request = request; this.dialog = dialog; this.window = window; this.cancelWork=cancel }
  #rememberScene(snapshot) {
    if(!snapshot || snapshot.openingMaterial!==undefined)return
    const key=`${snapshot.revision}\n${snapshot.scope??''}`
    this.#rememberedScenes.delete(key)
    this.#rememberedScenes.set(key,snapshot)
    while(this.#rememberedScenes.size>4)this.#rememberedScenes.delete(this.#rememberedScenes.keys().next().value)
  }
  #recallScene(revision,scope) {
    const snapshot=this.#rememberedScenes.get(`${revision}\n${scope??''}`)
    return snapshot && snapshot.revision===revision && snapshot.scope===scope ? snapshot : undefined
  }
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
  bitmapGrant(senderId,recoveryDir) {
    const active=this.#active, owner=active?.status.owner
    if(!owner || active.window!==this.window() || active.window.isDestroyed() ||
       active.window.webContents.id!==senderId || active.status.format!=='sketch')return
    const name=active.status.bitmapScope??owner.documentId+'-'+owner.sessionEpoch
    return {owner:name,directory:path.join(recoveryDir,'large-documents',name,'bitmaps')}
  }
  bitmapOwner(name) {
    const active=this.#active, owner=active?.status?.owner
    return !!owner && active.window===this.window() && !active.window.isDestroyed() && active.status.format==='sketch' &&
      name===(active.status.bitmapScope??owner.documentId+'-'+owner.sessionEpoch)
  }
  async status(value) {
    if (value !== undefined) throw Error('Unexpected large document status arguments')
    const active = this.#active
    if (!active || active.window !== this.window() || active.window.isDestroyed()) return { status: 'cancelled' }
    active.status = admitLargeStatus(await this.request('large.status', { owner: active.status.owner, expectedRevision: active.status.revision }), active.status.owner)
    return { status: 'ok', ...active.status }
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
    this.#rememberedScenes.clear()
    this.#active={window,sourcePath:selected.filePaths[0],opening:true,status:{owner,revision:0,name:path.basename(selected.filePaths[0]),format,expandedBytes:0,maxExpandedBytes:0,indexedObjects:0,dirty:false,undoCount:0,redoCount:0}}
    let result
    try{result=admitLargeStatus(await this.request('large.open', {path:selected.filePaths[0],...owner,...(format==='sketch'?{openingPreview:true}:{})}), owner)}
    catch(error){
      if(this.#active){this.#active.opening=false;if(this.#active.snapshot?.openingMaterial!==undefined)this.#active.snapshot=undefined}
      if(error?.outcomeUnknown!==true){this.#rememberedScenes.clear();this.#active=undefined}
      throw error
    }
    if (window !== this.window() || window.isDestroyed()) {
      await this.request('large.close',{owner,expectedRevision:result.revision}); this.#rememberedScenes.clear(); this.#active=undefined;return {status:'cancelled'}
    }
    this.#active.opening=false; this.#active.status=result; return {status:'ok',...result}
  }) }
  async openingView(value) {
    fields(value,['owner','offset','cursor','detailCursor','pageId','material','viewport','viewportDensity','viewportAnchor'])
    const active=this.#active
    if (!active || active.window!==this.window() || active.window.isDestroyed()) return {status:'cancelled'}
    if (active.status.format!=='sketch' || active.status.revision!==0) return {status:'ok',phase:'unavailable'}
    const owner=active.status.owner
    if (value.owner!==undefined && (value.owner?.documentId!==owner.documentId || value.owner?.sessionEpoch!==owner.sessionEpoch)) return {status:'cancelled'}
    if (![value.offset,value.cursor].every(integer) || value.detailCursor!==undefined&&!integer(value.detailCursor) || value.material!==undefined&&!integer(value.material) ||
        value.pageId!==undefined&&(typeof value.pageId!=='string'||value.pageId.length>128)) throw Error('Invalid opening view request')
    if(value.viewportAnchor!==undefined&&(!value.viewport||!Array.isArray(value.viewportAnchor)||value.viewportAnchor.length!==2||
      !value.viewportAnchor.every(Number.isFinite)))throw Error('Invalid material viewport anchor')
    if(value.viewportDensity!==undefined&&(!value.viewport||!Number.isFinite(value.viewportDensity)||value.viewportDensity<=0||value.viewportDensity>65536))throw Error('Invalid material viewport density')
    if(value.viewport!==undefined){
      const b=fields(value.viewport,['x','y','width','height'])
      if(![b.x,b.y,b.width,b.height,b.x+b.width,b.y+b.height].every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('Invalid opening viewport')
    }
    const material=value.material
    if(active.opening && active.openingSelection!==material) {
      active.openingSelection=material
      if(active.snapshot?.openingMaterial!==undefined)active.snapshot=undefined
    }
    const result=await this.request('large.openingView',{...value,owner,expectedRevision:0})
    if (this.#active!==active || active.status.revision!==0 || active.window!==this.window() || active.window.isDestroyed()) return {status:'cancelled'}
    if (result?.phase==='absent') return {status:'ok',phase:active.status.maxExpandedBytes?'unavailable':'pending'}
    if (result?.phase==='pending'||result?.phase==='unavailable') return {status:'ok',phase:result.phase}
    const box=b=>object(b)&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>=0&&b.height>=0
    if (result?.phase!=='available'||result.owner?.documentId!==owner.documentId||result.owner?.sessionEpoch!==owner.sessionEpoch||result.revision!==0||
        !box(result.bounds)||!integer(result.total)||result.offset!==value.offset||!Array.isArray(result.items)||result.items.length>128||
        result.nextOffset!==value.offset+result.items.length||result.nextOffset>result.total||
        !Array.isArray(result.images)||result.images.length>32||result.cursor!==value.cursor+result.images.length||
        typeof result.moreImages!=='boolean'||typeof result.finished!=='boolean'||result.items.some(row=>!box(row.placed)||!box(row.source)||['id','name','kind','pageId','pageName','key'].some(k=>typeof row[k]!=='string'))||
        (value.offset===0 && (!Array.isArray(result.pages)||result.pages.some(p=>!Array.isArray(p)||typeof p[0]!=='string'||typeof p[1]!=='string'||!integer(p[2]))))) throw Error('Invalid opening view response')
    const checkImage=(image,side,limit)=>{
      if (!image||!integer(image.index)||image.index>=result.total||typeof image.png!=='string'||image.png.length>limit) throw Error('Invalid material thumbnail')
      const b=Buffer.from(image.png,'base64')
      if (b.length<24||b.readUInt32BE(0)!==0x89504e47||b.readUInt32BE(4)!==0x0d0a1a0a||
          b.toString('ascii',12,16)!=='IHDR'||![b.readUInt32BE(16),b.readUInt32BE(20)].every(n=>n>=1&&n<=side)||b.readUInt32BE(16)*b.readUInt32BE(20)>384*384) throw Error('Invalid material PNG')
    }
    for (const image of result.images)checkImage(image,176,192*1024)
    if(result.nextDetailCursor!==undefined){
      const base=result.detailBase,next=result.nextDetailCursor,prior=value.detailCursor??0
      if(!integer(base)||!integer(next)||next!==Math.max(base,prior)+Number(!!result.detail)||
         next-base>16||typeof result.detailPending!=='boolean')throw Error('Invalid detail preview cursor')
    }
    if(result.detail){
      if(result.images.length||result.items.length)throw Error('Invalid detail preview batch')
      checkImage(result.detail,768,360000)
    }
    // The backing path and store descriptor stay in the host. Only mint a
    // display token for this window's still-opening, immutable revision zero.
    const {materialSnapshot,materialDisplay:untrustedDisplay,...view}=result
    if(materialSnapshot && active.opening && this.#active===active && material!==undefined && active.openingSelection===material && active.status.revision===0){
      const keys=['preview-'+value.material], scope=createHash('sha256').update(keys[0]).digest('hex')
      const source=active.snapshot?.scope===scope ? active.snapshot.public :
        this.#publishSnapshot(active,{owner,expectedRevision:0},materialSnapshot,keys,scope)
      active.snapshot.openingMaterial=material
      view.materialDisplay={...source,openingMaterial:material}
    }
    return {status:'ok',...view}
  }
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
    const fields=['owner','expectedRevision','navigationPreview','materialKeys','navigationWindow']
    const active=this.#check(value,fields)
    if (value.navigationPreview !== undefined && typeof value.navigationPreview !== 'boolean') throw Error('Invalid source preview option')
    let keys,scope
    if(value.materialKeys!==undefined){
      if(!Array.isArray(value.materialKeys)||!value.materialKeys.length||value.materialKeys.length>32)throw Error('Invalid detail scope')
      keys=[...value.materialKeys].sort();for(const key of keys)this.#key(key)
      if(new Set(keys).size!==keys.length)throw Error('Duplicate detail root')
      scope=createHash('sha256').update(keys.join(',')).digest('hex')
    }
    if(value.navigationWindow!==undefined){
      const b=value.navigationWindow
      if(!keys||!object(b)||!['x','y','width','height'].every(k=>Number.isFinite(b[k]))||
         Object.keys(b).length!==4||!(b.width>0&&b.height>0)||![b.x+b.width,b.y+b.height].every(Number.isFinite))
        throw Error('Invalid material navigation window')
    }
    if(active.snapshot?.revision===active.status.revision && active.snapshot.scope===scope)return {status:'ok',...active.snapshot.public}
    const remembered=this.#recallScene(active.status.revision,scope)
    if(remembered){active.snapshot=remembered;return {status:'ok',...remembered.public}}
    const result=await this.request('large.canvasSnapshot',value)
    this.#check(value,fields)
    return {status:'ok',...this.#publishSnapshot(active,value,result,keys,scope)}
  }) }
  #publishSnapshot(active,value,result,keys,scope) {
    const suffix=scope?'-'+scope:''
    const box=result?.bounds
    if(!object(result)||result.owner?.documentId!==value.owner.documentId||result.owner?.sessionEpoch!==value.owner.sessionEpoch||result.revision!==value.expectedRevision||
      typeof result.path!=='string'||!path.isAbsolute(result.path)||path.normalize(result.path)!==result.path||path.basename(result.path)!==`canvas-native-${result.revision}${suffix}.scene`||
      (result.scope??undefined)!==scope || keys&&result.roots!==keys.length||
      !integer(result.bytes)||result.bytes===0||!integer(result.nodes)||!result.nodes||!integer(result.roots)||!result.roots||
      !object(result.store)||Object.keys(result.store).sort().join(',')!=='bytes,documentId,footerHash,generation,nodes'||
      result.store.generation!==`${value.owner.documentId}:${value.owner.sessionEpoch}:${result.revision}${suffix}`||result.store.documentId!==value.owner.documentId||
      result.store.bytes!==result.bytes||result.store.nodes!==result.nodes||!Array.isArray(result.store.footerHash)||result.store.footerHash.length!==32||result.store.footerHash.some(n=>!integer(n)||n>255)||
      ['pageId','stageId'].some(key=>typeof result[key]!=='string'||!/^[a-z0-9-]{1,128}$/i.test(result[key]))||
      !object(box)||!['x','y','width','height'].every(key=>typeof box[key]==='number'&&Number.isFinite(box[key]))||box.width<=0||box.height<=0||
      !['analytic','figma','figmaSubpixel','figmaSoftware'].includes(result.rasterProfile)||typeof result.colorManaged!=='boolean'||
      !Array.isArray(result.warnings)||result.warnings.some(value=>typeof value!=='string'))throw Error('Invalid native canvas snapshot')
    const token=randomUUID(),revision=result.revision
    const descriptor=Object.freeze({path:result.path,store:Object.freeze({...result.store,footerHash:Object.freeze([...result.store.footerHash])}),documentId:value.owner.documentId,pageId:result.pageId,stageId:result.stageId,nodes:result.nodes})
    const snapshot={token,revision,scope,descriptor,public:{...(keys?{materialKeys:keys}:{}),owner:{...value.owner},revision,token,bytes:result.bytes,nodes:result.nodes,roots:result.roots,
      pageId:result.pageId,stageId:result.stageId,bounds:{...box},warnings:[...result.warnings],rasterProfile:result.rasterProfile,colorManaged:result.colorManaged}}
    active.snapshot=snapshot
    this.#rememberScene(snapshot)
    return snapshot.public
  }
  async canvasPreview(value) {
    const active = this.#check(value,['owner','expectedRevision','token'])
    const snapshot = active.snapshot
    if (!snapshot || value.token !== snapshot.token || snapshot.revision !== value.expectedRevision) throw Error('Stale source preview')
    const result = await this.request('large.canvasPreview',{owner:value.owner,expectedRevision:value.expectedRevision})
    this.#check(value,['owner','expectedRevision','token'])
    if (active.snapshot !== snapshot) throw Error('Stale source preview')
    if (result?.phase === 'pending' || result?.phase === 'unavailable') return {status:'ok',phase:result.phase}
    const image = result?.image, full=snapshot.public.bounds, scoped=!!snapshot.public.materialKeys
    const bounds=scoped?image?.bounds:full,side=scoped?1024:256
    if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0||
       bounds.x<full.x||bounds.y<full.y||bounds.x+bounds.width>full.x+full.width+1e-7||bounds.y+bounds.height>full.y+full.height+1e-7)throw Error('Invalid source preview bounds')
    if (result?.phase !== 'ready' || !image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        image.width < 1 || image.height < 1 || image.width > side || image.height > side || scoped && image.width*image.height>262144 ||
        !Number.isFinite(image.scale) || image.scale <= 0 || image.scale > 1 ||
        image.width !== Math.min(side,Math.ceil(bounds.width*image.scale)) ||
        image.height !== Math.min(side,Math.ceil(bounds.height*image.scale)) ||
        typeof image.png !== 'string' || image.png.length > 360000) throw Error('Invalid source preview')
    const bytes = Buffer.from(image.png,'base64')
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a ||
        bytes.toString('ascii',12,16) !== 'IHDR' || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw Error('Invalid source preview PNG')
    return {status:'ok',phase:'ready',...(scoped?{bounds}:{}),width:image.width,height:image.height,scale:image.scale,png:image.png}
  }
  /** Host-only capability resolution. A renderer token never supplies a path. */
  resolveCanvasSnapshot(token,senderId) {
    const active=this.#active,snapshot=active?.snapshot
    const current=()=>{
      if(!snapshot||typeof token!=='string'||snapshot.token!==token||this.#active!==active||active.snapshot!==snapshot||active.window!==this.window()||
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
    const fieldsAllowed=['owner','expectedRevision','selection','selectionName']
    const active=this.#check(value,fieldsAllowed),window=this.window(),target=value.selection
    let defaultPath=active.status.name.replace(/\.(json|sketch)$/i,`-edited.${active.status.format}`)
    if(target!==undefined){
      fields(target,['pageId','nodeIds'])
      const validId=id=>typeof id==='string' && id.length>0 && id.length<=128
      if(active.status.format!=='sketch'||!validId(target.pageId)||!Array.isArray(target.nodeIds)||!target.nodeIds.length||
         target.nodeIds.length>1000||!target.nodeIds.every(validId)||new Set(target.nodeIds).size!==target.nodeIds.length)throw Error('Invalid Sketch selection')
      if(typeof value.selectionName!=='string')throw Error('Missing selection name')
      const name=value.selectionName.replace(/[\x00-\x1f\/\\:*?"<>|]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,120)
      defaultPath=(name||'Selection')+'.sketch'
    }
    const selected=await this.dialog.showSaveDialog(window,{title:target?'导出选区为 Sketch':'导出完整文件',defaultPath,filters:[{name:active.status.format,extensions:[active.status.format]}]})
    if(selected.canceled||!selected.filePath||window!==this.window()||window.isDestroyed())return {status:'cancelled'}
    this.#check(value,fieldsAllowed)
    await assertIndependentExport(selected.filePath,active.sourcePath)
    const result=await this.request('large.export',{owner:value.owner,expectedRevision:value.expectedRevision,...(target?{selection:target}:{}),path:selected.filePath,requestId:randomUUID()})
    if(result.exported!==true)throw Error('Large document export was not confirmed')
    active.status=admitLargeStatus(result.document,active.status.owner)
    return {status:'ok',...active.status,exported:true,displayName:path.basename(selected.filePath),...(result.warning?{saveWarning:result.warning}:{})}
  }) }
  async close(value) { return this.#exclusive(async()=>{
    const active=this.#check(value,['owner','expectedRevision'])
    await this.request('large.close',value);this.#rememberedScenes.clear();this.#active=undefined;return {status:'ok'}
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
