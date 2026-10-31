/** Detached rendering data only: no native JSON, file handle, path or edit API. */
export function admitSketchDisplay(value, expectedOwner, revision=0) {
  const require=(ok)=>{if(!ok)throw Error('Unsupported or malformed Sketch display snapshot')}
  const record=v=>v&&typeof v==='object'&&!Array.isArray(v)
  const name=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f]/.test(v)&&!['__proto__','prototype','constructor'].includes(v)
  require(record(value)&&Object.keys(value).every(k=>['owner','revision','pageId','document','assets','warnings','sourceFonts','artboards'].includes(k)))
  require(record(value.owner)&&Object.keys(value.owner).length===4&&value.owner.kernel_id==='sketch'&&value.owner.document_schema==='sketch-native-v1'&&name(value.owner.document_id))
  require(['kernel_id','document_schema','document_id','session_epoch'].every(k=>value.owner[k]===expectedOwner[k]))
  require(Number.isSafeInteger(value.owner.session_epoch)&&value.owner.session_epoch>0&&Number.isSafeInteger(revision)&&revision>=0&&value.revision===revision&&name(value.pageId))
  const d=value.document
  require(record(d)&&d.id===value.owner.document_id&&d.schemaVersion===11&&Array.isArray(d.pages)&&d.pages.length===1&&d.pages[0].id===value.pageId&&record(d.nodes))
  require(record(value.assets)&&Object.keys(value.assets).length<=256)
  let bytes=0
  for(const [key,data] of Object.entries(value.assets)){
    require(key.startsWith('sketch-asset:images/')&&key.length<=512&&typeof data==='string'&&data.length<=12*1024*1024&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data))
    bytes+=data.length;require(bytes<=48*1024*1024)
  }
  const ids=Object.keys(d.nodes);require(ids.length<=20000)
  for(const id of ids){
    const n=d.nodes[id];require(name(id)&&record(n)&&n.id===id&&Array.isArray(n.children)&&n.children.every(k=>name(k)&&Object.hasOwn(d.nodes,k)))
    require(Array.isArray(n.fills)&&n.fills.length<=16&&Array.isArray(n.strokes)&&n.strokes.length<=16)
    for(const paint of [...n.fills,...n.strokes.map(s=>s.paint)]){require(record(paint));if(paint.image!=null)require(typeof paint.image==='string'&&Object.hasOwn(value.assets,paint.image))}
  }
  const roots=d.pages[0].children;require(Array.isArray(roots)&&roots.every(id=>Object.hasOwn(d.nodes,id)))
  const seen=new Set();const visit=(id,depth)=>{require(depth<=128&&!seen.has(id));seen.add(id);for(const child of d.nodes[id].children)visit(child,depth+1)}
  for(const id of roots)visit(id,0);require(seen.size===ids.length)
  require(Array.isArray(value.artboards)&&value.artboards.length<=2000&&value.artboards.every(id=>roots.includes(id)))
  for(const key of ['warnings','sourceFonts'])require(Array.isArray(value[key])&&value[key].length<=2000&&value[key].every(v=>typeof v==='string'&&v.length<=1000))
  return {owner:{...value.owner},revision,pageId:value.pageId,document:d,assets:value.assets,warnings:[...value.warnings],sourceFonts:[...value.sourceFonts],artboards:[...value.artboards]}
}
