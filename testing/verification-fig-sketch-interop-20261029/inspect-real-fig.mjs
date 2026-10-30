import {createRequire} from 'node:module'
import {readFileSync,writeFileSync} from 'node:fs'
const require=createRequire(new URL('../../frontend/design-client/package.json',import.meta.url))
const {unzipSync,inflateSync}=require('fflate'),{compileSchema,decodeBinarySchema}=require('kiwi-schema'),{decompress}=require('fzstd')
const file=readFileSync('/Users/Apple/Downloads/01有料素材 (Copy).fig'),canvas=unzipSync(file)['canvas.fig'],view=new DataView(canvas.buffer,canvas.byteOffset,canvas.byteLength)
let offset=12;const parts=[]
while(offset<canvas.length){const len=view.getUint32(offset,true);parts.push(canvas.slice(offset+4,offset+4+len));offset+=4+len}
const unpack=b=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true)===0xfd2fb528?decompress(b):inflateSync(b)
const schema=compileSchema(decodeBinarySchema(unpack(parts[0]))),data=schema.decodeMessage(unpack(parts[1]))
const masks=data.nodeChanges.filter(n=>n.mask).map(n=>({guid:n.guid,type:n.type,maskType:n.maskType,opacity:n.opacity,blendMode:n.blendMode,fills:n.fillPaints?.map(p=>({type:p.type,visible:p.visible,opacity:p.opacity,alpha:p.color?.a})),strokes:n.strokePaints?.length,effects:n.effects?.map(e=>e.type)}))
writeFileSync(new URL('real-fig-mask-summary.json',import.meta.url),JSON.stringify(masks,null,2)+'\n');console.log(JSON.stringify(masks))
