import {createRequire,stripTypeScriptTypes} from 'node:module'
// Node 24 provides transform mode. Node 26 removes it; use the project's
// already pinned Vite transformer on that runtime, with no source rewrites.
let transform
try{
  stripTypeScriptTypes('class Probe {constructor(private x:number){}}',{mode:'transform'})
  transform=source=>stripTypeScriptTypes(source,{mode:'transform'})
}catch(error){
  if(error.code!=='ERR_INVALID_ARG_VALUE'||!String(error.message).includes('options.mode'))throw error
  const {transformSync}=createRequire(import.meta.url)('rolldown/utils')
  transform=(source,filename)=>{
    const result=transformSync(filename||'renderer-test.ts',source,{target:'esnext'})
    if(result.errors.length)throw Error(result.errors.map(error=>error.message).join('\n'))
    return result.code
  }
}
export const rendererTestTypes=(source,filename)=>transform(source,filename)
