import {readFile} from 'node:fs/promises'
import {blank,node} from '../src/model'
import {initializePicking} from '../src/kernel/picking'
import {canvasDropFrame,createCanvasDropIndex} from '../src/canvas-drop'
await initializePicking({wasm:new Uint8Array(await readFile(new URL('../public/kernel/design_kernel_bg.wasm',import.meta.url))),font:new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url)))})
const doc=blank('Drop query benchmark'),moving=node('rectangle',10,10,20,20)
doc.nodes[moving.id]=moving;doc.pages[0].children.push(moving.id)
for(let i=0;i<100;i++){
 const frame=node('frame',(i%10)*300,Math.floor(i/10)*220,280,200);doc.nodes[frame.id]=frame;doc.pages[0].children.push(frame.id)
 for(let j=0;j<100;j++){const child=node('rectangle',(j%10)*20,Math.floor(j/10)*15,12,10);doc.nodes[child.id]=child;frame.children.push(child.id)}
}
const buildStart=performance.now(),index=createCanvasDropIndex(doc,doc.pages[0].id),indexBuildMs=performance.now()-buildStart
const samples:number[]=[]
for(let i=0;i<32;i++){
 const begin=performance.now();const result=canvasDropFrame(doc,doc.pages[0].id,[moving.id],{x:150,y:100},false,index);if(!result)throw Error('Missing frame')
 if(i>=2)samples.push(performance.now()-begin)
}
samples.sort((a,b)=>a-b)
console.log(JSON.stringify({nodes:Object.keys(doc.nodes).length,frames:100,indexBuildMs,samples:samples.length,medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*.95)],maxMs:samples.at(-1)}))
