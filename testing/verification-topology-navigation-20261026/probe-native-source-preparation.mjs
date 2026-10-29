import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
import {writeFile} from 'node:fs/promises'
const root=process.cwd(),path='/tmp/topology-single-canvas-native-20261027-v1.json'
const preparation=new NativePreparation(root+'/design-studio/target/desktop-dev/design-prepare',root+'/frontend/design-client/public/fonts/NotoSansSC.ttf')
const descriptor={path,bytes:573894001,hash:'19a5d13571b1917c71f3ffa7cd4f2a42fc44b52af051c6a7b9614b1755639259',documentId:'test-document',pageId:'00000000-0000-4000-8000-000000000001',stageId:'68163f30-deed-5360-a00d-56a73a914521',nodes:124447}
const results=[]
try{
 let start=performance.now();const loaded=await preparation.loadSourceSnapshot(descriptor)
 results.push({stage:'native-stream-load',milliseconds:performance.now()-start,error:loaded.error??null,receipt:!!loaded.stateReceipt,settings:loaded.settings});console.log(results.at(-1))
 if(!loaded.error){start=performance.now();const compiled=await preparation.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify({pageId:descriptor.pageId,width:64,height:64,view:{x:-128,y:-128,zoom:1},rasterProfile:'figma',transparent:false,grid:false})]})
 results.push({stage:'native-first-tile-compile',milliseconds:performance.now()-start,error:compiled.error??null,bytes:compiled.value?.byteLength});console.log(results.at(-1))}
}catch(error){results.push({stage:'transport',error:String(error)});console.log(results.at(-1))}
finally{await preparation.close();await writeFile(process.argv[2],JSON.stringify({scope:'native stream admission and compiler only; not GPU pixels',results},null,2))}
