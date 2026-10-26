import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {TileResidencyLedger,estimatedTileResidencyBytes} from '../../frontend/design-client/src/kernel/page-memory-policy.ts'
const cases=[]
for(const count of [300,3000,20000]){
  const values=Array.from({length:count},(_,i)=>({bytes:new Uint8Array(),gpuTile:i%Math.ceil(count*.9),width:514,height:514}))
  const removals=Math.min(512,Math.floor(count/2)),baseline=[],candidate=[]
  for(let run=-1;run<7;run++)for(const variant of run%2?['candidate','baseline']:['baseline','candidate']){
    const remaining=new Map(values.map((value,i)=>[i,value])),start=performance.now()
    const ledger=variant==='candidate'?new TileResidencyLedger(remaining.values()):undefined
    let bytes=ledger?.bytes??estimatedTileResidencyBytes(remaining.values())
    for(let i=0;i<removals;i++){const value=remaining.get(i);remaining.delete(i)
      if(ledger){ledger.remove(value);bytes=ledger.bytes}else bytes=estimatedTileResidencyBytes(remaining.values())}
    const elapsed=performance.now()-start
    assert.equal(bytes,estimatedTileResidencyBytes(remaining.values()))
    if(run>=0)(variant==='candidate'?candidate:baseline).push(elapsed)
  }
  const summary=values=>({medianMs:values.toSorted((a,b)=>a-b)[3],maxMs:Math.max(...values),samples:values})
  cases.push({count,removals,baseline:summary(baseline),candidate:summary(candidate)})
}
const report={status:'passed',scope:'isolated CPU transaction benchmark; alternating order, one warmup and seven samples; exact independent accounting oracle; not GUI latency',cases}
await writeFile('testing/verification-render-pipeline-20261025/ledger-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
