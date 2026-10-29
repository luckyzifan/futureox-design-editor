import http from'node:http';import{readFile,writeFile}from'node:fs/promises';import path from'node:path'
const root=path.resolve(process.argv[2]),record=path.resolve('testing/verification-topology-navigation-20261026')
const reports=new Map([['/oracle-report','bounded-shadow-hardware-20261027.json'],['/stroke-report','stroke-shadow-hardware-20261027.json'],['/row-report','row-upload-hardware-20261027.json']])
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1'),name=reports.get(url.pathname)
 if(name&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>1024*1024)throw Error('Report too large')};const report=JSON.parse(body);await writeFile(path.join(record,name),JSON.stringify(report,null,2));res.end('ok');return}
 if(req.method!=='GET'){res.writeHead(405).end();return}
 const file=url.pathname==='/source-image.png'?'/tmp/topology-image-rows-source-20261027.png':path.resolve(root,'.'+decodeURIComponent(url.pathname))
 if(file!=='/tmp/topology-image-rows-source-20261027.png'&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
 const body=await readFile(file),mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.png':'image/png','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream'
 res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(body)
}catch(error){res.writeHead(500).end(String(error))}}).listen(60163,'127.0.0.1',()=>console.log('Frozen hardware harness on 127.0.0.1:60163'))
