# 本地画布流程逐项对照：Figma / Sketch

核对日期：2026-10-19（UTC）。源码为 `71d3215` 基线上的当前工作区；不是该提交自身具备以下全部改动。范围限本地画布、键盘、图层、文字、组件和导出，不含账号、云协作或发布。

## 结论与证据分级

已经存在的基础能力很多，但**本项目尚未达到 Figma / Sketch 全部操作一比一等价**。本表把可定位的产品入口、实现和测试与具体官方操作对应，避免将“有一个工具名”算作流程完成。Figma-like / Sketch-like 是本地快捷键预设；两者没有把整个编辑器的鼠标与布局语义替换成对应产品。

- **代码+测试**：有实现和相关自动化测试；仅表示表内列出的行为。
- **部分**：有入口或基础能力，但官方操作的某个条件、修饰键或后续流程有差距。
- **缺口**：当前源码未找到对应完整闭环。
- **待设备验证**：本次未运行真实浏览器/Electron GUI、Windows/macOS 键盘、触控板或 GPU。本文所有行都带此限制；不得把 jsdom 或 CPU/WASM 测试称为 GUI 验收。

下表的路径省略 `frontend/design-client/src/`。测试列是可复现的证据入口，不代表本次全部重新执行。实际执行清单与结果见末节。官方来源编号均链接到文末的原始页面，读取日期统一为 2026-10-19。

## 1. 选择、层级与键盘导航

| ID | 官方操作或预期 | 当前产品入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| SEL-01 | Figma / Sketch：点选、父容器优先、逐层深入 [F1] [S2] [S3] | Canvas 点击/双击 → `Editor.hit/selectDeeper`；`selection-hierarchy.ts` | 代码+测试；未宣称复杂蒙版/透明像素在所有平台等价 | `selection-hierarchy.test.ts`、`canvas-selection-cpu.test.tsx` |
| SEL-02 | Cmd/Ctrl 点选深层对象 [F1] [S2] | `Canvas.tsx` 的 deep hit 与 `interactivePath` | 代码+测试；Mac Ctrl+点击按系统上下文菜单处理，Cmd 才是主深选修饰键 | `selection-hierarchy.test.ts` |
| SEL-03 | Shift 点击加选/取消 [F1] [S2] | `selectionPointerDown`、`layerSelection` | 代码+测试；框选的加选/反选是另一条路径 | `canvas-selection-cpu.test.tsx`、`canvas-layer-feedback.test.ts` |
| SEL-04 | 空白区域拖框选；Cmd/Ctrl 深层框选 [F1] [S2] | `Canvas.tsx` release 分支；`marqueeScope` + 空间索引候选 | 代码+测试；当前按相交选择，继承隐藏/锁定过滤 | `canvas-selection-cpu.test.tsx`、`selection-hierarchy.test.ts` |
| SEL-05 | Sketch X：允许从已有背景内容上开始框选 [S2] | `Canvas.tsx` + `canvas-selection-workflows.ts`；移除旧 X 永久选择工具绑定 | 本轮补齐按住 X 临时深层框选，穿过选择手柄并排除起点命中及祖先；tap-X 持续模式仍缺口 | `canvas-selection-workflows.test.tsx` 实际挂载 Canvas/WASM |
| SEL-06 | Sketch Option 框选仅包含完全在框内的层；Cmd+Shift 框选切换成员 [S2] | 同一 Canvas release 路径按预设判定包含和 XOR | 本轮补齐有界世界 AABB 完全包含、Shift 异或与主修饰键深层选择；不是像素覆盖测试 | `canvas-selection-workflows.test.tsx`，含旋转、反向拖动、平移缩放 |
| SEL-07 | Enter 进入容器，Tab/Shift+Tab 切兄弟 [F2] [S1] [S10] | `Canvas.tsx` → `navigateSelection` | 代码+测试；Tab 只在画布拥有焦点且有选区时接管 | `selection-hierarchy.test.ts` |
| SEL-08 | Sketch Esc 返回父容器，Ctrl+Esc 清选区 [S1] [S10] | Sketch-like 空闲 Escape → `navigateSelection(parent)`；交互取消优先 | 本轮补齐父级返回，顶层清选；Ctrl+Esc 专用组合尚未对齐；Figma Escape 原行为保留 | `canvas-selection-workflows.test.tsx`、`selection-hierarchy.test.ts` |
| SEL-09 | Figma Ctrl/Cmd+A 全选；官方页面未细化所有嵌套情形 [F1] | 新 `selectAllCanvasIds`，Figma-like 保留页级直属对象策略 | 部分：仅修复隐藏/锁定排除；页级策略是保留的本地行为，不是已证明的 Figma 完整语义 | `canvas-workflow-shortcuts.test.ts` |
| SEL-10 | Sketch 当前容器内全选、通常排除隐藏/锁定 [S1] [S2] | 新 helper 使用共同已进入容器；共享命令读取当前预设 | 本轮补齐有界流程：直属兄弟；空选区/跨顶层容器回退当前页；键盘、菜单使用同一策略 | `canvas-workflow-shortcuts.test.ts` |
| SEL-11 | Sketch 强制全选含隐藏/锁定；只选顶层 frame/graphic [S1] | 未有独立命令；Shift+Mod+A 仍是本地反选 | 缺口：不能把反选称为 Sketch 顶层容器全选 | `shortcut-profiles.test.ts` 只证明本地绑定 |
| SEL-12 | 锁定层不被普通画布点击；图层列表仍可显式选择 [F1] [S10] | `interactivePath`、`Layers.tsx`、`CanvasContextMenu.tsx` | 代码+测试；属性面板允许显式层列表选择的锁定对象编辑，画布修改有锁保护 | `selection-hierarchy.test.ts`、`multiselection-cpu-runtime.test.tsx` |
| SEL-13 | 图层列表范围选择、非连续选择、展开与定位 [F1] [S10] | `Layers.tsx`、`layer-selection.ts`、`layer-tree.ts` | 代码+测试；完整 Sketch focus mode/快捷键搜索未对齐 | `canvas-layer-feedback.test.ts`、`layer-drop.test.ts` |
| SEL-14 | Figma 键盘 box/pick selection、工具 Enter 插入 [F2] | 当前 Enter 用于深入、文字/矢量编辑或结束钢笔 | 缺口：无键盘选框游标、选择模式切换、无指针插入完整路径 | 无对应正向测试 |

