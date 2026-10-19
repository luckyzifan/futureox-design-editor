import type { ImageAdjust } from './model'

/** Native FIG paintFilter values are shader inputs, not plugin slider values.
 * In the verified native round trip, plugin contrast -0.31 is stored as -0.093;
 * applying the UI conversion again here would change the imported pixels. */
export function figImageAdjust(paint: Record<string, any>): ImageAdjust | undefined {
  const source=paint.paintFilter ?? paint.filterColorAdjust
  if (source === undefined) return
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('FIG 图片调整参数无效')
  const allowed=['exposure','contrast','vibrance','temperature','tint','highlights','shadows']
  for (const [key,value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>1) throw Error(`FIG 图片调整 ${key} 无效`)
    if (!allowed.includes(key) && value !== 0) throw Error(`FIG 图片调整 ${key} 尚不支持无损导入`)
  }
  const value=(key:string)=>source[key] ?? 0
  const result:ImageAdjust={exposure:value('exposure'),contrast:value('contrast'),color:value('vibrance'),
    temperature:value('temperature'),tint:value('tint'),highlights:value('highlights'),shadows:value('shadows'),highlightShadowThreshold:.5}
  return allowed.some(key=>value(key)!==0)?result:undefined
}
