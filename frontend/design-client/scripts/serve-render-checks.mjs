// Serve the very same built pages used by Electron on an owned loopback port.
// UI navigation/input is performed separately; this script never drives a browser.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { renderCheckHandler } from '../../design-desktop/src/render-check.mjs'
import { resourcePath } from '../../design-desktop/src/security.mjs'
const [bundle, fixture, output] = process.argv.slice(2).map(p => path.resolve(p))
if (!bundle || !fixture || !output) throw Error('Expected built bundle, fixture.fd and private output directory')
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp'}
const diagnostic = renderCheckHandler({fixture}, output, () => ({host:'web',server:'owned-loopback'}))
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = `design-app://app${incoming.url || '/'}`
    const request = new Request(url, {method:incoming.method,headers:incoming.headers,
      ...(incoming.method==='POST'?{body:Readable.toWeb(incoming),duplex:'half'}:{})})
    let response = await diagnostic(request)
    if (!response) {
      if (incoming.method !== 'GET') response = new Response('Not found',{status:404})
      else {
        const file = await resourcePath(bundle, url), type = types[path.extname(file)]
        response = type ? new Response(await readFile(file), {headers:{'Content-Type':type}}) : new Response('Not found',{status:404})
      }
    }
    outgoing.writeHead(response.status, {...Object.fromEntries(response.headers), 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch(error) {
    outgoing.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain'})
    outgoing.end(String(error))
  }
})
server.listen(0,'127.0.0.1',() => console.log(`RENDER_CHECK_SERVER http://127.0.0.1:${server.address().port}`))
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>process.exit(0)))