## 2. 平移、缩放与视图

| ID | 官方操作或预期 | 当前入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| NAV-01 | 空格拖动平移；无选区方向键平移 [F2] [S4] | Canvas Space/H、方向键；`canvas-camera.ts` | 代码+测试；方向键平移为本地 CSS 像素步长 20/100 | `canvas-camera.test.ts`、`canvas-selection-cpu.test.tsx` |
| NAV-02 | 主修饰键+滚轮、触控板捏合 [F3] [S4] | Canvas wheel → navigation zoom；有锚点保持与延迟视图提交 | 代码+测试；设备滚轮增量/OS 手势未实测 | `kernel/navigation-zoom.test.ts`、`kernel/use-navigation-zoom.test.ts` |
| NAV-03 | 100%、适合全部、适合选区 [F3] [S4] | ViewControls、`dispatchEditorCommand` → `fitBounds/zoomAt` | 代码+测试；Figma Shift+0/1/2；Sketch 桌面 Mod+0/1/2；浏览器保留这些宿主按键 | `shortcut-profiles.test.ts` |
| NAV-04 | Sketch Cmd+3 居中选区，保持倍率 [S4] | 新 `center-selection`，先落地 pending view 再保留 zoom 居中；菜单两种宿主均可用 | 本轮补齐：仅 Sketch-like 桌面绑定 Mod+3；浏览器保留标签页键。空/隐藏/失效/异页选区不动，锁定但可见层可居中 | `canvas-selection-workflows.test.tsx` 实际 Canvas，三平台策略参数 |
| NAV-05 | Sketch Z 点击/Option 点击/拖框缩放 [S4] | `Canvas.tsx` zoom 工具与 release 分支 | 代码+测试；范围限制仍为本地 2.5%–3200%，不称无限缩放等价 | `canvas-camera.test.ts`、画布工具脚本 |
| NAV-06 | 像素预览、像素网格、布局辅助显示 [F3] [S4] | ViewControls、`pixel-grid.ts`、`grid-overlay.ts` | 部分：功能存在，Sketch Ctrl+X/Ctrl+R/Ctrl+L 等尚未逐项预设化；不以像素网格证明 GPU 色彩输出 | `pixel-grid.test.ts`、`layout-grid-overlay.test.ts` |
| NAV-07 | Sketch 小地图/缩略导航 [S14] | 已按用户要求移除 CanvasMinimap 及入口 | **用户有意移除，排除本次范围**；不是等待重做的缺口。现有平移/缩放/滚动条仍保留 | `canvas-minimap-removal.test.tsx`；另组移除验收记录 |

