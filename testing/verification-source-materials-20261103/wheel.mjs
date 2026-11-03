// Sample independently of input dispatch. A requested density counts only
// after the presenter reports an intersecting real GPU texture at that level.
export async function replayWheel(page){
  const menu=page.locator('.view-menu')
  if(!await menu.evaluate(n=>n.open))await menu.locator('summary').click()
  const input=page.getByLabel('缩放比例',{exact:true})
  await input.fill('36');await input.press('Enter')
  await page.waitForFunction(()=>{
    const c=document.querySelector('.native-source-content')
    return c?.dataset.cameraReprojected==='false'&&c.dataset.sourceReadyCamera===c.dataset.projectedCamera&&
      JSON.parse(c.dataset.projectedCamera).zoom===.36
  },null,{timeout:30000,polling:'raf'})
  if(await menu.evaluate(n=>n.open))await menu.locator('summary').click()
  const bounds=await page.getByTestId('canvas').boundingBox()
  const pos={x:bounds.x+bounds.width*.49,y:bounds.y+bounds.height*.49}
  const cdp=await page.context().newCDPSession(page)
  await page.evaluate(()=>{
    window.__sourceWheel={frames:[],active:true}
    const capture=t=>{
      if(!window.__sourceWheel.active)return
      const d=document.querySelector('.native-source-content')?.dataset
      if(d)window.__sourceWheel.frames.push({t,zoom:Number(d.sourceDemandZoom),moving:d.sourceMoving==='true',
        demand:Number(d.sourceDemandScale),visibleDemand:Number(d.sourceVisibleDemandScale),
        visible:Number(d.sourceRenderScale),seq:Number(d.sourcePresentation),
        shown:Number(d.sourceShownSequence),newDensity:Number(d.sourceShownNewScale)})
      requestAnimationFrame(capture)
    }
    requestAnimationFrame(capture)
  })
  const gestures=[]
  for(const [name,delta,count] of [['out',6,30],['in',-6,62],['out-again',6,38],['in-again',-7,38]]){
    const inputs=[]
    for(let i=0;i<count;i++){
      inputs.push(await page.evaluate(()=>performance.now()))
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...pos,deltaX:0,deltaY:delta,modifiers:2})
      await page.waitForTimeout(29)
    }
    gestures.push({name,delta,inputs})
    await page.waitForTimeout(450)
  }
  await page.waitForFunction(()=>{
    const c=document.querySelector('.native-source-content'),s=document.querySelector('.native-source-surface .kernel-status')
    return s?.textContent==='WebGPU · 清晰'&&c?.dataset.cameraReprojected==='false'&&c.dataset.sourceReadyCamera===c.dataset.projectedCamera
  },null,{timeout:30000,polling:'raf'})
  const frames=await page.evaluate(()=>{window.__sourceWheel.active=false;return window.__sourceWheel.frames})
  await cdp.detach()
  return {gestures,frames}
}
