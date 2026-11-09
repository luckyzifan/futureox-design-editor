import type { InterfaceLocale } from './interface-preference'
/** Tool routes shared by command dispatch and the Rust-backed shortcut table.
 * A mapping proves dispatch only;
 * behavior, persistence and fidelity require the per-tool desktop tests. */
export type ToolCommand = {
  id: string
  label: string
  category: 'core' | 'shape' | 'vector' | 'whiteboard' | 'figjam' | 'utility' | 'ai'
  /** Editor Tool this command activates; absent when unimplemented. */
  tool?: string
  shortcut?: string
}

export const TOOL_COMMANDS: ToolCommand[] = [
  { id: 'set-tool-default', label: '移动', category: 'core', tool: 'select', shortcut: 'V' },
  { id: 'set-tool-default', label: '移动 (FigJam)', category: 'figjam', tool: 'select' },
  { id: 'set-tool-hand', label: '抓手', category: 'core', tool: 'hand', shortcut: 'H' },
  { id: 'set-tool-zoom', label: '区域缩放', category: 'core', tool: 'zoom', shortcut: 'Z' },
  { id: 'set-tool-frame', label: '画板', category: 'core', tool: 'frame', shortcut: 'F' },
  { id: 'set-tool-section', label: '分区', category: 'core', tool: 'section', shortcut: 'Shift+S' },
  { id: 'set-tool-rectangle', label: '矩形', category: 'shape', tool: 'rectangle', shortcut: 'R' },
  { id: 'set-tool-ellipse', label: '椭圆', category: 'shape', tool: 'ellipse', shortcut: 'O' },
  { id: 'set-tool-regular-polygon', label: '多边形', category: 'shape', tool: 'polygon' },
  { id: 'set-tool-star', label: '星形', category: 'shape', tool: 'star' },
  { id: 'set-tool-line', label: '直线', category: 'shape', tool: 'line', shortcut: 'L' },
  { id: 'set-tool-arrow', label: '箭头', category: 'shape', tool: 'arrow' },
  { id: 'set-tool-text', label: '文本', category: 'core', tool: 'text', shortcut: 'T' },
  { id: 'set-tool-pen', label: '钢笔', category: 'vector', tool: 'pen', shortcut: 'P' },
  { id: 'set-tool-pencil', label: '铅笔', category: 'vector', tool: 'pencil', shortcut: 'N' },
  { id: 'set-tool-brush', label: '画笔', category: 'vector', tool: 'brush', shortcut: 'B' },
  { id: 'set-tool-marker', label: '马克笔', category: 'vector', tool: 'marker' },
  { id: 'set-tool-eraser', tool: 'eraser', label: '橡皮', category: 'utility', shortcut: 'E' },
  { id: 'set-tool-scale', label: '缩放', category: 'utility', tool: 'scale', shortcut: 'K' },
  { id: 'set-tool-slice', label: '切片', category: 'utility', tool: 'slice', shortcut:'S' },
  { id: 'set-tool-comments', tool: 'comments', label: '评论', category: 'utility', shortcut: 'C' },
  { id: 'set-tool-measure', tool: 'measure', label: '测量', category: 'utility' },
  { id: 'set-tool-annotate', tool: 'annotate', label: '标注', category: 'utility' },
  { id: 'set-tool-multiselect', tool:'multiselect', label: '多选', category: 'utility' },
  { id: 'set-tool-paint-bucket', tool:'paint-bucket', label: '油漆桶', category: 'utility' },
  { id: 'set-tool-eyedropper', tool: 'eyedropper', label: '吸管', category: 'utility', shortcut: 'I' },
  { id: 'set-tool-cut', tool: 'cut', label: '裁切', category: 'utility' },
  { id: 'set-tool-type', tool:'text', label: '输入', category: 'figjam' },
  { id: 'set-tool-sticky', tool:'sticky', label: '便签', category: 'figjam' },
  { id: 'set-tool-table', tool:'table', label: '表格', category: 'figjam' },
  { id: 'set-tool-code-block', tool:'code-block', label: '代码块', category: 'figjam' },
  { id: 'set-tool-connector-straight', tool:'connector-straight', label: '直线连接器', category: 'figjam' },
  { id: 'set-tool-connector-elbowed', tool:'connector-elbowed', label: '折线连接器', category: 'figjam' },
  { id: 'set-tool-washi-tape', tool:'washi-tape', label: '和纸胶带', category: 'figjam' },
  { id: 'set-tool-shape-whiteboard-square', tool:'shape-whiteboard-square', label: '白板矩形', category: 'whiteboard' },
  { id: 'set-tool-shape-whiteboard-ellipse', tool:'shape-whiteboard-ellipse', label: '白板椭圆', category: 'whiteboard' },
  { id: 'set-tool-shape-whiteboard-rounded-rectangle', tool:'shape-whiteboard-rounded-rectangle', label: '白板圆角矩形', category: 'whiteboard' },
  { id: 'set-tool-shape-whiteboard-triangle-up', tool:'shape-whiteboard-triangle-up', label: '白板上三角', category: 'whiteboard' },
  { id: 'set-tool-shape-whiteboard-triangle-down', tool:'shape-whiteboard-triangle-down', label: '白板下三角', category: 'whiteboard' },
  { id: 'set-tool-shape-whiteboard-diamond', tool:'shape-whiteboard-diamond', label: '白板菱形', category: 'whiteboard' },
  { id: 'set-tool-vector-lasso', tool: 'vector-lasso', label: '套索', category: 'vector' },
  { id: 'set-tool-offset-path', tool:'offset-path', label: '偏移路径', category: 'vector' },
  { id: 'set-tool-bend', tool: 'bend', label: '弯折', category: 'vector' },
  { id: 'set-tool-text-path', tool:'text-path', label: '路径文本', category: 'vector' },
  { id: 'set-tool-sites-responsive-set', tool:'sites-responsive-set', label: '响应式套件', category: 'utility' },
  { id: 'set-tool-annotate', tool: 'annotate', label: '标注 (FigJam)', category: 'figjam' },
]