## 3. 建立容器、几何变换和排列

| ID | 官方操作或预期 | 当前入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| GEO-01 | Frame 工具、框选建画板、选区转 frame [F4] [S1] | Toolbar F、`shape-creation.ts`、frame-selection → `Editor.group(...,'frame')` | 代码+测试；Sketch 桌面 Cmd+F，Figma Mod+Alt+G；浏览器 Cmd/Ctrl+F 保留搜索 | `shape-creation.test.ts`、`shortcut-profiles.test.ts` |
| GEO-02 | Group / Ungroup [S3] | 菜单与 Mod+G/Mod+Shift+G → Editor | 代码+测试；实例/组件容器受保护，不等于任意容器均可解组 | `shortcut-profiles.test.ts`、`layout-order.test.ts` |
| GEO-03 | Figma frame quick-add 邻接复制/空白同尺寸 frame [F4] | 没有 frame 边缘加号及邻居让位操作 | 缺口；普通 Duplicate 不代表 quick-add 流程 | 无对应正向测试 |
| GEO-04 | 拖边/角改尺寸、Shift 比例、Option/Alt 中心缩放 [F5] [S5] | Canvas resize/scale 分支、`selection-handles.ts`、`resizedNode` | 代码+测试；旋转/父级坐标与文本 resize/scale 分开；真实鼠标手柄待验收 | `selection-handles.test.ts`、`selection-scale.test.ts`、`selection-properties.test.ts` |
| GEO-05 | Sketch Cmd+方向键改尺寸，Shift 大步长 [S5] | 新尺寸命令 → `nudgeSelectionDimensions` → 同一 `resizeNodeDimension` | 本轮补齐 1/10 的本地有界流程。逐层尺寸调整、比例锁、正尺寸范围 .01–1e6；不是整个多选框缩放。仅选择/缩放工具，文本/矢量编辑模式不接管 | `canvas-workflow-shortcuts.test.ts` |
| GEO-06 | Sketch Cmd+Option+方向键只改容器不改内容 [S1] | 未建立独立 resize-without-contents 模式 | 缺口；本轮基础尺寸微调不含此修饰键变体 | 新测试验证额外 Alt 不触发基础命令 |
| GEO-07 | 旋转手柄，Shift 15°，翻转 [F5] [S5] | `selectionRotation`、Canvas rotate、共享 flip 命令 | 代码+测试；不同选区/变换原点的官方所有规则仍未独立比对 | `selection-handles.test.ts`、`selection-scale.test.ts` |
| GEO-08 | 方向键位置微移；自定义小/大步长 [F6] [S5] | Canvas 固定 1/10；无可持久化 nudge 设置 | 部分；默认步长有实现，自定义值缺口。新尺寸微调也固定 1/10 | `canvas-selection-cpu.test.tsx`、`canvas-workflow-shortcuts.test.ts` |
| GEO-09 | 多选按边界对齐、单选对父容器对齐 [F5] [S6] | `AlignmentControls.tsx` → `Editor.align`；`align-engine.ts` | 代码+测试；自动布局流式对象另有约束，不宣称任意父级都可直接改位置 | `align-engine.test.ts` |
| GEO-10 | Sketch 参考图层对齐、Option 对顶层 frame 对齐、悬停预览 [S6] | 对齐按钮无 reference-key-layer 状态及 Option 分支 | 缺口；不能把已有六个按钮算作此流程通过 | 无对应正向测试 |
| GEO-11 | 水平/垂直等间距、整理、智能间距重排 [F7] [S6] | `AlignmentControls`、`CanvasSmartSelection`、`smart-selection.ts` | 代码+测试基础；智能选择完整增删/resize 后自动重排未闭环 | `align-engine.test.ts`、`smart-selection.test.ts` |
| GEO-12 | 移动轴限制、禁用吸附、Alt 拖复制、Space 保留父级 [S7] | Canvas Shift/Ctrl/Alt/Space、`finishCanvasMove` | 代码+测试；Sketch Cmd+Option 任意位置拖动已选对象尚未对应 | `native-duplication.test.ts`、`layout-order.test.ts` |
| GEO-13 | 拖动吸附到边/中心/间距、手动参考线 [F5] [S4] | `alignSnapWorld`、`canvas-smart-guides.ts`、ruler guide 数据 | 代码+测试；不推断吸附优先级与两款原生产品逐像素相同 | `canvas-smart-guides.test.ts`、`ruler-guides.test.ts` |
| GEO-14 | 加/移除自动布局；Sketch stack [F8] [S1] | Figma Shift+A / 新 Alt+Shift+A；Sketch Shift+S / Alt+Shift+S | 本轮修复 Figma 移除绑定。Sketch 只映射本地 auto-layout；完整 Stack、Auto-pin、flow 键盘重排未宣称等价 | `canvas-workflow-shortcuts.test.ts`、`model-layout.test.ts`、`layout-order.test.ts` |

