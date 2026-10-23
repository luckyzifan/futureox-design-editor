import{readFileSync}from'node:fs'
import{initializePicking}from'../../frontend/design-client/src/kernel/picking'
import{prepareDocumentJson}from'../../frontend/design-client/src/prepared-document'
await initializePicking({wasm:readFileSync('frontend/design-client/public/kernel/design_kernel_bg.wasm'),font:readFileSync('frontend/design-client/public/fonts/NotoSansSC.ttf')})
const fixtures=JSON.parse(readFileSync('testing/verification-topology-repairs-20261023/source-fixtures.json','utf8')).records
for(const item of fixtures.slice(1)){console.log('prepare',item.key);const at=performance.now();try{const result=prepareDocumentJson(readFileSync(item.file,'utf8'));console.log('prepared',performance.now()-at,result.document?Object.keys(result.document.nodes).length:Object.keys(result))}catch(error){console.error(error);process.exitCode=1}}
