import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import path from 'node:path'
const folder=path.dirname(new URL(import.meta.url).pathname),reports=[]
for(const [name,count] of [['bounded-shadow-hardware.json',9],['stroke-shadow-hardware.json',6]]){
 const bytes=readFileSync(path.join(folder,name)),report=JSON.parse(bytes)
 assert.equal(report.status,'passed');assert.equal(report.adapter.fallback,false);assert.equal(report.cases.length,count)
 for(const item of report.cases){assert.equal(item.differences,0);assert.ok(item.words>0);assert.equal(item.runs[0].candidate,false);assert.equal(item.runs[1].candidate,true)}
 if(name.startsWith('bounded')){
  assert.deepEqual(report.configuration,{wide:'0',largeWide:'0',largeShadow:'0',wholeTent:'0',boundedShadow:'default'})
  for(const item of report.cases.filter(c=>c.range==='regular'||c.range==='alpha'))assert.ok(item.runs[1].counters.acceptedLines>0)
 }else for(const item of report.cases)assert.ok(item.runs[1].streamed>0)
 reports.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),cases:count,status:'passed'})
}
const result={scope:'Read-only assertions over saved actual hardware reports; not a new GPU run',reports,totalCases:15,status:'passed'}
writeFileSync(path.join(folder,'hardware-report-assertions.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result))
