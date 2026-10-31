// Electron 44 uses asynchronous ClipboardItem representations. MIME keys are
// authored here; renderer payloads cannot select file/OS clipboard formats.
const FORMA = 'web application/x-forma-nodes-v1'
const PNG = 'web application/x-forma-png-v1'
const fail = () => Object.assign(new Error('Clipboard content exceeds limit'), {code:'CLIPBOARD_TOO_LARGE'})
function pngBytes(value, nativeImage) {
  if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('Invalid clipboard PNG')
  const bytes=Buffer.from(value.slice('data:image/png;base64,'.length),'base64')
  if(bytes.length<33 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8)!==13 || bytes.subarray(12,16).toString('ascii')!=='IHDR')throw new Error('Invalid clipboard PNG header')
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20)
  if(!width||!height||width>16384||height>16384||width*height>64_000_000)throw new Error('Clipboard image dimensions exceed limit')
  if(bytes[24]!==8)throw new Error('Clipboard PNG must retain 8-bit SDR samples')
  const image=nativeImage.createFromBuffer(bytes)
  if(image.isEmpty()||image.getSize().width!==width||image.getSize().height!==height)throw new Error('Invalid clipboard PNG pixels')
  return bytes
}
export async function writeDesignClipboard(clipboard, ClipboardItem, nativeImage, value, maxBytes) {
  if(Object.values(value).some(v=>typeof v!=='string'))throw new Error('Invalid clipboard content')
  if(Object.values(value).reduce((n,v)=>n+Buffer.byteLength(v),0)>maxBytes)throw fail()
  const types={'text/plain':value.text||''}
  if(value.forma)types[FORMA]=value.forma
  else if(value.svg){types['image/svg+xml']=value.svg;types['text/html']=value.svg}
  if(value.image){
    const bytes=pngBytes(value.image,nativeImage)
    types[PNG]=new Blob([bytes],{type:'image/png'})
    types['image/png']=new Blob([bytes],{type:'image/png'})
  }
  await clipboard.write([new ClipboardItem(types)])
}
export async function readDesignClipboard(clipboard,maxBytes) {
  const items=await clipboard.read()
  if(!Array.isArray(items)||items.length>16)throw fail()
  for(const item of items) {
    let total=0
    const read=async(type)=>{
      const blob=await item.getType(type)
      if(!blob || !Number.isSafeInteger(blob.size) || blob.size<0 || blob.size>maxBytes || (total+=blob.size)>maxBytes)throw fail()
      return blob
    }
    const text=async(type)=>await(await read(type)).text()
    if(item.types.includes(FORMA)){
      const forma=await text(FORMA)
      return {forma,...(item.types.includes('text/plain')?{text:await text('text/plain')}:{})}
    }
    if(item.types.includes(PNG)){
      const bytes=Buffer.from(await(await read(PNG)).arrayBuffer())
      if(bytes.length>24*1024*1024)throw fail()
      return {image:'data:image/png;base64,'+bytes.toString('base64')}
    }
    if(item.types.includes('image/svg+xml'))return{svg:await text('image/svg+xml')}
    if(item.types.includes('image/png')){
      const bytes=Buffer.from(await(await read('image/png')).arrayBuffer())
      if(bytes.length>24*1024*1024)throw fail()
      return {image:'data:image/png;base64,'+bytes.toString('base64')}
    }
    // Legacy Forma HTML is a bounded data carrier, never rendered as HTML UI.
    if(item.types.includes('text/html')){
      const html=await text('text/html'),graph=/data-forma-nodes=["']([A-Za-z0-9+/=]+)["']/.exec(html)?.[1],png=/data-forma-png=["']([A-Za-z0-9+/=]+)["']/.exec(html)?.[1]
      if(graph)return{forma:Buffer.from(graph,'base64').toString('utf8')}
      if(png)return{image:'data:image/png;base64,'+png}
    }
    if(item.types.includes('text/plain'))return{text:await text('text/plain')}
  }
  return {}
}
