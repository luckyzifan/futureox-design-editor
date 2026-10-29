import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import init,{import_sketch_json} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {importFig} from '../../frontend/design-client/src/import-fig'
const [figPath,sketchPath,output]=process.argv.slice(2)
if(!figPath||!sketchPath||!output)throw Error('FIG, Sketch and fresh output directory required')
await mkdir(output,{recursive:false})
await init({module_or_path:await readFile('frontend/design-client/public/kernel/design_kernel_bg.wasm')})
const records=[]
for(const [name,file] of [['fig',figPath],['117',sketchPath]]){
 const bytes=new Uint8Array(await readFile(file))
 const result=name==='fig'?importFig(bytes):JSON.parse(import_sketch_json(bytes))
 const doc=result.document,serialized=JSON.stringify(doc)
 await writeFile(path.join(output,name+'.json'),serialized)
 const roots=doc.pages.flatMap((p:any)=>p.children.map((id:string)=>({page:p.id,node:doc.nodes[id]}))).filter((x:any)=>x.node)
 records.push({name,sourceSha256:createHash('sha256').update(bytes).digest('hex'),documentSha256:createHash('sha256').update(serialized).digest('hex'),
  nodes:Object.keys(doc.nodes).length,roots:roots.slice(0,5).map((x:any)=>({page:x.page,id:x.node.id,name:x.node.name,kind:x.node.kind,width:x.node.width,height:x.node.height,transform:x.node.transform}))})
}
await writeFile(path.join(output,'manifest.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(records,null,2))
