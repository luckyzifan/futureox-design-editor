import test from 'node:test'
import assert from 'node:assert/strict'
import {readDesignClipboard,writeDesignClipboard} from '../src/clipboard.mjs'
class ClipboardItem {
  constructor(values){this.values=values;this.types=Object.keys(values)}
  async getType(type){const value=await this.values[type];if(value===undefined)throw new Error('Missing MIME');return value instanceof Blob?value:new Blob([value])}
}
test('Electron 44 clipboard write waits for atomic commit and propagates an async failure',async()=>{
 let release,finished=false,items
 const clipboard={write: value=>{items=value;return new Promise(resolve=>{release=resolve})}}
 const pending=writeDesignClipboard(clipboard,ClipboardItem,null,{forma:'{"format":"forma-nodes"}',text:'Layer'},1024).then(()=>{finished=true})
 await Promise.resolve();assert.equal(finished,false);assert.equal(items.length,1)
 assert.deepEqual(items[0].types,['text/plain','web application/x-forma-nodes-v1'])
 release();await pending;assert.equal(finished,true)
 await assert.rejects(writeDesignClipboard({write:async()=>{throw new Error('OS clipboard failure')}},ClipboardItem,null,{text:'x'},1024),/OS clipboard failure/)
})
test('clipboard only reads supported MIME data and preserves a private PNG instead of OS-converted pixels',async()=>{
 const original=Buffer.from([137,80,78,71,1,2,3]),native=Buffer.from([137,80,78,71,9,9,9])
 const item=new ClipboardItem({'text/uri-list':'file:///private/ignored','image/png':new Blob([native]),'web application/x-forma-png-v1':new Blob([original])})
 assert.deepEqual(await readDesignClipboard({read:async()=>[item]},1024),{image:'data:image/png;base64,'+original.toString('base64')})
 let fetched=false
 assert.deepEqual(await readDesignClipboard({read:async()=>[{types:['text/uri-list'],getType:async()=>{fetched=true;throw Error('must not read files')}}]},1024),{})
 assert.equal(fetched,false)
})
test('clipboard rejects an oversized representation before materializing it',async()=>{
 let decoded=false
 await assert.rejects(readDesignClipboard({read:async()=>[{types:['text/plain'],getType:async()=>({size:1025,text:async()=>{decoded=true;return 'x'}})}]},1024),{code:'CLIPBOARD_TOO_LARGE'})
 assert.equal(decoded,false)
 await assert.rejects(readDesignClipboard({read:async()=>{throw new Error('read denied')}},1024),/read denied/)
})
