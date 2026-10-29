import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {importFig} from '../../frontend/design-client/src/import-fig'
import {Editor} from '../../frontend/design-client/src/engine'
import {validateDocument} from '../../frontend/design-client/src/model'
import {import_sketch_json,export_sketch_json} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
await initializePicking({wasm:new Uint8Array(readFileSync('frontend/design-client/public/kernel/design_kernel_bg.wasm')),font:new Uint8Array(readFileSync('frontend/design-client/public/fonts/NotoSansSC.ttf'))})
const report=[]
for(const path of ['/Users/Apple/Downloads/117.sketch','/Users/Apple/Downloads/01有料素材 (Copy).fig']){
 const bytes=new Uint8Array(readFileSync(path)),hash=createHash('sha256').update(bytes).digest('hex'),row:any={file:path.split('/').at(-1),hash}
 try{
  const result=path.endsWith('.fig')?importFig(bytes):JSON.parse(import_sketch_json(bytes))
  const doc=result.document;validateDocument(doc);row.backend=result.backend||'wasm-sketch';row.warnings=result.warnings;row.nodes=Object.keys(doc.nodes).length;row.pages=doc.pages.length
  const editor=new Editor(doc)
  try{
   const target=Object.values(editor.state.doc.nodes).find((n:any)=>n.kind==='rectangle'&&!n.locked&&!n.instanceOrigin) as any
   if(!target)throw Error('No editable rectangle in real fixture')
   const before=target.name,after=before+' verification'
   editor.change('Real import rename',d=>{d.nodes[target.id].name=after})
   if(editor.state.doc.nodes[target.id].name!==after)throw Error('Rename failed')
   editor.undo();if(editor.state.doc.nodes[target.id].name!==before)throw Error('Undo failed')
   editor.redo();if(editor.state.doc.nodes[target.id].name!==after)throw Error('Redo failed')
   const reopened=new Editor(JSON.parse(JSON.stringify(editor.state.doc)))
   try{if(reopened.state.doc.nodes[target.id].name!==after)throw Error('Shared model reopen failed')}finally{reopened.dispose()}
   if(path.endsWith('.sketch')){
    const output=export_sketch_json(JSON.stringify(editor.state.doc)),back=JSON.parse(import_sketch_json(output));validateDocument(back.document)
    if(back.document.nodes[target.id].name!==after)throw Error('Sketch save/reopen lost edit')
    row.sketchExportBytes=output.byteLength;row.sketchReopenNodes=Object.keys(back.document.nodes).length
   }
   row.editUndoRedoReopen=true
  }finally{editor.dispose()}
  row.status='PASS'
 }catch(e){row.status='FAIL';row.error=String(e)}
 row.sourceUnchanged=hash===createHash('sha256').update(readFileSync(path)).digest('hex');report.push(row)
}
writeFileSync('testing/verification-fig-sketch-interop-20261029/real-import-report.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report.map(({warnings,...row})=>({...row,warningCount:warnings?.length})),null,2))
if(report.some(row=>row.status!=='PASS'))process.exitCode=1