## 4. 标尺、参考线与测量

| ID | 官方操作或预期 | 当前入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| GUI-01 | Figma 从标尺拖参考线；页面/画板归属 [F9] | ViewControls/Shift+R → `CanvasGuides.tsx`、`guideOwner/worldGuides` | 代码+测试；创建、移动、数值、Delete、拖出移除、取消/失焦有代码 | `ruler-guides.test.ts`；真实捕获/坐标布局待验收 |
| GUI-02 | Figma Option/Alt 拖复制参考线 [F9] | CanvasGuides existing + altKey 生成新 id | 代码入口存在；不把 helper 测试等同完整指针拖动验收 | `ruler-guides.test.ts`（模型/变换） |
| GUI-03 | Sketch Ctrl+R、标尺点击新建、右键批量移除轴向参考线 [S4] | 本地 Shift+R；新建按拖动到有效区域提交；无批量轴删除菜单 | 部分：不同行为明确保留为缺口 | 无对应 Sketch 完整流程测试 |
| GUI-04 | Option/Alt 悬停测距，嵌套目标测量 [S2] [S1] | `canvas-measurements.ts`、Canvas measureKeys | 代码+测试基础；Sketch baseline/cap 组合及全部标注表现需补 | `canvas-measurements.test.ts` |

## 5. 复制、粘贴、顺序与图层管理

