import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {evaluateReport, rasterMetric} from './report-contract.mjs'
const [bundleArg,outArg]=process.argv.slice(2)
if(!bundleArg||!outArg)throw Error('Usage: node summarize.mjs BUNDLE FRESH_DIRECTORY')
const bundle=path.resolve(bundleArg),out=path.resolve(outArg)
const files=(await fs.readdir(path.join(bundle,'evidence'))).filter(n=>/^\d+-report.json$/.test(n)).sort()
if(!files.length)throw Error('Missing actual reports')
const report=JSON.parse(await fs.readFile(path.join(bundle,'evidence',files.at(-1)),'utf8'))
const config=JSON.parse(await fs.readFile(path.join(bundle,'fixture.json'),'utf8'))
const sum=(rows,key)=>{const a=rows.map(r=>r[key]).filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0):null}
const max=(rows,key)=>{const a=rows.map(r=>r[key]).filter(Number.isFinite);return a.length?Math.max(...a):null}
const cases=(report.samples||[]).map(row=>({id:row.id,status:row.status,error:row.error,target:row.target,sourceLoadMs:row.sourceLoadMs??(Number.isFinite(row.sourceReadyAt)?row.sourceReadyAt-row.start:null),
  firstVisibleMs:row.firstVisibleMs??(Number.isFinite(row.firstVisibleAt)?row.firstVisibleAt-(row.sourceReadyAt??row.start):null),renderReadyMs:row.renderReadyMs??null,stopToReadyMs:row.stopToReadyMs??null,tailMs:row.tailMs??null,
  observedMs:row.observedMs??null,lastStatus:row.lastStatus,activeAtReady:row.activeAtReady??null,activeAfterQuiet:row.activeAfterQuiet??null,
  motionQuality:row.motionQuality,visibleUiStalls:row.visibleUiStalls,readyPixels:row.readyPixels,quietPixels:row.quietPixels,
  compileMs:rasterMetric(row.requests,'compileMs'),graphMs:rasterMetric(row.requests,'graphMs'),checkpointMs:rasterMetric(row.requests,'checkpointMs'),finishMs:rasterMetric(row.requests,'finishMs'),
  drawCalls:rasterMetric(row.requests,'drawCalls'),peakTextureBytes:rasterMetric(row.requests,'peakTextureBytes','max'),overlappedPreparations:rasterMetric(row.requests,'overlappedPreparations'),devices:row.devices,
  cancelledRequests:row.requests.filter(r=>r.error?.includes('PREVIEW_CANCELLED')).length,
  deliveredTileTotals:{count:row.tiles.length,compileMs:sum(row.tiles,'compileMs'),graphMs:sum(row.tiles,'graphMs'),drawCalls:sum(row.tiles,'tileDrawCalls')},
  work:Object.fromEntries([...new Set(row.tiles.flatMap(t=>Object.keys(t).filter(k=>/^(draw|fast|passPixels)/.test(k)&&!['drawWorkVersion','drawWorkCapped'].includes(k))))].map(k=>[k,sum(row.tiles,k)]))}))
const summary={status:report.status,source:report.source,runtime:report.runtime,assessment:evaluateReport(report,config),cases,
  notes:['Controlled source-surface camera inputs, not full editor/OS input.','At-ready readback may wait for GPU; it is not an instantaneous GUI capture.','Diagnostic builds only. Graph includes waits; stages can overlap. Missing fields stay null.','Same-tier pixel consistency is separate from independent visual fidelity.']}
await fs.mkdir(out);await fs.cp(path.join(bundle,'evidence'),path.join(out,'raw'),{recursive:true})
for(const name of ['manifest.json','run.json','gpu-info.json','competition-before.txt','competition-after.txt'])try{await fs.copyFile(path.join(bundle,name),path.join(out,name))}catch(e){if(e.code!=='ENOENT')throw e}
for(const name of await fs.readdir(bundle))if(name.startsWith('gui-')&&name.endsWith('.png'))await fs.copyFile(path.join(bundle,name),path.join(out,name))
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2))
const hashes={};async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else hashes[path.relative(out,p)]=createHash('sha256').update(await fs.readFile(p)).digest('hex')}}await scan(out)
await fs.writeFile(path.join(out,'evidence-hashes.json'),JSON.stringify(hashes,null,2))
console.log(JSON.stringify({status:summary.status,assessment:summary.assessment,cases:cases.map(r=>({id:r.id,status:r.status,sourceMs:r.sourceLoadMs,readyMs:r.renderReadyMs,stopMs:r.stopToReadyMs,tailMs:r.tailMs,motion:r.motionQuality,compileMs:r.compileMs,graphMs:r.graphMs,draws:r.drawCalls,error:r.error}))},null,2))
if(summary.assessment.status!=='PASS')process.exitCode=1
