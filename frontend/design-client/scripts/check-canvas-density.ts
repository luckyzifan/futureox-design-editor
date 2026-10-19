/** Real GPU canvas: cached zoom levels, physical DPR and large display coverage. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const output = await mkdtemp(join(tmpdir(),'design-canvas-density-'))
const server = await createServer({root:new URL('..',import.meta.url).pathname,
  server:{host:'127.0.0.1',port:0,strictPort:true}})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({headless:true,chromiumSandbox:true,
    args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const records: unknown[] = []
  for (const dpr of (process.env.DESIGN_TEST_DPR ? [Number(process.env.DESIGN_TEST_DPR)] : [1,2,3])) {
    const context = await browser.newContext({viewport:{width:1200,height:900},deviceScaleFactor:dpr})
    try {
      const page=await context.newPage(), errors:string[]=[]
      page.on('pageerror',e=>errors.push(String(e)))
      await page.goto(server.resolvedUrls!.local[0]+'render-regression-check.html')
      await page.waitForFunction(()=>{
        try{return JSON.parse(document.querySelector('#results')!.textContent!).status!=='running'}catch{return false}
      },null,{timeout:180_000})
      const report=await page.locator('#results').innerText()
      await writeFile(join(output,`dpr-${dpr}.json`),report)
      const result=JSON.parse(report)
      if(result.status!=='passed'||errors.length)throw Error(JSON.stringify({dpr,result,errors}))
      records.push({dpr,...result})
      console.log(JSON.stringify({dpr,status:result.status,stages:result.stages.length,output}))
    } finally {await context.close()}
  }
  await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',records},null,2))
} catch(error) {
  await writeFile(join(output,'failure.txt'),String(error));console.error(JSON.stringify({status:'failed',error:String(error),output}));process.exitCode=1
} finally {await browser?.close();await server.close()}
