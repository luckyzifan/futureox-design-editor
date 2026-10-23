// Turn actual per-target CDP recordings into the shared, hash-checked flame schema.
import{readFile,writeFile,mkdir,readdir}from'node:fs/promises'
import{createHash}from'node:crypto'
import path from'node:path'
const [run,host,prefix,...stages]=process.argv.slice(2),out=path.resolve('testing/verification-topology-repairs-20261023'),destination=path.join(out,prefix+'-topology');await mkdir(destination,{recursive:false})
const results=JSON.parse(await readFile(path.join(run,'results.json'),'utf8'));results.extended={cpuProfiling:true,scope:'Explicit CDP stop/start at each operation boundary; profiler overhead included; no physical latency claim'};await writeFile(path.join(destination,'results.json'),JSON.stringify(results,null,2))
for(const stage of stages){const input=JSON.parse(await readFile(path.join(run,stage+'-profiles.json'),'utf8'));if(input.errors.length)throw Error(JSON.stringify(input.errors));const targets=[];for(const [i,item]of input.profiles.entries()){const file=stage+'-'+i+'.cpuprofile';await writeFile(path.join(destination,file),JSON.stringify(item.profile));targets.push({target:item.target,file})}await writeFile(path.join(destination,stage+'-targets.json'),JSON.stringify(targets))}
const assets=path.join(host,'dist/renderer'),artifacts={};for(const file of await readdir(path.join(assets,'assets'))){if(/\.(js|map|wasm)$/.test(file))artifacts['assets/'+file]=createHash('sha256').update(await readFile(path.join(assets,'assets',file))).digest('hex')}
await writeFile(path.join(destination,'runtime-artifacts.json'),JSON.stringify({artifacts,source:path.resolve(host)}));console.log(JSON.stringify({destination,assets}))
