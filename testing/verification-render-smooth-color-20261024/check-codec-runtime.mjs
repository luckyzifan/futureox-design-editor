import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
import {writeFile} from 'node:fs/promises'
const codec=new NativePreparation(undefined,undefined,true),base={id:'d',fonts:{font:{data:'x'.repeat(1000000)}},nodes:{n:{id:'n',width:20}},name:'resident'}
const install={owner:'runtime-check',base:0,sequence:1,install:true,fieldOrder:Object.keys(base),nodeOrder:['n'],fields:Object.entries(base).filter(([key])=>key!=='nodes'),nodes:Object.entries(base.nodes)}
try{
 const first=await codec.request({lane:'canvas',method:'serialize_delta',args:[install]});if(first.error||first.value.json!==JSON.stringify(base))throw Error(JSON.stringify(first))
 const updated={...base,nodes:{n:{id:'n',width:21}}},delta={owner:'runtime-check',base:1,sequence:2,install:false,fieldOrder:Object.keys(updated),nodeOrder:['n'],fields:[],nodes:Object.entries(updated.nodes)}
 const second=await codec.request({lane:'canvas',method:'serialize_delta',args:[delta]});if(second.error||second.value.json!==JSON.stringify(updated))throw Error(JSON.stringify(second))
 const stale=await codec.request({lane:'canvas',method:'serialize_delta',args:[delta]});if(!stale.error?.includes('CODEC_BASE_MISSING'))throw Error('Stale base accepted')
 const result={status:'passed',runtime:'actual Node codec worker and host admission',installBytes:Buffer.byteLength(JSON.stringify(install)),deltaBytes:Buffer.byteLength(JSON.stringify(delta)),outputBytes:Buffer.byteLength(second.value.json),byteEqual:true,staleRejected:true}
 await writeFile(new URL('./codec-runtime.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await codec.close()}
