import {createRequire,stripTypeScriptTypes} from 'node:module'
import {readFileSync} from 'node:fs'
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
export function loadRendererTestModule(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const file = new URL(url)
    if (file.search === '?raw') return {format: 'module', shortCircuit: true,
      source: 'export default ' + JSON.stringify(readFileSync(file, 'utf8'))}
    if (url.endsWith('.ts')) return {format: 'module', shortCircuit: true,
      source: transform(readFileSync(file, 'utf8'), file.pathname).replaceAll('import.meta.env', '({ DEV: false })')}
  }
  return nextLoad(url, context)
}
