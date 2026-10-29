import http from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
const root=path.resolve(process.argv[2]),report=path.resolve(process.argv[3]),port=Number(process.argv[4]||60218)
const realInputs=process.argv[5]?path.resolve(process.argv[5]):undefined
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1')
 if(url.pathname==='/report'&&req.method==='POST'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw Error('Report too large')}
  await writeFile(report,JSON.stringify(JSON.parse(body),null,2));res.end('ok');return
 }
 if(req.method!=='GET'){res.writeHead(405).end();return}
 const realName={'/real-inputs/fig.json':'fig.json','/real-inputs/117.json':'117.json','/real-inputs/manifest.json':'manifest.json'}[url.pathname]
 const file=realInputs&&realName?path.join(realInputs,realName):path.resolve(root,'.'+decodeURIComponent(url.pathname))
 if(!(realInputs&&realName)&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
 const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream'
 const body=await readFile(file);res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(body)
}catch(error){if(!res.headersSent)res.writeHead(error?.code==='ENOENT'?404:500);res.end(String(error))}}).listen(port,'127.0.0.1',()=>console.log('Hardware check: http://127.0.0.1:'+port+'/testing/verification-render-work-reduction-20261028/hardware.html'))
