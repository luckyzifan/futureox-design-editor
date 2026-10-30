import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResidentDocumentCodec } from './resident-document-codec.mjs'
const request = (document, sequence=1, base=0, previous) => ({owner:'test-owner',base,sequence,install:base===0,
 fieldOrder:Object.keys(document).filter(key=>document[key]!==undefined),nodeOrder:Object.keys(document.nodes),
 fields:Object.entries(document).filter(([key,value])=>key!=='nodes'&&value!==undefined&&(!previous||previous[key]!==value)),
 nodes:Object.entries(document.nodes).filter(([key,value])=>!previous||previous.nodes[key]!==value)})
test('resident fragments preserve exact JSON bytes, order, optional values and node deletion',()=>{
 const codec=new ResidentDocumentCodec(200000)
 const a={schemaVersion:16,name:'中文\n"',fonts:[{data:'x'.repeat(100000)}],nodes:{'10':{id:'10',width:-0},'2':{id:'2'},z:{id:'z',value:null,optional:undefined}},extra:null}
 assert.equal(codec.encode(request(a)).json,JSON.stringify(a))
 const b={name:'changed',schemaVersion:16,nodes:{z:a.nodes.z,'10':{id:'10',width:12}},fonts:a.fonts}
 const delta=request(b,2,1,a)
 assert.equal(JSON.stringify(delta).includes('x'.repeat(100)),false)
 assert.equal(codec.encode(delta).json,JSON.stringify(b))
 assert.equal(codec.encode(request(a,3,2,b)).json,JSON.stringify(a))
})
test('stale owners, invalid/budget failures are atomic and explicit reinstalls recover',()=>{
 const codec=new ResidentDocumentCodec(400),a={name:'a',nodes:{n:{id:'n'}}}
 codec.encode(request(a))
 assert.throws(()=>codec.encode({...request(a,2,1,a),owner:'different'}),/CODEC_BASE_MISSING/)
 assert.throws(()=>codec.encode(request({...a,name:'x'.repeat(500)},2,1,a)),/allowance/)
 assert.throws(()=>codec.encode({...request(a,2,1,a),nodeOrder:['missing']}),/Incomplete/)
 assert.equal(codec.encode(request(a,2,1,a)).json,JSON.stringify(a))
 assert.equal(codec.encode({...request(a,4),owner:'new'}).sequence,4)
 assert.throws(()=>codec.encode(request(a,5,2,a)),/CODEC_BASE_MISSING/)
})
test('prepared bytes plus first delta preserve order, deletes and atomic failure',()=>{
 const codec=new ResidentDocumentCodec(20000),old={name:'old',nodes:{kept:{id:'kept'}}}
 codec.encode(request(old))
 const base={name:'seed',nodes:{a:{id:'a',x:-0},b:{id:'b'}},extra:null}
 const changed={nodes:{b:base.nodes.b,a:{...base.nodes.a,x:2}},name:'changed'}
 const delta={...request(changed,2,0,base),installJson:JSON.stringify(base)}
 assert.throws(()=>codec.encode({...delta,nodes:[],nodeOrder:['missing']}),/Incomplete/)
 assert.equal(codec.encode(request(old,2,1,old)).json,JSON.stringify(old))
 assert.equal(codec.encode({...delta,sequence:3}).json,JSON.stringify(changed))
 assert.throws(()=>codec.encode({...request(changed,4,3,changed),installJson:JSON.stringify(base)}),/prepared base/)
 assert.throws(()=>codec.encode({...delta,installJson:' '.repeat(20001)}),/prepared base/)
 assert.throws(()=>codec.encode({...delta,installJson:'{"nodes":[]}'}),/prepared document/)
 assert.equal(codec.encode(request(changed,4,3,changed)).json,JSON.stringify(changed))
})
