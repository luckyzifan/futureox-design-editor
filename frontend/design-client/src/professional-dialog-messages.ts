import { useInterfacePreferences, type InterfaceLocale } from './interface-preference'
import { surfaceEnglish } from './surface-dialog-catalog'
/** Display-only allowlist. Never translate authored names, history labels or core identifiers. */
const english: Readonly<Record<string, string>> = Object.freeze({
  "形状构建器": "Shape builder",
  "关闭形状构建器": "Close shape builder",
  "拖过要合并的区域，或按住 Alt / Option 拖选要删除的区域。应用时可一次撤销。": "Drag across regions to merge, or hold Alt / Option to select regions to delete. Applying creates one undo step.",
  "可选择的形状区域": "Selectable shape regions",
  "清除选择": "Clear selection",
  "操作": "Operation",
  "合并所选区域": "Merge selected regions",
  "删除所选区域": "Delete selected regions",
  "取消": "Cancel",
  "应用": "Apply",
  "请先结束当前编辑再应用形状构建": "Finish the current edit before applying shape builder.",
  "文档已变化，请关闭后重新打开": "The document changed. Close and reopen this dialog.",
  "请先结束当前编辑": "Finish the current edit first.",
  "请选择 1–16 个不重复的闭合形状": "Select 1–16 distinct closed shapes.",
  "形状构建需要同一容器中的图层": "Shape builder requires layers in the same container.",
  "请先将蒙版内容转换为独立矢量": "Convert masked content to independent vectors first.",
  "仅支持未蒙版的闭合形状；请先烘焙布尔或画笔路径": "Only unmasked closed shapes are supported. Bake boolean or brush paths first.",
  "请先将可见描边转换为轮廓": "Outline visible strokes first.",
  "请先烘焙路径偏移或效果": "Bake path offsets or effects first.",
  "当前形状构建支持纯色填充": "Shape builder currently supports solid fills.",
  "锁定、隐藏、裁切或实例内容无法直接构建": "Locked, hidden, clipped or instance content cannot be built directly.",
  "形状构建预览已过期，请重新打开": "The shape builder preview is stale. Reopen it.",
  "未知形状构建操作": "Unknown shape builder operation.",
  "请选择有效区域": "Select valid regions.",
  "设备与尺寸画板": "Device and size frames",
  "关闭": "Close",
  "逻辑设计尺寸，不模拟设备硬件。新画板放在当前页面最右侧，不嵌入选中图层。": "Logical design sizes, not device hardware simulations. New frames are placed at the far right of the current page, outside the selected layer.",
  "搜索画板预设": "Search frame presets",
  "搜索名称或尺寸": "Search names or sizes",
  "预设分类": "Preset category",
  "全部分类": "All categories",
  "交换宽高（横竖方向）": "Swap width and height (orientation)",
  "画板尺寸预设": "Frame size presets",
  "没有匹配的预设": "No matching presets",
  "名称": "Name",
  "自定义画板名称": "Custom frame name",
  "宽": "Width",
  "自定义画板宽": "Custom frame width",
  "高": "Height",
  "自定义画板高": "Custom frame height",
  "创建自定义画板": "Create custom frame",
  "手机": "Phone",
  "平板": "Tablet",
  "桌面": "Desktop",
  "手表": "Watch",
  "社交媒体": "Social media",
  "插件": "Plugin",
  "页面已变化，请关闭后重新打开": "The page changed. Close and reopen this dialog.",
  "画板未创建": "The frame was not created.",
  "宽高必须为 1–100000 的整数": "Width and height must be integers from 1 to 100000.",
  "请先结束当前输入或操作": "Finish the current input or operation first.",
  "当前页面不可用": "The current page is unavailable.",
  "页面层级无效，无法安全放置画板": "The page hierarchy is invalid. The frame cannot be placed safely.",
  "当前画布位置不可用": "The current canvas position is unavailable.",
  "画板未创建，请结束当前编辑后重试": "The frame was not created. Finish the current edit and try again."
})
function catalogValue(source: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(english, source)) return english[source]
  if (Object.prototype.hasOwnProperty.call(surfaceEnglish, source)) return surfaceEnglish[source]
  return undefined
}
const dynamicPatterns: ReadonlyArray<{ pattern: RegExp; format: (groups: string[]) => string }> = [
  { pattern: /^历史版本 r(\d+) 已不存在，请刷新列表$/, format: ([revision]) => `Version r${revision} no longer exists. Refresh the list.` },
  { pattern: /^(前缀|后缀|查找文字|替换文字|图层名称|编号分隔符)无效，最多 200 个字符且不能含控制字符$/, format: ([label]) => `${catalogValue(label) ?? label} is invalid. Use at most 200 characters and no control characters.` },
  { pattern: /^仍有 (\d+) 处引用；请先移除或改用其他资源：([\s\S]*)$/, format: ([count, list]) => `Still referenced in ${count} places. Remove those references or switch to another resource first: ${list}` },
  { pattern: /^不可预览：([\s\S]*)$/, format: ([detail]) => `Cannot preview: ${translateProfessional(detail, 'en')}` },
  { pattern: /^面板载入失败：([\s\S]*)$/, format: ([detail]) => `The panel failed to load: ${translateProfessional(detail, 'en')}` },
  { pattern: /^当前文件暂时无法预览：([\s\S]*)$/, format: ([detail]) => `This file cannot be previewed right now: ${translateProfessional(detail, 'en')}` },
  { pattern: /^此层不可编辑位置\/尺寸：([\s\S]*)$/, format: ([detail]) => `This layer’s position and size cannot be edited: ${translateProfessional(detail, 'en')}` },
  { pattern: /^正在生成 revision (\d+) 的原生页面快照…$/, format: ([revision]) => `Creating the native page snapshot for revision ${revision}…` },
  { pattern: /^(\d+) 个图层已选择$/, format: ([count]) => `${count} ${count === '1' ? 'layer' : 'layers'} selected` },
]
function translateKnownSegments(source: string): string | null {
  const parts = source.split('；')
  if (parts.length < 2) return null
  const translated = parts.map(part => {
    const known = catalogValue(part)
    if (known !== undefined) return known
    for (const { pattern, format } of dynamicPatterns) {
      const match = pattern.exec(part)
      if (match) return format(match.slice(1))
    }
    return null
  })
  return translated.every((part): part is string => part !== null) ? translated.join('; ') : null
}
/** Display translation. Unknown diagnostics, authored names and history labels stay verbatim. */
export function translateProfessional(source: string, locale: InterfaceLocale = 'zh-CN'): string {
  if (locale !== 'en' || typeof source !== 'string' || source.length === 0) return source
  const direct = catalogValue(source)
  if (direct !== undefined) return direct
  if (source.startsWith('Error: ')) return `Error: ${translateProfessional(source.slice(7), locale)}`
  for (const { pattern, format } of dynamicPatterns) {
    const match = pattern.exec(source)
    if (match) return format(match.slice(1))
  }
  return translateKnownSegments(source) ?? source
}
export function useProfessionalDialogText() {
  const { locale } = useInterfacePreferences()
  const tr = (source: string) => translateProfessional(source, locale)
  return { locale, tr }
}
const diffFieldLabels = ['名称', '文本内容', '位置 / 变换', '宽度', '高度', '填充', '描边', '效果', '不透明度', '字号', '文字样式', '子图层顺序', '所属容器 / 顺序', '图层', '页面', '页面顺序', '字体资源']
export function translateChangeKind(label: string, locale: InterfaceLocale) {
  if (locale !== 'en') return label
  if (label === '删除') return 'Deleted'
  return translateProfessional(label, locale)
}
export function translateDiffField(field: string, locale: InterfaceLocale) {
  if (locale !== 'en') return field
  const direct = catalogValue(field)
  if (direct !== undefined) return direct
  for (const label of diffFieldLabels) {
    if (field.startsWith(`${label}.`)) return `${translateProfessional(label, locale)}${field.slice(label.length)}`
  }
  return field
}
export function translateGeneratedDiffValue(field: string, value: string | undefined, locale: InterfaceLocale) {
  if (locale !== 'en' || value === undefined || field === '名称' || field.startsWith('文本')) return value
  if (value === '未设置' || value === '已设置' || value === '[资源内容已省略]' || value === '[资源内容]') return translateProfessional(value, locale)
  const items = /^(\d+) 项$/.exec(value)
  if (items && (field === '字体资源' || field === '子图层顺序')) return `${items[1]} items`
  return value
}
export function historyStorageIntro(name: string, desktop: boolean, locale: InterfaceLocale) {
  const where = desktop ? (locale === 'en' ? 'the local design library' : '本机文档库') : (locale === 'en' ? 'this browser' : '本机浏览器')
  return locale === 'en'
    ? `Versions of “${name}” are kept in ${where} and can be viewed offline. Restoring creates a new version and does not overwrite existing history.`
    : `「${name}」的历史版本保存在${where}，断网也可查看；恢复会创建新版本，不会覆盖现有历史。`
}
export function historyVersionLine(revision: number, summary: string | undefined, when: string, locale: InterfaceLocale) {
  const label = summary ?? translateProfessional('自动保存', locale)
  return locale === 'en' ? `Version ${revision} · ${label} · ${when}` : `版本 ${revision} · ${label} · ${when}`
}
export function revisionActionLabel(action: '预览版本' | '比较版本' | '恢复版本', revision: number, locale: InterfaceLocale) {
  if (locale !== 'en') return `${action} ${revision}`
  const verb = action === '预览版本' ? 'Preview version' : action === '比较版本' ? 'Compare version' : 'Restore version'
  return `${verb} ${revision}`
}
export function diffHeading(from: number, to: number, count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `Version ${from} → ${to} · ${count} ${count === 1 ? 'change' : 'changes'}` : `版本 ${from} → ${to} · ${count} 项变化`
}
export function confirmRestoreBody(revision: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `There are unsaved changes. Restoring version r${revision} discards them. Saved history is not affected.`
    : `当前有未保存的修改；恢复版本 r${revision} 会丢弃这些修改（已保存的历史不受影响）。`
}
export function readOnlyPreviewTitle(revision: number, name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Read-only preview · Version ${revision} · ${name}` : `只读预览 · 版本 ${revision} · ${name}`
}
export function previewPageLabel(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Preview page ${name}` : `预览页面 ${name}`
}
export function libraryVersionLine(revision: number, when: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Version ${revision} · ${when}` : `版本 ${revision} · ${when}`
}
export function libraryHistoryTitle(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `${name} · Version history` : `${name} · 历史版本`
}
export function batchRenameHelp(count: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `${count} selected layers · Numbered from top to bottom in the layer panel. Unselected children are not included.`
    : `${count} 个所选图层 · 按图层面板从上到下编号，不包含未选中的子图层。`
}
export function batchRenameOverflow(total: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `Showing the first 200. Apply renames all ${total} selected layers.`
    : `显示前 200 项；应用时将重命名全部 ${total} 个所选图层。`
}
export function batchRenameStatus(changed: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `${changed} ${changed === 1 ? 'name' : 'names'} will change in one undo step. Locked layers and layers inherited inside instances cannot be batch renamed.`
    : `${changed} 个名称将改变，可一次撤销。锁定图层及实例内部继承图层不可批量重命名。`
}
export function fillHeading(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `${name} · Fill 1` : `${name} · 填充 1`
}
export function saveStyleButton(kind: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Save ${kind} style` : `保存 ${kind} 样式`
}
export function interactionsHeading(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Interactions for ${name}` : `${name} 的交互`
}
export function libraryPublishedLine(name: string, version: number, count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${name} · v${version} · ${count} root ${count === 1 ? 'component' : 'components'}` : `${name} · v${version} · ${count} 个根组件`
}
export function logicActionLegend(index: number, locale: InterfaceLocale) {
  return locale === 'en' ? `Action ${index}` : `动作 ${index}`
}
export function prototypeTitle(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Prototype · ${name}` : `原型 · ${name}`
}
export function downloadAsset(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Download ${name}` : `下载 ${name}`
}
export function sketchLayerOption(depth: number, name: string, id: string, locale: InterfaceLocale) {
  const prefix = depth === 0 ? translateProfessional('页：', locale) : translateProfessional('层：', locale)
  const label = name || translateProfessional('(未命名)', locale)
  return `${prefix}${'·'.repeat(Math.min(depth, 8))}${label} [${id}]`
}
export function sketchPageOption(name: string, id: string, locale: InterfaceLocale) {
  return `${name || translateProfessional('(未命名页)', locale)} [${id}]`
}
export function sketchPageSummary(pages: number, layers: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${pages} ${pages === 1 ? 'page' : 'pages'} · ${layers} layers (including pages)` : `${pages} 页 · ${layers} 个图层（含页面）`
}
export function sketchViewportDescription(firstPage: boolean, pageName: string, pageId: string, pageCount: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `Only ${firstPage ? 'the first page' : 'the selected page'} “${pageName}” (${pageId}), ${pageCount} pages total. Viewport origin (0, 0), 512 × 384, document coordinates 1:1. Content outside the viewport is hidden and the page is not scaled to fit.`
    : `仅${firstPage ? '首页' : '选中页'}「${pageName}」（${pageId}），共 ${pageCount} 页。视口原点 (0, 0)，512 × 384，文档坐标 1:1；视口外内容不显示，未缩放适配整页。`
}
export function sketchSessionLine(name: string, revision: number, state: string, undo: number, redo: number, locale: InterfaceLocale) {
  return `${name} · revision ${revision} · ${translateProfessional(state, locale)} · undo ${undo} / redo ${redo}`
}
export function fontReplacementSummary(count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `Font substitutions (${count})` : `字体替换记录（${count}）`
}
export function utf16Count(count: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `${count} / 100000 UTF-16 code units (most emoji count as 2). Spaces and line breaks are kept as entered.`
    : `${count} / 100000 UTF-16 单元（多数 emoji 计 2 单元）。原样保留空格与换行。`
}
export function explicitOverrideLine(label: '本实例显式覆盖' | '主组件源文本', value: string | null, locale: InterfaceLocale) {
  const empty = value === null ? (label === '本实例显式覆盖' ? '未设置' : '未提供') : value === '' ? '空字符串' : null
  const shown = empty === null ? value! : translateProfessional(empty, locale)
  if (locale !== 'en') return `${label}：${empty === null ? value : empty}`
  const title = label === '本实例显式覆盖' ? 'Explicit override on this instance' : 'Main component source text'
  return `${title}: ${shown}`
}
export function variableQualifiedLabel(name: string, mode: string, suffix: '' | '值类型' | '搜索别名' | '别名', locale: InterfaceLocale) {
  if (locale !== 'en') return suffix ? `${name} ${mode} ${suffix}` : `${name} ${mode}`
  const detail = suffix === '值类型' ? 'value type' : suffix === '搜索别名' ? 'alias search' : suffix === '别名' ? 'alias' : ''
  return detail ? `${name} ${mode} ${detail}` : `${name} ${mode}`
}
export function renameModeLabel(mode: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Rename mode ${mode}` : `重命名模式 ${mode}`
}
export function deleteModeLabel(mode: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Delete mode ${mode}` : `删除模式 ${mode}`
}
export function deleteVariableLabel(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Delete variable ${name}` : `删除变量 ${name}`
}
export function collectionModeLabel(name: string, which: '当前模式' | '默认模式', locale: InterfaceLocale) {
  return locale === 'en' ? `${name} ${which === '当前模式' ? 'current mode' : 'default mode'}` : `${name} ${which}`
}
export function copyModeOption(mode: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Copy ${mode}` : `复制 ${mode}`
}
export function layerModeLabel(name: string, locale: InterfaceLocale) {
  return locale === 'en' ? `${name} layer mode` : `${name} 图层局部模式`
}
export function variableCountStatus(filtered: number, total: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${filtered} / ${total} variables` : `${filtered} / ${total} 个变量`
}
export function modePageStatus(start: number, end: number, total: number, locale: InterfaceLocale) {
  return locale === 'en' ? `Modes ${start}–${end} / ${total}` : `模式 ${start}–${end} / ${total}`
}
export function modeCapacity(count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${count}/32 modes` : `${count}/32 模式`
}
export function variablePageStatus(shown: string, total: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${shown} / ${total} variables` : `${shown} / ${total} 个变量`
}
export function removalTitle(blocked: boolean, name: string, locale: InterfaceLocale) {
  const verb = blocked ? translateProfessional('暂不能删除', locale) : translateProfessional('确认删除', locale)
  return locale === 'en' ? `${verb} “${name}”` : `${verb}「${name}」`
}
export function removalReferences(count: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `Still referenced in ${count} ${count === 1 ? 'place' : 'places'}. Change those references and try again. Bindings are not removed automatically.`
    : `仍有 ${count} 处引用。请先修改以下引用，再重试；不会自动解除绑定或删除依赖。`
}
export function removalMore(count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `${count} more ${count === 1 ? 'reference' : 'references'}.` : `另有 ${count} 处引用。`
}
export function bindingHeading(count: number, name: string, locale: InterfaceLocale) {
  const who = count > 1 ? (locale === 'en' ? `${count} layers` : `${count} 个图层`) : name
  return locale === 'en' ? `${who} · Local modes and bindings` : `${who} · 局部模式与绑定`
}
export function leaveBody(name: string, reason: string, locale: InterfaceLocale) {
  return locale === 'en'
    ? `“${name}” has changes that are not saved to a file. You can save before ${reason === 'close' ? 'closing the window' : 'leaving this design'}.`
    : `「${name}」有未保存到文件的修改。${reason === 'close' ? '关闭窗口' : '离开当前设计'}前可以先保存。`
}
export function localWindowTitle(count: number, locale: InterfaceLocale) {
  return locale === 'en' ? `Local windows: ${count}` : `本机窗口：${count}`
}
export function followLabel(name: string, following: boolean, locale: InterfaceLocale) {
  return `${name} · ${translateProfessional(following ? '停止跟随' : '跟随视图', locale)}`
}
export function localLinkStatus(message: string, locale: InterfaceLocale) {
  return locale === 'en' ? `Local windows: ${translateProfessional(message, locale)}` : `本机联动：${message}`
}
export function shapeRegionLabel(id: string, locale: InterfaceLocale) { return locale === 'en' ? `Region ${id}` : `区域 ${id}` }
export function shapeSelectionSummary(selected: number, total: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `${selected} / ${total} regions selected. Other regions are kept; new vectors use the solid fill of each region's topmost source.`
    : `${selected} / ${total} 个区域已选。保留其余区域；新矢量使用各区域最上层来源的纯色填充。`
}
