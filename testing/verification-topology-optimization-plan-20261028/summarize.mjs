import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {evaluateReport} from './report-contract.mjs'
const bundle=path.resolve(process.argv[2]||''),out=path.resolve(process.argv[3]||'')
if(process.argv.length!==4)throw Error('Usage: node summarize.mjs BUNDLE FRESH_OUTPUT_DIRECTORY')
const files=(await fs.readdir(path.join(bundle,'evidence'))).filter(n=>/^\d+-report.json$/.test(n)).sort()
if(!files.length)throw Error('No actual render report')
const report=JSON.parse(await fs.readFile(path.join(bundle,'evidence',files.at(-1)),'utf8'))
const config=JSON.parse(await fs.readFile(path.join(bundle,'fixture.json'),'utf8'))
const sum=(rows,key)=>{const values=rows.map(r=>r[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0):null}
const max=(rows,key)=>{const values=rows.map(r=>r[key]).filter(Number.isFinite);return values.length?Math.max(...values):null}
const cases=(report.samples||[]).map(row=>({id:row.id,status:row.status,error:row.error,target:row.target,totalMs:row.totalMs,sourceLoadMs:row.sourceLoadMs??(row.sourceReadyAt===undefined?null:row.sourceReadyAt-row.start),
 firstVisibleMs:row.firstVisibleMs??(row.firstVisibleAt===undefined?null:row.firstVisibleAt-(row.sourceReadyAt??row.start)),renderReadyMs:row.renderReadyMs,stopToReadyMs:row.stopToReadyMs,compileMs:sum(row.requests.filter(r=>r.tiles>0),'compileMs'),graphMs:sum(row.requests.filter(r=>r.tiles>0),'graphMs'),
 checkpointMs:sum(row.requests.filter(r=>r.tiles>0),'checkpointMs'),finishMs:sum(row.requests.filter(r=>r.tiles>0),'finishMs'),drawCalls:sum(row.requests.filter(r=>r.tiles>0),'drawCalls'),peakTextureBytes:max(row.requests.filter(r=>r.tiles>0),'peakTextureBytes'),
 overlappedPreparations:sum(row.requests,'overlappedPreparations'),cancelledRequests:row.requests.filter(r=>r.error?.includes('PREVIEW_CANCELLED')).length,
 maxActive:row.maxActive,visibleUiStalls:row.visibleUiStalls??row.stalls?.filter(s=>s.visible).length,pixels:row.pixels,quality:row.qualitySummary,lastStatus:row.lastStatus,
 deliveredTileTotals:{count:row.tiles?.length||0,compileMs:sum(row.tiles||[],'compileMs'),graphMs:sum(row.tiles||[],'graphMs'),checkpointMs:sum(row.tiles||[],'checkpointMs'),drawCalls:sum(row.tiles||[],'tileDrawCalls'),note:'Completed delivered tiles only; excludes work lost in unfinished/cancelled tiles'},
 workVersions:[...new Set((row.tiles||[]).map(t=>t.drawWorkVersion).filter(Number.isFinite))],workCapped:(row.tiles||[]).some(t=>t.drawWorkCapped>0),
 work:Object.fromEntries([...new Set((row.tiles||[]).flatMap(t=>Object.keys(t).filter(k=>/^(draw|fast|passPixels|tileNodes)/.test(k)&&!['drawWorkVersion','drawWorkCapped'].includes(k))))].map(k=>[k,sum(row.tiles,k)]))}))
const summary={status:report.status,source:report.source,runtime:report.runtime,assessment:evaluateReport(report,config),cases,
 notes:['Diagnostic trace enabled. No A/B speedup claim.','Graph includes checkpoints/waits; stages may overlap. Missing fields are null.','Repeated same-view hashes test consistency, not independent Figma visual correctness.','Camera actions are controller-driven, not trusted native input.']}
await fs.mkdir(out);await fs.cp(path.join(bundle,'evidence'),path.join(out,'raw'),{recursive:true})
for(const name of ['manifest.json','run.json','gpu-info.json','competition-before.txt','competition-after.txt'])try{await fs.copyFile(path.join(bundle,name),path.join(out,name))}catch(error){if(error.code!=='ENOENT')throw error}
for(const name of await fs.readdir(bundle))if(name.startsWith('gui-')&&name.endsWith('.png'))await fs.copyFile(path.join(bundle,name),path.join(out,name))
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2))
const hashes={};async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else hashes[path.relative(out,p)]=createHash('sha256').update(await fs.readFile(p)).digest('hex')}}await scan(out)
await fs.writeFile(path.join(out,'evidence-hashes.json'),JSON.stringify(hashes,null,2))
console.log(JSON.stringify({status:summary.status,assessment:summary.assessment,cases:cases.map(r=>({id:r.id,status:r.status,renderMs:r.renderReadyMs,draws:r.drawCalls,graphMs:r.graphMs,compileMs:r.compileMs,error:r.error}))},null,2))
if(summary.assessment.status!=='PASS')process.exitCode=1
