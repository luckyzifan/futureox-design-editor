import {writeFile} from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-topology-navigation-20261026'),client=path.join(root,'frontend/design-client')
Object.assign(process.env,{VITE_DESIGN_WIDE_RATIONAL_PREFIX:'0',VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE:'0',VITE_DESIGN_LARGE_SHADOW_TENT:'0',VITE_DESIGN_EXACT_WHOLE_TENT_2048:'0'})
const {createServer}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
const server=await createServer({root:client,configFile:path.join(client,'vite.config.ts'),plugins:[{name:'local-oracle-report',configureServer(server){
 for(const [route,reportName] of [['/oracle-report','bounded-shadow-hardware.json'],['/stroke-report','stroke-shadow-hardware.json']])server.middlewares.use(route,async(req,res,next)=>{if(req.method!=='POST')return next();let body='';for await(const chunk of req){body+=chunk;if(body.length>1024*1024){res.statusCode=413;res.end();return}}try{const report=JSON.parse(body);await writeFile(path.join(out,reportName),JSON.stringify(report,null,2));res.end('ok')}catch{res.statusCode=400;res.end()}})
}}],server:{port:60162,strictPort:true,host:'127.0.0.1',fs:{allow:[root]}},clearScreen:false})
await server.listen();const port=server.httpServer.address().port
const url=`http://127.0.0.1:${port}/@fs${out}/large-wide-hardware.html`
await writeFile(path.join(out,'large-wide-oracle-url.json'),JSON.stringify({url,port,pid:process.pid}));console.log(url)
