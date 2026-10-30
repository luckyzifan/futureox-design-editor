/** CPU/WASM compile profile; no GPU work or invented document pixels.
 * bun scripts/profile-tile-compile.ts /absolute/private/document.fd */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { initializeKernelModule } from '../src/kernel/module'
import { VectorEngine } from '../src/generated/design-kernel/design_kernel'
import type { DesignDocument } from '../src/model'

const path = process.argv[2]
if (!path) throw Error('Provide a private real document')
const source = await readFile(path,'utf8'), doc = JSON.parse(source) as DesignDocument
await initializeKernelModule(new Uint8Array(await readFile(new URL('../public/kernel/design_kernel_bg.wasm',import.meta.url))))
const kernel = new VectorEngine()
try {
  kernel.load_font(new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url))))
  kernel.load_document(source)
  const root=doc.nodes[doc.pages[0].children[1]||doc.pages[0].children[0]],zoom=1.2
  const x=Math.floor(root.transform[4]*zoom/512)*512-1,y=Math.floor(root.transform[5]*zoom/512)*512-1
  const base={pageId:doc.pages[0].id,width:514,height:514,view:{x:0,y:0,zoom},rasterProfile:'figmaSubpixel',
    prepareViewport:{x,y,w:1538,h:1538}}
  const rows=[]
  for(let pass=0;pass<2;pass++)for(let i=0;i<9;i++){
    const options=JSON.stringify({...base,gpuViewport:{x:x+(i%3)*512,y:y+Math.floor(i/3)*512,w:514,h:514}})
    const at=performance.now(),packet=kernel.compile_gpu_packet(options)
    rows.push({pass,tile:i,compileMs:performance.now()-at,bytes:packet.byteLength,sha256:createHash('sha256').update(packet).digest('hex')})
  }
  const id=root.id,moved={...root,transform:[...root.transform.slice(0,4),root.transform[4]+180,root.transform[5]]}
  const cache=JSON.parse(kernel.gpu_compile_cache_stats())
  const at=performance.now(),damage=JSON.parse(kernel.apply_document_patch_with_damage(JSON.stringify({nodes:{[id]:moved},fields:{}})))
  console.log(JSON.stringify({scope:'CPU WASM compilation and patch damage only',nodes:Object.keys(doc.nodes).length,rows,cache,patchMs:performance.now()-at,damage},null,2))
}finally{kernel.free()}
