// Instrument the isolated native host only. Snapshot bytes stay in the private
// run directory so exact packet/device experiments can use the same source.
import {copyFileSync,constants,existsSync,writeFileSync,appendFileSync} from 'node:fs'
import path from 'node:path'
export function observeDenseSource(NativePreparation,out,expectedScope){
  const load=NativePreparation.prototype.loadSourceSnapshot
  NativePreparation.prototype.loadSourceSnapshot=function(descriptor){
    if(path.basename(descriptor.path).endsWith(expectedScope+'.scene')&&!existsSync(path.join(out,'store.json'))){
      const local=path.join(out,'dense.scene')
      copyFileSync(descriptor.path,local,constants.COPYFILE_FICLONE)
      writeFileSync(path.join(out,'store.json'),JSON.stringify({...descriptor,path:local}))
    }
    return load.call(this,descriptor)
  }
  const request=NativePreparation.prototype.request
  NativePreparation.prototype.request=function(payload){
    if(payload.method==='compile_gpu_packet'&&existsSync(path.join(out,'store.json'))){
      const o=JSON.parse(payload.args[0])
      if(o.view?.zoom>.19&&o.view.zoom<.20)appendFileSync(path.join(out,'tile-options.ndjson'),JSON.stringify(o)+'\n')
    }
    return request.call(this,payload)
  }
}
