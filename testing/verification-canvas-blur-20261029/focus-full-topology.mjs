import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const base='/tmp/futureox-topology-blur-full-20261029',out=process.argv[2]
if(!out||!path.isAbsolute(out))throw Error('Fresh output required');await fs.mkdir(out)
const manifest=JSON.parse(await fs.readFile(path.join(base,'manifest.json'),'utf8')),snapshot=JSON.parse(await fs.readFile(path.join(base,'snapshot.json'),'utf8'))
const cases=JSON.parse(await fs.readFile('testing/verification-canvas-blur-20261029/topology-run-edges/report.json','utf8')).cases
const prep=new NativePreparation(path.resolve('design-studio/target/desktop-dev/design-prepare'),path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'))
const packets=manifest.packets;manifest.packets=[];manifest.status='running'
try{
 const start=performance.now(),loaded=await prep.loadSourceSnapshot(snapshot);if(loaded.error)throw Error(loaded.error)
 manifest.stages.push({stage:'focus-source-load',ms:performance.now()-start})
 for(let i=0;i<packets.length;i++){
  const old=packets[i],options={...old.options},paired=cases.find(c=>c.name===(i===0?'background':i===2?'modern-gaussian':''))
  if(i===1){const hint=JSON.parse(await fs.readFile('testing/verification-canvas-blur-20261029/composition-camera.json','utf8'))
   const {source,placed}=old.root,z=4,cx=hint.target.point[0]+placed.x-source.x,cy=hint.target.point[1]+placed.y-source.y
   options.view={x:options.width/2-cx*z,y:options.height/2-cy*z,zoom:z}
  }
  if(paired){const view=paired.options.view,{source,placed}=old.root,z=view.zoom;
   const cx=(paired.options.width/2-view.x)/z+placed.x-source.x,cy=(paired.options.height/2-view.y)/z+placed.y-source.y
   options.view={x:options.width/2-cx*z,y:options.height/2-cy*z,zoom:z}
  }
  const at=performance.now(),result=await prep.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(options)]})
  if(result.error||!result.value?.byteLength)throw Error(result.error||'Missing packet')
  const file=`packet-${i}.fgsc`;await fs.writeFile(path.join(out,file),result.value)
  manifest.packets.push({...old,file,options,bytes:result.value.byteLength,hash:createHash('sha256').update(result.value).digest('hex'),compileMs:performance.now()-at})
 }
 manifest.status='passed'
}catch(error){manifest.status='failed';manifest.error=String(error);process.exitCode=1}
finally{await prep.close();await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({status:manifest.status,packets:manifest.packets.map(p=>({name:p.root.name,bytes:p.bytes,compileMs:p.compileMs})),error:manifest.error}))}
