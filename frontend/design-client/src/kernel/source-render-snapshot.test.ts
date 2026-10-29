import {expect,test} from 'vitest'
import {sourceRenderSnapshot} from './source-render-snapshot'
const source={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'owned-token',nodes:124447,pageId:'page',stageId:'stage'}
test('source carriers contain only owner scalars regardless of source byte size',()=>{
 const actual=sourceRenderSnapshot({...source,owner:{...source.owner,path:'/private/source'},bytes:600*1024**2,path:'/private/source',warnings:['source text'],nodes:124447} as any)
 expect(actual).toEqual(source);expect(Object.keys(actual.owner)).toEqual(['documentId','sessionEpoch'])
 expect(JSON.stringify(actual).length).toBeLessThan(256)
})
test('source carrier validation keeps exact identities and finite transport ordinals',()=>{
 for(const changed of [{token:''},{token:'bad\n'},{nodes:Infinity},{nodes:0},{revision:-1},{owner:{...source.owner,sessionEpoch:0}},{pageId:'page/path'}])
  expect(()=>sourceRenderSnapshot({...source,...changed})).toThrow('Invalid source canvas owner')
})
