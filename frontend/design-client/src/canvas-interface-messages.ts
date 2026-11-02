import type { InterfaceLocale } from './interface-preference'
/** UI presentation only; identifiers, authored names and history labels stay unchanged. */
const phrases = {
  devicePresets: ['设备与尺寸预设…', 'Device and size presets…'], editVector: ['编辑矢量', 'Edit vector'],
  menu: ['画布右键菜单', 'Canvas context menu'], selectLayer: ['选择图层', 'Select layer'], moveToPage: ['移动到页面', 'Move to page'],
  copyAs: ['复制／粘贴为', 'Copy / paste as'], selectSame: ['选择相同', 'Select matching'], editText: ['编辑文字', 'Edit text'], lockedSuffix: ['（已锁定）', ' (locked)'],
  designTools: ['设计工具', 'Design tools'], workspaceNavigation: ['工作区导航', 'Workspace navigation'],
  localDesignFiles: ['本机设计文件', 'Local design files'], files: ['文件', 'Files'], pagesAndLayers: ['页面与图层', 'Pages and layers'], layers: ['图层', 'Layers'],
  componentsAndAssets: ['组件与资源', 'Components and assets'], assets: ['资源', 'Assets'], tools: ['工具', 'Tools'], localDesignVariables: ['本地设计变量', 'Local design variables'], variables: ['变量', 'Variables'],
  moveTools: ['移动工具', 'Move tools'], regionTools: ['区域工具', 'Region tools'], shapeTools: ['形状工具', 'Shape tools'], drawingTools: ['绘图工具', 'Drawing tools'], utilityTools: ['实用工具', 'Utility tools'], arrangeAndEdit: ['排列与编辑', 'Arrange and edit'],
  decodedUnavailable: ['已解码但尚未提供', 'Decoded but not available'], unavailable: ['未提供', 'Unavailable'], whiteboardAndResponsive: ['白板与响应式', 'Whiteboard and responsive'], alignAndDistribute: ['对齐与分布', 'Align and distribute'], combineShapes: ['组合形状', 'Combine shapes'],
  undo: ['撤销', 'Undo'], redo: ['重做', 'Redo'], alignLeft: ['左对齐', 'Align left'], alignCenter: ['水平居中', 'Align horizontal centers'], alignRight: ['右对齐', 'Align right'], alignTop: ['顶部对齐', 'Align top'], alignMiddle: ['垂直居中', 'Align vertical centers'], alignBottom: ['底部对齐', 'Align bottom'], distributeHorizontal: ['水平等距', 'Distribute horizontally'], distributeVertical: ['垂直等距', 'Distribute vertically'],
  union: ['联合', 'Union'], subtract: ['减去顶层', 'Subtract top layer'], intersect: ['交集', 'Intersect'], exclude: ['排除交集', 'Exclude overlap'], divideLegacy: ['分割为多边形区域（旧版）', 'Divide into polygon regions (legacy)'], shapeBuilder: ['形状构建器…', 'Shape builder…'], maskGroup: ['蒙版组', 'Mask group'], group: ['编组', 'Group'], ungroup: ['解除编组', 'Ungroup'], designSystems: ['变量 · 组件库 · 原型', 'Variables · Libraries · Prototypes'], outlineStroke: ['轮廓化描边', 'Outline stroke'],
  creationHint: ['拖拽绘制 · 单击默认尺寸 · Shift 约束比例 · Alt 从中心', 'Drag to draw · Click for the default size · Shift constrains · Alt from center'],
  creationHintLine: ['拖拽绘制 · 单击为 100 长 · Shift 锁定角度 · Alt 从中心', 'Drag to draw · Click for length 100 · Shift locks the angle · Alt from center'],
  penHint: ['点击添加节点，拖动创建曲线；点击已有节点可连接分支。', 'Click to add points, drag to curve; click an existing point to join a branch.'],
  penDone: ['完成 ↵', 'Done ↵'],
  rotateOrigin: ['拖动旋转中心 · 双击复位 · ⌥R 显示/隐藏', 'Drag the rotation origin · Double-click to reset · ⌥R show/hide'],
  arcStart: ['拖动调整圆弧起始角', 'Drag to change the arc start'],
  arcSweep: ['拖动调整圆弧扫过角', 'Drag to change the arc sweep'],
  arcInner: ['拖动调整圆环内径', 'Drag to change the inner radius'],
  cornerRadiusHandle: ['拖动调整顶点圆角', 'Drag to change the corner radius'],
  vertexCount: ['拖动调整顶点数量', 'Drag to change the point count'],
  starInner: ['拖动调整星形内半径', 'Drag to change the star inner radius'],
} as const
const catalog = (column: 0 | 1) => Object.fromEntries(Object.entries(phrases).map(([key, pair]) => [key, pair[column]])) as { readonly [K in keyof typeof phrases]: string }
export const canvasText = { 'zh-CN': catalog(0), en: catalog(1) } as const

/** Explicit command keys, not string replacement of labels or document data. */
export const canvasCommandEnglish: Readonly<Record<string, string>> = {
  undo: 'Undo', redo: 'Redo', 'paste-over-selection': 'Paste over selection (keep targets)', 'paste-to-replace': 'Paste to replace',
  'copy-properties': 'Copy properties', 'paste-properties': 'Paste properties', 'copy-fills': 'Copy fills', 'copy-strokes': 'Copy strokes', 'copy-effects': 'Copy effects',
  'copy-as-png': 'Copy as PNG', 'copy-as-svg': 'Copy as SVG', copy: 'Copy', cut: 'Cut', 'paste-here': 'Paste here', 'paste-in-place': 'Paste in place',
  'select-matching': 'Select matching layers', 'select-properties': 'Select same properties', 'select-fill': 'Select same fill', 'select-stroke': 'Select same stroke', 'select-effect': 'Select same effects', 'select-text': 'Select same text properties', 'select-font': 'Select same font', 'select-instance': 'Select instances of the same component', 'select-inverse': 'Invert selection',
  rename: 'Rename', duplicate: 'Duplicate', 'flip-horizontal': 'Flip horizontal', 'flip-vertical': 'Flip vertical',
  'bring-to-front': 'Bring to front', 'bring-forward': 'Bring forward', 'send-backward': 'Send backward', 'send-to-back': 'Send to back',
  group: 'Group', 'frame-selection': 'Frame selection', 'create-component': 'Create component', 'detach-instance': 'Detach instance', 'mask-selection': 'Use as mask',
  'auto-layout': 'Add auto layout', 'remove-auto-layout': 'Remove auto layout', 'convert-section': 'Convert to section', ungroup: 'Ungroup', 'convert-vector': 'Convert to vector', 'outline-stroke': 'Outline stroke',
  'unlock-selection': 'Unlock layers', 'lock-selection': 'Lock layers', 'hide-selection': 'Hide layers', 'show-selection': 'Show layers', 'zoom-selection': 'Zoom to selection', 'center-selection': 'Center selection (keep zoom)', delete: 'Delete', 'select-all': 'Select all', 'zoom-fit': 'Zoom to all content',
}
export function canvasCommandLabel(command: string, chinese: string, locale: InterfaceLocale, multiple: boolean, lockedParent: boolean) {
  if (locale !== 'en') return chinese
  if (command === 'rename' && multiple) return 'Batch rename…'
  if (command === 'unlock-selection' && lockedParent) return 'Unlock layers and ancestors'
  return canvasCommandEnglish[command] ?? chinese
}
