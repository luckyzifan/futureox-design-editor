// Local document transport codec. The protocol exposes no filesystem or network operations.
import { parentPort } from 'node:worker_threads'
import { deflateSync } from 'node:zlib'
import { DOCUMENT_BYTE_LIMIT as LIMIT, assertDocumentSerialization } from './document-capacity.mjs'
import { ResidentDocumentCodec } from './resident-document-codec.mjs'
const resident = new ResidentDocumentCodec()
const COMPRESS_REPLY_CHARS = 1024 * 1024
parentPort.on('message',message=>{
 if(message.stop){parentPort.close();return}
 try{
  if(message.args.length!==1)throw Error('Invalid document codec request')
  let value
  if(message.method==='serialize'){
   assertDocumentSerialization(message.args[0])
   value=JSON.stringify(message.args[0])
   if(typeof value!=='string'||Buffer.byteLength(value)>LIMIT)throw Error('Document exceeds the available working-memory allowance')
  }else if(message.method==='serialize_delta'){
   const {owner,sequence,json}=resident.encode(message.args[0])
   if(json.length>=COMPRESS_REPLY_CHARS){
    // Keep large round trips compact. The renderer can pass these exact bytes
    // back for persistence, and only the codec workers inflate/parse the write.
    const compressed=deflateSync(json,{level:1})
    if(compressed.byteLength<=json.length/2){
     const documentDeflate=Uint8Array.from(compressed)
     parentPort.postMessage({id:message.id,reply:{id:message.id,value:{owner,sequence,documentDeflate}}},[documentDeflate.buffer])
     return
    }
   }
   value={owner,sequence,json}
  }else if(message.method==='parse'){
   const text=message.args[0]
   if(typeof text!=='string'||Buffer.byteLength(text)>LIMIT)throw Error('Invalid document JSON size')
   value=JSON.parse(text)
  }else throw Error('Unsupported document codec method')
  parentPort.postMessage({id:message.id,reply:{id:message.id,value}})
 }catch(error){parentPort.postMessage({id:message.id,reply:{id:message.id,error:String(error.message).slice(0,4096)}})}
})