| ID | 官方操作或预期 | 当前入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| CLP-01 | Ctrl/Cmd+C/X/V；跨页/文件携带设计依赖 [F10] [S8] | `editor-commands.ts` → 系统剪贴板；`clipboard-semantics.ts` | 代码+测试；不支持保真的语义显式拒绝。真实系统富格式剪贴板待三平台测试 | `clipboard-semantics.test.ts`、`clipboard-internal-review.test.ts` |
| CLP-02 | 粘贴至目标容器、按可容纳坐标居中、多容器多贴 [F10] [S8] | `Editor.pasteToSelection` | 代码+测试子集；Sketch group 居中与 Figma 坐标策略不完全相同，当前未按预设区分 | `smart-paste.test.ts` |
| CLP-03 | Shift+Mod+V：Paste over selection，同父级覆盖所选位置 [F10] [S8] | 新 `paste-over-selection.ts` → 单次 `Editor.change`；菜单、DOM、原生路由一致 | 本轮部分补齐：Figma 单目标，Sketch 每目标一份；保留目标。父局部 Inspector x/y 顶左对齐；Sketch 锚点是明确的本地适配。原位粘贴仍独立菜单，无冲突快捷键 | `paste-over-selection.test.ts`；native main/preload/keyboard tests |
| CLP-04 | Paste to replace：删除目标、继承目标约束 [F10] [S8] | 桌面 Shift+Mod+R / 菜单 → `pasteToSelection(true)` | 代码+测试；浏览器保留强刷新键，用菜单 | `smart-paste.test.ts` |
| CLP-05 | Paste here：鼠标位置为复制内容放置点 [F10] | 右键 worldPoint → `Editor.paste(..., position)` | 代码入口存在；自动布局 frame 上方放置等全部语义未独立穷举 | `clipboard-semantics.test.ts`、`canvas-context-menu.test.ts` |
| CLP-06 | Duplicate、Alt 拖复制、连续位移重复 [F10] [S8] | `Editor.duplicate/moveDuplication` | 代码+测试；Sketch Duplicate behind、去除交互副本、偏移偏好缺口；连续旋转重复未以位移测试代替 | `native-duplication.test.ts` |
| CLP-07 | 复制/粘贴属性、局部填充/描边/效果 | 右键与 Mod+Alt+C/V → `property-clipboard.ts` | 已有本地实现；Sketch “含/不含角半径”的偏好与额外快捷键未对齐 | `property-clipboard.test.ts` |
| ORD-01 | 前移/后移、置顶/置底 [F5] [S1] | `Editor.reorder` 与菜单/共享快捷键表 | 本轮修正 Figma Windows 为 Ctrl+Shift+[ / ]；Mac Cmd+Option 保持；Sketch 仍用自己的主键+Option 适配 | `canvas-workflow-shortcuts.test.ts`、`shortcut-profiles.test.ts` |
| ORD-02 | 列表拖入/拖出容器、排序、取消 [S10] | `Layers.tsx`、`layer-drop.ts`、`reparentMany` | 代码+测试；真实滚动/跨屏拖动未运行 | `layer-drop.test.ts`、`layout-order.test.ts` |
| ORD-03 | 重命名、批量命名 [S11] | 单层 F2/桌面 Mod+R；`DraftInput`；页面命名有取消/过期保护 | 部分：单层/页面有实现；完整批量模板、序号和搜索替换缺口 | `layers-rename.test.mjs` 主要覆盖页面命名，不能证明批量层名 |
| ORD-04 | 图层搜索/过滤/锁定/隐藏 [S10] | `Layers.tsx`、`layer-tree.ts`、属性面板 | 代码入口；搜索字段/类型筛选和 Sketch focus mode 不完整等价 | `canvas-layer-feedback.test.ts`；部分仍需 UI 用例 |

## 6. 文本、组件与导出操作闭环

| ID | 官方操作或预期 | 当前入口与实现 | 判断与具体差距 | 测试证据 |
|---|---|---|---|---|
| TXT-01 | T 工具、点/拖文本框、Enter/双击进入编辑 [F11] [S12] | Canvas + `TextEditor.tsx` | 代码+测试基础；文本输入初始选择、跨对象编辑、原生 IME 待设备；Sketch 文本页和快捷键页存在 T/Cmd+T 文档差异，采用较新的快捷键页且记录差异 | `text.test.ts`、`text-hug-limits.test.ts` |
| TXT-02 | 富文本/字素移动、选中区样式、完成/取消编辑 [F11] [S12] | TextEditor、`text.ts`、pending edit ownership | 代码+测试；普通 Enter 插入换行，主键+Enter 提交，Escape 结束/取消按当前编辑路径；不拿输入框隔离证明 IME 平台等价 | `text.test.ts`、`text-formatting-kernel.test.ts`、`shortcut-dom.test.tsx` |
| TXT-03 | 多文本层批量调整、段落/字距/字体 [S12] | `MultiSelectionInspector`、`TextStylePanel` | 代码+测试基础；完整 macOS 文本菜单快捷键、列表自定义所有项不等价 | `TextStylePanel.test.tsx`、`multiselection-cpu-runtime.test.tsx` |
| CMP-01 | Figma 创建主组件、插入实例并传播变更 [F12] | Mod+Alt+K、`ComponentPanel`、`components.ts` | 代码+测试；不涉及远端发布 | `components.test.ts`、`component-override-fields.test.ts` |
| CMP-02 | Sketch Cmd+Y 同时创建 Source 和 Instance，可移到 Symbols 页 [S13] | 本地 create-component 创建主组件，实例另按按钮 | 部分：生命周期不同，Cmd+Y/Y 未绑定官方 Symbol 工作流，不能只改快捷键冒充完成 | `components.test.ts` 证明本地组件而非 Sketch 创建弹窗 |
| CMP-03 | 嵌套覆盖、交换、还原、解除链接 [F13] [S13] | ComponentPanel、模型与 Editor 组件方法 | 代码+测试；完整 Sketch 替换弹出器、同名组件组织及全部修饰键缺口 | `component-override-fields.test.ts`、`scratch-deep-detach.test.ts` |
| EXP-01 | 导出所选层/画板、倍率/格式/文件名 [F14] [S15] | `ExportPanel`、`NodeExportPanel`、`export.tsx` | 代码+测试；PNG/JPEG/WebP/SVG/PDF 与本地规格；真实保存/下载待设备 | `export-native.test.ts`、`layer-export.test.ts` |
| EXP-02 | 切片、多个导出 preset [S15] | Sketch-like E / Figma-like S；slice target、exportSettings | 代码+测试；Sketch 导出 preset set、宽高后缀输入、切片组内容/背景全部选项未逐项等价 | `export-regions.test.ts`、`layer-export.test.ts` |
| EXP-03 | 一键导出快捷键与目录层次 [S1] [S15] | 当前主要经面板；系统路径/文件名有安全约束 | 部分：Cmd+E/Shift+Cmd+E 未完整提供；不能把 PNG 复制快捷键当导出 | `export-ownership.test.mjs`；无完整原生快捷键测试 |

