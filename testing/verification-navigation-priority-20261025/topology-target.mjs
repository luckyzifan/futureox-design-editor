import {readFile} from 'node:fs/promises'

/** Only fixture selection differs by file format. Gestures use the ordinary
 * Editor/Canvas and the same action traces as FIG/117. */
export async function topologyTarget(page,expect,settle){
  await expect(page.locator('.app-shell')).toHaveAttribute('data-source-document','true',{timeout:120000})
  await expect(page.locator('.header-right').getByRole('button',{name:'保存',exact:true})).toBeEnabled({timeout:180000})
  await settle()
  await expect(page.locator('.source-workspace')).toHaveCount(0)
  await expect(page.locator('.editor-workspace [data-testid="canvas"]')).toHaveCount(1)
  const cases=JSON.parse(await readFile(new URL('../verification-drag-response-20261024/sketch-cases.json',import.meta.url),'utf8'))
  const selected=process.env.SOURCE_CASE?cases.find(item=>item.key===process.env.SOURCE_CASE):undefined
  if(process.env.SOURCE_CASE&&!selected)throw Error('Unknown topology fixture key')
  await page.getByRole('button',{name:'页面 / 画板',exact:true}).click()
  await page.getByLabel('搜索源对象',{exact:true}).fill(selected?.id||'控件')
  await page.getByRole('button',{name:'搜索',exact:true}).click()
  const row=selected?page.locator(`[data-source-key="${selected.key}"]`):page.locator('.source-workspace-rows > div').filter({hasText:'完整页面'})
  await expect(row).toHaveCount(1,{timeout:30000})
  const key=await row.getAttribute('data-source-key')
  await row.locator('button').first().click()
  await expect(page.locator('.source-canvas-status')).toContainText('已载入',{timeout:180000})
  await settle()
  await page.getByLabel('搜索图层',{exact:true}).fill(selected?.originalName||'数据名称')
  const id=selected?.id||'4F1BF005-CF98-4296-8A6B-9194F5146DAD'
  await page.getByTestId('layer-'+id).click()
  return {key,id}
}
