import type { InterfaceLocale } from './interface-preference'
import { LAYOUT_SUGGESTION_LIMIT, type LayoutSuggestionText } from './layout-suggestions'
const phrases: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  horizontal: ['横向布局', 'Horizontal layout'], vertical: ['纵向布局', 'Vertical layout'], grid: ['网格布局', 'Grid layout'],
  nested: ['嵌套布局', 'Nested layouts'], wrapped: ['换行排列', 'Wrapped rows'],
  'preserve-coordinates': ['规则几何关系在数值精度内匹配；坐标和尺寸保持不变。', 'Regular geometry matches to numerical precision; coordinates and sizes are preserved.'],
  'independent-containers': ['现有嵌套容器独立推断；隐藏和绝对定位子项保留原位置。', 'Existing nested containers are inferred independently; hidden and absolute children retain their slots.'],
  'wrapped-compatible': ['相同的规则几何关系也适合横向换行排列。', 'The same regular geometry also fits wrapped horizontal rows.'],
  'grid-versus-wrap': ['选择网格以保持列稳定，或选择换行以适应可用宽度。', 'Choose grid for stable columns, or wrap for flow that adapts to available width.'],
  'ancestor-excluded': ['锁定、隐藏或组件祖先：子树保持不变', 'Locked, hidden or component ancestor: subtree left unchanged'],
})
const errors: Readonly<Record<string, string>> = Object.freeze({
  'Select an existing frame or group to preview layout': '请选择现有画板或编组以预览布局',
  'Repeated or cyclic layout hierarchy': '布局层级存在重复或循环引用',
  [`Layout suggestion is limited to ${LAYOUT_SUGGESTION_LIMIT} nodes`]: `布局建议最多支持 ${LAYOUT_SUGGESTION_LIMIT} 个节点`,
  'Missing layout child': '布局子项缺失', 'Invalid layout geometry': '布局几何数据无效',
  'Layout preview exceeds the 8 MiB fingerprint budget': '布局预览超出 8 MiB 指纹预算',
  'Cyclic layout ancestry': '布局祖先存在循环引用',
  'Layout preview is stale; preview again before applying': '布局预览已过期，请重新预览后应用',
  'Unknown or unavailable layout suggestion': '布局建议未知或不可用',
  'Unknown layout suggestion': '布局建议未知或不可用',
})
/** Exact known errors only. Keep unknown diagnostics and the original Error prefix verbatim. */
export function layoutSuggestionError(raw: string, locale: InterfaceLocale): string {
  if (locale === 'en') return raw
  const prefix = raw.startsWith('Error: ') ? 'Error: ' : '', message = prefix ? raw.slice(prefix.length) : raw
  return Object.prototype.hasOwnProperty.call(errors, message) ? prefix + errors[message] : raw
}
/** Never infer display meaning from raw strings: they may contain author names. */
export function layoutSuggestionText(meta: LayoutSuggestionText | undefined, raw: string, locale: InterfaceLocale): string {
  if (!meta) return raw
  if (Object.prototype.hasOwnProperty.call(phrases, meta.key)) return phrases[meta.key][locale === 'en' ? 1 : 0]
  switch (meta.key) {
    case 'subtree-excluded': return locale === 'en' ? `${meta.frameName}: locked, hidden or component subtree left unchanged` : `${meta.frameName}：锁定、隐藏或组件子树保持不变`
    case 'explicit-edit-required': return locale === 'en' ? `${meta.frameName}: locked, transformed or responsive children require explicit layout editing` : `${meta.frameName}：锁定、变换或响应式子项需要显式编辑布局`
    case 'ambiguous-geometry': return locale === 'en' ? `${meta.frameName}: irregular spacing, overlap or ambiguous geometry; no automatic rearrangement` : `${meta.frameName}：间距不规则、重叠或几何关系不明确；不会自动重新排列`
    case 'frame-layout': {
      if (locale === 'en') return `${meta.frameName}: ${meta.mode}, gap ${meta.gap}, alignment ${meta.align}`
      const mode = Object.prototype.hasOwnProperty.call(phrases, meta.mode) ? phrases[meta.mode][0] : meta.mode
      const align = meta.align === 'start' ? '起点' : meta.align === 'center' ? '居中' : meta.align === 'end' ? '终点' : meta.align
      return `${meta.frameName}：${mode}，间距 ${meta.gap}，对齐 ${align}`
    }
    default: return raw
  }
}
