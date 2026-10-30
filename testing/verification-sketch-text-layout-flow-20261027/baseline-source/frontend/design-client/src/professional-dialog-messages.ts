import { useInterfacePreferences, type InterfaceLocale } from './interface-preference'
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
const enText = (source: string) => Object.prototype.hasOwnProperty.call(english, source) ? english[source] : source
const zhText = (source: string) => source
export function useProfessionalDialogText() {
  const { locale } = useInterfacePreferences()
  return { locale, tr: locale === 'en' ? enText : zhText }
}
export function shapeRegionLabel(id: string, locale: InterfaceLocale) { return locale === 'en' ? `Region ${id}` : `区域 ${id}` }
export function shapeSelectionSummary(selected: number, total: number, locale: InterfaceLocale) {
  return locale === 'en'
    ? `${selected} / ${total} regions selected. Other regions are kept; new vectors use the solid fill of each region's topmost source.`
    : `${selected} / ${total} 个区域已选。保留其余区域；新矢量使用各区域最上层来源的纯色填充。`
}
