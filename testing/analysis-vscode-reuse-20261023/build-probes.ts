// Run with Bun. Upstream root and output directory are explicit arguments.
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3])
const ts=(await import(path.join(root,'tooling/node_modules/typescript/lib/typescript.js'))).default
fs.mkdirSync(out,{recursive:true})
const files:string[]=[]
function walk(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.ts'))files.push(p)}}
walk(path.join(root,'src'))
for(const file of files){const target=path.join(root,'compiled',path.relative(root,file).replace(/\.ts$/,'.js'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:false}}).outputText)}
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module'}))
const entries:Record<string,string>={
 lifecycle:`export { DisposableStore, MutableDisposable, toDisposable } from './compiled/src/vs/base/common/lifecycle.js'`,
 async:`export { Delayer, Throttler, Limiter } from './compiled/src/vs/base/common/async.js'`,
 fuzzy:`export { fuzzyScore, createMatches } from './compiled/src/vs/base/common/filters.js'`,
 tree:`export { IndexTreeModel } from './compiled/src/vs/base/browser/ui/tree/indexTreeModel.js'`,
 range:`export { RangeMap } from './compiled/src/vs/base/browser/ui/list/rangeMap.js'`,
 diff:`export { stringDiff } from './compiled/src/vs/base/common/diff/diff.js'`,
 monaco:`export { editor, languages, Uri } from './tooling/node_modules/monaco-editor/esm/vs/editor/editor.api.js'`,
 monacoWorker:`import './tooling/node_modules/monaco-editor/esm/vs/editor/editor.worker.js'`,
}
const results:any[]=[]
for(const [name,source] of Object.entries(entries)){
 const entry=path.join(root,`${name}-entry.js`);fs.writeFileSync(entry,source)
 const r=await Bun.build({entrypoints:[entry],outdir:path.join(root,'bundles',name),target:'browser',format:'esm',minify:true,naming:'[name].[ext]',loader:{'.ttf':'file'}})
 if(!r.success)throw Error(name+': '+r.logs.join('\n'))
 const assets=[]
 for(const file of r.outputs){const bytes=Buffer.from(await file.arrayBuffer());assets.push({file:path.basename(file.path),bytes:bytes.length,gzipBytes:gzipSync(bytes).length})}
 results.push({name,assets,totalBytes:assets.reduce((a,x)=>a+x.bytes,0),gzipBytes:assets.reduce((a,x)=>a+x.gzipBytes,0)})
}
fs.writeFileSync(path.join(out,'bundle-sizes.json'),JSON.stringify({typescript:ts.version,bun:Bun.version,monaco:JSON.parse(fs.readFileSync(path.join(root,'tooling/node_modules/monaco-editor/package.json'),'utf8')).version,
 note:'Isolated minified ESM exports, no host app, CSS included when emitted; gzip sizes are file-wise sums. Not startup/RSS measurements. Monaco language workers are excluded.',results},null,2))
console.log(JSON.stringify(results))
