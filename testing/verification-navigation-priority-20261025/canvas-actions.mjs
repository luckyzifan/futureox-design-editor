/** Native UI controls only; no editor state injection or fake completion. */
export async function canvasZoom(page,value){
  const menu=page.locator('.view-menu')
  if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click()
  const input=page.getByLabel('缩放比例',{exact:true})
  await input.fill(String(value));await input.press('Enter');await input.press('Escape')
  await page.waitForFunction(()=>!document.querySelector('.view-menu')?.open)
}