## 7. 两套预设的使用与平台边界

- 在文件菜单的“快捷键方案”切换；设置留在本机，工具栏/右键提示共享绑定表。
- `Mod` 在 macOS 是 Cmd，Windows/Linux 是 Ctrl。**Sketch 官方设计应用仅列 Mac 操作**；Windows/Linux 的 Sketch-like 是本产品适配，不是官方 Sketch 原生跨平台支持。
- 已对应的常用工具：Figma-like V/P/Shift+P；Sketch-like V/P；按住 X 临时框选，参见 SEL-05。
- Figma-like 选择工具下 Alt+Shift+A 移除自动布局；Sketch-like 是 Alt+Shift+S。
- Sketch-like Mod+方向键改宽/高，Shift 将步长改为 10。保留对象左上局部锚点与现有 Inspector 规则；多选逐层增减，非整个选区等比缩放。当前未支持可配置步长、只改容器不改子内容变体或矢量点编辑快捷键。
- Figma Windows 置顶/底现为 Ctrl+Shift+] / [；Mac 为 Cmd+Option+] / [；保留无修饰键的本地 [ / ] 别名。组合键按严格修饰键匹配，不吞 AltGraph/Dead/Process/IME。
- 浏览器保留刷新、查找和标签页组合键；相关本地命令可从菜单/F2/Shift+数字操作。浏览器例外是主动宿主适配，不能宣称与官方桌面逐键一致。
- 输入框/textarea/contenteditable、菜单、模态框拥有键盘时不执行画布命令；忙碌或拖动期间不启动破坏性交互。

## 8. 本轮落地与验证记录

本轮已实现四项：Sketch-like 基础键盘尺寸微调、方案化全选过滤/作用域、Figma 移除自动布局绑定、Figma Windows 置顶/底修饰键修正。实现均进入 `dispatchEditorCommand`，不另写第二套几何模型，不修改渲染器或浮点精度。

执行环境为当前云工作区 Node + Vitest + 实际 Rust/WASM kernel，DOM 套件使用 jsdom：

```text
cd frontend/design-client
./node_modules/.bin/vitest run src/canvas-workflow-shortcuts.test.ts src/shortcut-profiles.test.ts src/shortcut-dom.test.tsx src/selection-hierarchy.test.ts src/selection-properties.test.ts src/smart-paste.test.ts --reporter=json --outputFile=../../testing/verification-canvas-workflows/results.json
./node_modules/.bin/tsc --noEmit
```

结果：**89/89 测试通过；TypeScript 检查通过。** `testing/verification-canvas-workflows/results.json`、`test.log`、`typecheck.log` 保存记录。覆盖真实状态变化、无关对象 identity、单步历史、undo/redo、JSON 重开、混合文本/形状、缩放父级/旋转、比例锁、隐藏/锁定祖先、空选区、事务取消、IME/输入目标隔离及全部预设/平台组合。没有任何真实 GUI、系统剪贴板或 GPU 通过声明。

本轮第一次执行有一条测试预期把“删除 layout 字段”误写成 `mode='none'`；核对已有 `autoLayout('none')` 实现后改正断言再全量重跑，未将失败隐藏为跳过。

### 后续已完成的有界增量（同日）

- 画布选择增量：按住 X、Option 包含、Shift XOR、Escape 父级；实际挂载 Canvas/WASM 29/29，连同当时的 8 个影响套件 130/130，见 `testing/verification-canvas-selection-workflows/REPORT.md`。同一套件包含 desktop Mod+3/browser 不拦截、pending zoom 与空/隐藏/锁定选择的实际事件测试。
- 覆盖粘贴与共享命令：`testing/verification-paste-over-selection/`。11 个影响套件 **169/169**、TypeScript 通过（包含上述部分测试，不可将总数相加）；新粘贴套件 28/28。隔离副本替换旧交付的三个命令/预设文件后，9 条尺寸/选择/复制数量行为断言失败，非导入失败。
- 原生路由：`testing/verification-native-paste-over/REPORT.md`，focused 66/66；broader desktop-contracts 157/157（含 focused，不相加）。运行真实 main/preload 模块，Electron/OS 边界由测试替身提供；不是本机系统剪贴板验收。
- 全量逐功能等价仍未完成。优先剩余：可配置 nudge、参考层对齐、Symbol 创建生命周期、tap-X 持续模式与明确列出的键盘/布局变体。小地图是用户要求移除，不列为补齐目标。

### 覆盖粘贴的精确合同与限制

Figma 官方 F10 的关键原文：“The pasted object will match the x, y position of the selected object.” 本实现用目标父坐标轴内的 Inspector 边界 x/y，不把旋转后的世界 AABB 顶点当 x/y。单目标多源时按源根图层集合的父坐标边界定位；旋转/缩放父级测试同时验证坐标与线性变换保留。Figma 文档的 Multi-paste 是普通 Paste 到多个 frame，未拿它推断 Paste over selection 多目标规则，因此此预设明确拒绝多目标。

Sketch 官方 S8 明确：“When you select multiple layers, it pastes a copy over each one.” 文档未明确顶左/中心以及旋转父级的精确锚点。本轮实现每目标独立图层图，采用相同父局部顶左锚点；该几何规则是本地适配，仍需原生 Sketch 实证，不能称一比一一致。

操作始终保留原目标，按同父级紧邻目标之后插入；自动布局父级中新增根设为 absolute，避免挤动原对象。目标父级已有的裁剪/蒙版由新兄弟继承。独立 root-mask 剪贴板会被拒绝并要求先编组，以免改变原容器其他兄弟的蒙版范围；成组蒙版支持。隐藏/锁定路径、实例内部结构、Figma 多目标、超过 64 个选择目标、展开剪贴板超过 32 MiB、超过 20000 图层、外向原型引用或冲突起点明确拒绝，绝不静默丢目标。

全部目标的图层/组件/变量/原型/动画计划在写入前完成；复制完整候选后仅一次历史提交，保护旧快照。读取系统剪贴板期间若文档身份/版本/页面/选区/交互/焦点变化则拒绝过期应用；已有手势不被取消或代提交。内核预检临时字体环境在成功/失败后恢复，提交失败也恢复当前文档环境。非空真实字形、既有动画对象与 tracks identity、故意后置校验失败、undo/redo、JSON 重开均有证据。缺少系统剪贴板 API 时仅可使用该编辑器通过“复制”命令保存的本地 packet；不绕过系统拒绝。

## 官方来源（均读取于 2026-10-19）

- [F1 选择层与对象](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- [F2 键盘使用与无指针操作](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- [F3 缩放与视图](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)
- [F4 Frame 操作](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design)
- [F5 对齐、旋转、位置与尺寸](https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions)
- [F6 自定义微移步长](https://help.figma.com/hc/en-us/articles/4404575206295-Set-small-and-big-nudge-values)
- [F7 Smart selection](https://help.figma.com/hc/en-us/articles/360040450233-Arrange-layers-with-Smart-selection)
- [F8 自动布局与快捷键](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma)
- [F9 画布/画板参考线](https://help.figma.com/hc/en-us/articles/360040449713-Add-guides-to-the-canvas-or-frames)
- [F10 复制与粘贴](https://help.figma.com/hc/en-us/articles/4409078832791-Copy-and-paste-objects)
- [F11 文字指南](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design)
- [F12 创建组件](https://help.figma.com/hc/en-us/articles/360038663154-Create-components-to-reuse-in-designs)
- [F13 组件指南](https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma)
- [F14 静态导出](https://help.figma.com/hc/en-us/articles/360040028114-Export-static-designs-from-Figma)
- [S1 Mac 快捷键，更新 2026-10-01](https://www.sketch.com/docs/shortcuts/mac/)
- [S2 选择图层，更新 2026-01-23；页面提示部分内容正在更新](https://www.sketch.com/docs/designing/layer-basics/selecting-layers/)
- [S3 编组，更新 2026-10-12](https://www.sketch.com/docs/designing/layer-basics/grouping-layers/)
- [S4 Canvas，更新 2026-06-22](https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-canvas/)
- [S5 尺寸与旋转，更新 2026-10-12](https://www.sketch.com/docs/designing/layer-basics/resizing-and-rotating-layers/)
- [S6 对齐，更新 2026-10-12；页面提示部分内容正在更新](https://www.sketch.com/docs/designing/layer-basics/aligning-layers/)
- [S7 移动图层](https://www.sketch.com/docs/designing/layer-basics/moving-layers/)
- [S8 复制与粘贴，更新 2026-06-22](https://www.sketch.com/docs/designing/layer-basics/duplicating-layers/)
- [S10 图层列表，更新 2026-06-22](https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-layer-list/)
- [S11 图层命名](https://www.sketch.com/docs/designing/layer-basics/renaming-layers/)
- [S12 文字，更新 2026-08-19；正文与 S1 的 T/Cmd+T 表述不完全一致](https://www.sketch.com/docs/designing/text/)
- [S13 Symbols，更新 2026-08-26](https://www.sketch.com/docs/symbols-and-styles/symbols/)
- [S14 Mac 界面与小地图](https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/)
- [S15 导入/导出，更新 2026-08-19](https://www.sketch.com/docs/designing/importing-and-exporting/)

[F1]: https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects
[F2]: https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard
[F3]: https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options
[F4]: https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design
[F5]: https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions
[F6]: https://help.figma.com/hc/en-us/articles/4404575206295-Set-small-and-big-nudge-values
[F7]: https://help.figma.com/hc/en-us/articles/360040450233-Arrange-layers-with-Smart-selection
[F8]: https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma
[F9]: https://help.figma.com/hc/en-us/articles/360040449713-Add-guides-to-the-canvas-or-frames
[F10]: https://help.figma.com/hc/en-us/articles/4409078832791-Copy-and-paste-objects
[F11]: https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design
[F12]: https://help.figma.com/hc/en-us/articles/360038663154-Create-components-to-reuse-in-designs
[F13]: https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma
[F14]: https://help.figma.com/hc/en-us/articles/360040028114-Export-static-designs-from-Figma
[S1]: https://www.sketch.com/docs/shortcuts/mac/
[S2]: https://www.sketch.com/docs/designing/layer-basics/selecting-layers/
[S3]: https://www.sketch.com/docs/designing/layer-basics/grouping-layers/
[S4]: https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-canvas/
[S5]: https://www.sketch.com/docs/designing/layer-basics/resizing-and-rotating-layers/
[S6]: https://www.sketch.com/docs/designing/layer-basics/aligning-layers/
[S7]: https://www.sketch.com/docs/designing/layer-basics/moving-layers/
[S8]: https://www.sketch.com/docs/designing/layer-basics/duplicating-layers/
[S10]: https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-layer-list/
[S11]: https://www.sketch.com/docs/designing/layer-basics/renaming-layers/
[S12]: https://www.sketch.com/docs/designing/text/
[S13]: https://www.sketch.com/docs/symbols-and-styles/symbols/
[S14]: https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/
[S15]: https://www.sketch.com/docs/designing/importing-and-exporting/
