import type { ImageAdjust, PatternTile } from './model'

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

const tileModes = { RECTANGULAR: 'grid', HORIZONTAL_HEXAGONAL: 'stagger_horizontal', VERTICAL_HEXAGONAL: 'stagger_vertical' } as const

function tileNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined
}

/** FIG image TILE parameters. The scaled image is pinned to the fill; a
 * present `patternSpacing` vector replaces scalar `spacing`, and a missing
 * vector component is zero. Out-of-range or non-numeric values throw so the
 * caller can keep the original file. */
export function figImageTile(paint: Record<string, any>): PatternTile {
  const mode = paint.patternTileType ?? 'RECTANGULAR'
  if (!Object.hasOwn(tileModes, mode)) throw new Error(`FIG 平铺模式 ${mode} 暂不支持`)
  const align = (value: unknown, field: string) => {
    if (value === undefined || value === 'START') return 'start' as const
    if (value === 'CENTER') return 'center' as const
    if (value === 'END') return 'end' as const
    throw new Error(`FIG 平铺对齐 ${field}=${String(value)} 暂不支持；原文件未修改`)
  }
  let spacingX = 0
  let spacingY = 0
  if (paint.patternSpacing !== undefined) {
    const spacing = paint.patternSpacing
    if (!spacing || typeof spacing !== 'object' || Array.isArray(spacing))
      throw new Error('FIG 平铺间距无效；原文件未修改')
    const x = tileNumber(spacing.x ?? 0, 0, 1e7)
    const y = tileNumber(spacing.y ?? 0, 0, 1e7)
    if (x === undefined || y === undefined) throw new Error('FIG 平铺参数无效；原文件未修改')
    spacingX = x
    spacingY = y
  } else if (paint.spacing !== undefined) {
    const gap = tileNumber(paint.spacing, 0, 1e7)
    if (gap === undefined) throw new Error('FIG 平铺参数无效；原文件未修改')
    spacingX = gap
    spacingY = gap
  }
  const scale = tileNumber(paint.scale ?? 1, Number.MIN_VALUE, 1e6)
  const rotation = tileNumber(paint.rotation ?? 0, -1e6, 1e6)
  if (scale === undefined || rotation === undefined) throw new Error('FIG 平铺参数无效；原文件未修改')
  return {
    mode: tileModes[mode as keyof typeof tileModes],
    size: [0, 0],
    offset: [0, 0],
    alignment: [align(paint.horizontalAlignment, 'horizontalAlignment'), align(paint.verticalAlignment, 'verticalAlignment')],
    ...(scale !== 1 ? { scale } : {}),
    ...(rotation !== 0 ? { rotation } : {}),
    ...(spacingX !== 0 || spacingY !== 0 ? { spacing: [spacingX, spacingY] } : {}),
  }
}