/** Commands with a mapped native tool. */
export const MAPPED_TOOL_COMMANDS = TOOL_COMMANDS.filter((c) => c.tool)

/** Dispatch a set-tool command id; returns the tool to activate or null. */
export function toolForCommand(commandId: string): string | null {
  return TOOL_COMMANDS.find((c) => c.id === commandId)?.tool ?? null
}

/** Why a decoded command has no tool yet; surfaces stay explicit, never inert. */
export function unavailableReason(commandId: string, locale: InterfaceLocale = 'zh-CN'): string | null {
  const entry = TOOL_COMMANDS.find((c) => c.id === commandId)
  if (!entry || entry.tool) return null
  if (locale === 'en') {
    if (entry.id === 'set-tool-multiselect') return 'Multi-select is available with Shift-click and marquee selection'
    if (entry.id === 'set-tool-annotate') return 'Annotation collaboration is not connected yet'
    if (entry.id === 'set-tool-sites-responsive-set') return 'Responsive sets require site publishing, which is not connected yet'
    if (entry.category === 'vector') return 'The required vector editing capability is not implemented yet'
    if (entry.category === 'figjam' || entry.category === 'whiteboard') return 'FigJam / whiteboard infrastructure is not connected'
    return 'This command is not implemented yet'
  }
  if (entry.id === 'set-tool-multiselect') return '多选已通过 Shift 点击与框选提供'
  if (entry.id === 'set-tool-annotate') return '标注需要评论协作设施，暂未接入'
  if (entry.id === 'set-tool-sites-responsive-set') return '响应式套件需要站点发布设施，暂未接入'
  if (entry.category === 'vector') return '需要对应的矢量编辑内核能力，暂未实现'
  if (entry.category === 'figjam' || entry.category === 'whiteboard') return 'FigJam / 白板设施未接入本产品'
  return '该命令尚未实现'
}

/** Explicit presentation lookup, independent of command/shortcut dispatch and authored node names. */
const englishToolLabels: Readonly<Record<string, string>> = {
  'set-tool-default': 'Move', 'set-tool-hand': 'Hand', 'set-tool-zoom': 'Zoom area', 'set-tool-frame': 'Frame',
  'set-tool-section': 'Section', 'set-tool-rectangle': 'Rectangle', 'set-tool-ellipse': 'Ellipse',
  'set-tool-regular-polygon': 'Polygon', 'set-tool-star': 'Star', 'set-tool-line': 'Line', 'set-tool-arrow': 'Arrow',
  'set-tool-text': 'Text', 'set-tool-pen': 'Pen', 'set-tool-pencil': 'Pencil', 'set-tool-brush': 'Brush',
  'set-tool-marker': 'Marker', 'set-tool-eraser': 'Eraser', 'set-tool-scale': 'Scale', 'set-tool-slice': 'Slice',
  'set-tool-comments': 'Comments', 'set-tool-measure': 'Measure', 'set-tool-annotate': 'Annotate',
  'set-tool-multiselect': 'Multi-select', 'set-tool-paint-bucket': 'Paint bucket', 'set-tool-eyedropper': 'Eyedropper',
  'set-tool-cut': 'Cut', 'set-tool-type': 'Type', 'set-tool-sticky': 'Sticky note', 'set-tool-table': 'Table',
  'set-tool-code-block': 'Code block', 'set-tool-connector-straight': 'Straight connector',
  'set-tool-connector-elbowed': 'Elbow connector', 'set-tool-washi-tape': 'Washi tape',
  'set-tool-shape-whiteboard-square': 'Whiteboard rectangle', 'set-tool-shape-whiteboard-ellipse': 'Whiteboard ellipse',
  'set-tool-shape-whiteboard-rounded-rectangle': 'Whiteboard rounded rectangle',
  'set-tool-shape-whiteboard-triangle-up': 'Whiteboard up triangle', 'set-tool-shape-whiteboard-triangle-down': 'Whiteboard down triangle',
  'set-tool-shape-whiteboard-diamond': 'Whiteboard diamond', 'set-tool-vector-lasso': 'Lasso',
  'set-tool-offset-path': 'Offset path', 'set-tool-bend': 'Bend', 'set-tool-text-path': 'Text on path',
  'set-tool-sites-responsive-set': 'Responsive set',
}
export function localizedToolCommands(locale: InterfaceLocale): ToolCommand[] {
  return TOOL_COMMANDS.map(entry => ({ ...entry, label: locale === 'en'
    ? (englishToolLabels[entry.id] ?? entry.id) + (entry.category === 'figjam' && ['set-tool-default', 'set-tool-annotate'].includes(entry.id) ? ' (FigJam)' : '')
    : entry.label }))
}
export function localizedToolLabel(tool: string, locale: InterfaceLocale, fallback?: string): string {
  const entry = TOOL_COMMANDS.find(command => command.tool === tool)
  // Crop is an editor utility, not a registered set-tool command. Do not invent one.
  if (tool === 'crop') return locale === 'en' ? 'Crop' : fallback ?? '裁切'
  if (locale === 'zh-CN') return fallback ?? entry?.label ?? tool
  return entry ? englishToolLabels[entry.id] ?? tool : tool
}
