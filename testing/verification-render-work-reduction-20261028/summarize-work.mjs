import {readFile,writeFile} from 'node:fs/promises'
const [input,output]=process.argv.slice(2)
if(!input)throw Error('Hardware report path required')
const source=JSON.parse(await readFile(input,'utf8'))
const groups=['Coverage','Paint','Merge','Effect','Copy','PaintMerge','Resolve','Present','Other']
const result={status:source.status,adapter:source.adapter,scope:source.scope,
 note:'Draw counts and submitted rectangle area are distinct from GPU time. Missing pixel measurements are explicit; no FPS or physical presentation claim.',
 cases:(source.cases||[]).map(row=>({name:row.name,words:row.words,differences:row.differences,packetNodes:row.packetNodes,
  controlMs:row.controlMs,candidateMs:row.candidateMs,improvement:row.improvement,workReduced:row.workReduced,coldWorkReduced:row.coldWorkReduced,
  sides:(row.runs||[]).map(runs=>{const run=runs[0],work=run?.work||{};return {draws:run?.draws,pixels:run?.pixels,peakBytes:run?.peakBytes,
   classificationVersion:work.drawWorkVersion||1,measuredDraws:work.drawPixelsMeasuredDraws,unmeasuredDraws:work.drawPixelsUnmeasuredDraws,
   categories:groups.map(name=>({name,draws:work['draw'+name]||0,measuredRectanglePixels:work['drawPixels'+name]??null})).sort((a,b)=>(b.measuredRectanglePixels||0)-(a.measuredRectanglePixels||0)),
   fastPaths:Object.fromEntries(Object.entries(work).filter(([key])=>key.startsWith('fast')))}})}))}
const text=JSON.stringify(result,null,2)+'\n'
if(output)await writeFile(output,text);else console.log(text)
