// Local document transport codec. The protocol exposes no filesystem or network operations.
import { parentPort } from 'node:worker_threads'
const LIMIT=32*1024*1024
parentPort.on('message',message=>{
 if(message.stop){parentPort.close();return}
 try{
  if(message.args.length!==1)throw Error('Invalid document codec request')
  let value
  if(message.method==='serialize'){
   value=JSON.stringify(message.args[0])
   if(typeof value!=='string'||Buffer.byteLength(value)>LIMIT)throw Error('Document exceeds 32 MiB')
  }else if(message.method==='parse'){
   const text=message.args[0]
   if(typeof text!=='string'||Buffer.byteLength(text)>LIMIT)throw Error('Invalid document JSON size')
   value=JSON.parse(text)
  }else throw Error('Unsupported document codec method')
  parentPort.postMessage({id:message.id,reply:{id:message.id,value}})
 }catch(error){parentPort.postMessage({id:message.id,reply:{id:message.id,error:String(error.message).slice(0,4096)}})}
})
