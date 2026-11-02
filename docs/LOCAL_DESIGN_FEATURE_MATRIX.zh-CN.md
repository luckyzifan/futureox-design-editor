# Figma / Sketch 本地设计能力核对表

核对日期：2026-10-19。源码基线：`71d3215` 上的本轮工作区；并行变更需以最终验证记录的源码快照为准。

## 范围与结论

本表以官方文档列出的本地设计、文件、画布、布局、文字、组件、原型和扩展能力为检查目录，核对本仓库可定位的生产模块、界面入口及测试。排除账号、团队/云资料库、多人协作、云版本历史、评论通知、网站发布、托管和云 AI。FigJam 的本地便签/连接器等只是附加工具，不用它们抵消 Design 的缺口。

这里的“本地能力”是无需远端服务完成的工作流，并不表示 Figma 官方所有功能都支持断网。Figma 官方明确其离线能力限于已载入的页面、当前文件组件等；Sketch 官方提供本地保存默认项。[F1][S1]

现有产品已经覆盖大量基础能力：网格/换行自动布局、OpenType 与可变字体轴、组件覆盖/变体、本地变量模式、SVG/PNG/JPEG/WebP/PDF 导出等并非空白。另一方面，不能声称“已实现 Figma + Sketch 所有功能”或“所有菜单/所有系统全通过”：通用原型表达式、完整交互组件状态、媒体播放、自定义矢量笔刷、Sketch Data、原生格式完整保真及三平台真实 UI/GPU 验证仍有明显缺口。

### 状态解释

- **已有实现**：找到了产品模块和入口；不等于该功能所有边界、像素和操作系统都已通过。
- **部分实现**：有可用子集，但已知语义、入口、格式或测试存在差距。
- **未找到完整实现**：本轮源码检索/入口核对没有找到完整闭环，不将名称相似的工具映射算作完成。
- **待原生验收**：代码/测试可存在，仍缺真实 Windows/macOS/Linux 桌面交互或 GPU 证据。

表中 `client/` 指 `frontend/design-client/src/`；`desktop/` 指 `frontend/design-desktop/`；`kernel/` 指 `design-studio/crates/design-kernel/`。测试列是可复现入口证据，不是本表声称的通过数量。真实执行状态见统一运行器 `results.json` 和最终验收报告。

## 1. 文件、工作区与恢复

| 功能及官方对照 | 当前状态与产品证据 | 测试/剩余边界 |
| --- | --- | --- |
| 本地新建、打开、保存/另存为 [F1][S1] | 已有实现：`client/App.tsx`、`desktop-session.ts`、`desktop/src/sidecar.mjs`、Rust 本地 storage | `desktop-session.test.ts`、真实 `test/runtime/sidecar-runtime.test.mjs`；原生文件对话框需三平台验收 |
| 多页、页切换、画布组织 [F2][S2] | 已有实现：`PageList.tsx`、`Layers.tsx`、`engine.ts` | `workspace-session.test.ts`、`document-lifecycle.test.ts`；超大页/取消切换需真实 UI |
| 本地目录、搜索/收藏/最近、标签页与窗口 | 已有实现：`DesktopCatalog.tsx`、`WorkspaceTabs.tsx`、`LocalWindows.tsx` | catalog/window-state/workspace 测试；不能把本地目录叫云团队空间 |
| 自动保存、恢复、冲突检测、修订/回收站 | 已有实现：`local-store.ts`、`document-history.ts`、Rust workspace/recovery | `local-revisions.test.ts`、`workspace-runtime.test.mjs`；崩溃/磁盘满/权限拒绝需原生验收 |
| 编辑撤销/重做、事务原子性 | 已有实现：`engine.ts`、`kernel/graph-history-state.ts`、Rust graph API | `engine-history.test.ts`、`document-history.test.ts`、`kernel/op-sync-history.test.mjs`；内存 Graph 替身不等于真实 Rust 全链路 |
| Figma `.fig` 导入 [F1][F3] | 部分实现：`import-fig.ts` 解析本地文件并显式拒绝部分字段 | `import-fig-{fidelity,layout,text,image}.test.ts`；明确拒绝不支持色域/插值/独立边框等，不能称全格式兼容 |
| Figma `.fig` 再导出 [F1][F3] | 未找到原生 `.fig` 写出闭环；现有 `.fd`/JSON/Sketch/图像导出不能冒充 `.fig` | 需要独立格式写入器和真实 Figma reopen 验证；不以扩展名改名代替 |
| Sketch 原生打开/检查/受支持编辑及保存 [S1][S2] | 部分实现：`Sketch*Dialog/Editor`、桌面 `sketch-session`、Rust Sketch 模块；另有兼容导入/导出路径 | `sketch-import-contract.test.ts`、`sketch-*bridge.test.mjs`、Rust Sketch 测试；兼容路径已提示保留原稿，原生/转换路径不可混称 |
| SVG、PDF、位图导入 [F3][S2] | 部分实现：`import-svg.ts`、`import-worker.ts`、`image-import.ts` | SVG viewport/presentation、IO/image tests；SVG 滤镜等明确限制，PDF/色彩/字体并非全保真承诺 |
| 本地图片/字体嵌入与跨文档粘贴 | 已有实现：`text.ts`、`append-document.ts`、`clipboard-semantics.ts` | `append-document`、`font-matching`、`native-duplication` 测试；私有 117 样本缺失会显式 skip |

## 2. 画布、右键和常用编辑

| 功能及官方对照 | 当前状态与产品证据 | 测试/剩余边界 |
| --- | --- | --- |
| 单选、框选、加选、深选、锁定/隐藏、反选 [F2][S2] | 已有实现：`Canvas.tsx`、`selection-hierarchy.ts`、`selection-queries.ts` | picking/selection/lock tests；深层蒙版/透明像素误选需 GUI/CPU 像素联合验收 |
| 平移/缩放、缩放至选区/全部、保持倍率居中、滚动条 | 已有实现：`canvas-camera.ts`、`kernel/navigation-zoom.ts`、`center-selection`；小地图/缩略导航已依用户要求移除 | camera/navigation/scrollbar 与实际 Canvas Cmd+3 测试；真实触控板手势需原生设备。小地图不是待补缺口 |
| 移动、尺寸、旋转、翻转、缩放锚点 [F2][S2] | 已有实现：`engine.ts`、`ScaleInspector.tsx`、`selection-scale` | selection-handles/scale/native-shapes tests；跨系统修饰键/触笔压力需原生验收 |
| 对齐、分布、整理间距、智能选择 [F2][S2] | 已有实现：`AlignmentControls.tsx`、`align-engine.ts`、`CanvasSmartSelection.tsx` | align-engine、smart-selection、canvas-smart-guides |
| 标尺/参考线、布局网格、像素网格、测距 | 已有实现：`CanvasGuides.tsx`、`grid-overlay.ts`、`canvas-measurements.ts` | ruler-guides/layout-grid-overlay/pixel-grid/measurements |
| 图层树排序、重命名、编组、画板/分区 | 已有实现：`Layers.tsx`、`layer-drop.ts`、`canvas-menu-model.ts` | layer-drop/layers-rename/layout-order；拖出/拖入布局容器及取消需真实 UI |
| 复制/剪切/原位粘贴/覆盖粘贴/粘贴替换/属性与填充复制 | 已有实现：`editor-commands.ts`、`paste-over-selection.ts`、`property-clipboard.ts`、`clipboard-semantics.ts`；Shift+Mod+V 是独立覆盖粘贴，原位保留菜单 | 覆盖粘贴 Figma 单目标、Sketch 每目标一份且几何是明确本地适配；atomic/history/font/async tests。系统跨应用格式仍待设备；详见下列逐操作对照 |
| 右键菜单状态、菜单键/Escape、焦点归还 | 部分实现：`CanvasContextMenu.tsx`、`canvas-menu-model.ts`；按锁定/选择/交互状态禁用 | `canvas-context-menu.test.ts`、快捷键 DOM 测试；不能用菜单数组长度证明每个命令实际修改、保存和恢复 |
| Figma/Sketch 快捷键配置、Cmd/Ctrl 与输入框隔离 | 本轮实现：`shortcut-profiles.ts`、`editor-shortcuts.ts`、`KeyboardProfileSettings.tsx`、桌面快捷键模块 | profile/DOM/desktop keyboard tests；真实 IME、非美式键盘、系统保留键、菜单显示仍待原生验收 |
| 搜索相同属性/字体/实例、重命名 | 已有实现：`selection-queries.ts`、`Layers.tsx` | selection-queries/layers-rename；完整批量命名模板/搜索替换的官方所有选项未逐项验收 |

## 3. 图形、样式与文字

| 功能及官方对照 | 当前状态与产品证据 | 测试/剩余边界 |
| --- | --- | --- |
| 基础形状、圆弧、星形/多边形参数、平滑圆角 [F2][S3] | 已有实现：`shape-creation.ts`、`native-shapes`、Rust authoring_shapes | shape/native-shapes/smooth-corners；独立原生应用像素对照仍有限 |
| 钢笔/矢量网络、节点/手柄、闭合/剪断 [F2][S2] | 已有实现：`editable-network.ts`、`utility-tools.tsx`、`Canvas.tsx` | editable-network/local-tools/svg-path-closure；完整工具模式操作仍需 GUI |
| 布尔运算、轮廓描边、扁平化、偏移路径 | 已有实现/部分语义：`editor-commands.ts`、`geometry.ts`、`utility-tools.tsx`、Rust geometry | outline-compositing/offset-safety/native-shapes；复杂自交/零面积反例需继续积累 |
| 交互式 Shape builder 区域合并/提取/减去 [F9] | 未找到完整独立模式；现有布尔运算/油漆桶/剪断路径不是同一个区域拖选工作流 | 需多路径平面区域分解、悬停/拖选反馈、保留独立区域、撤销及退化几何测试 |
| 非破坏性线性/径向重复变换组 [F10] | 未找到完整实现；重复复制保留位移节奏和图案填充不等于可编辑原件驱动的变换组 | 需重复参数模型、派生实例、变换编辑 UI、序列化/拾取和性能测试 |
| 铅笔、压力笔刷、马克笔、套索/橡皮 [F4] | 部分实现：`freehand.ts`、工具模块与画布；已有压感宽度曲线 | freehand/local-tools tests；真实笔设备、参数精度和完整笔刷库不由这些测试证明 |
| 自定义 Stretch/Scatter 矢量笔刷及资产复用 [F4] | 未找到完整实现：现有 freehand 以线宽/颜色/平滑/压力为主，不能等同源矢量笔刷资产 | 需要 brush source 模型、形变/散布算法、编辑面板、序列化与跨文档测试 |
| 多重填充/描边、渐变、图像/图案、混合、蒙版 | 已有实现：`model.ts`、Inspector、Rust paint/compositor | gradient/model-pattern-fill/mask-alpha/stroke tests；真实 GPU 与 CPU 的数值/像素一致性单列 |
| 阴影/模糊/背景模糊、玻璃/噪声/纹理 | 部分实现：模型、内核/GPU 模块、面板 | 材质/采样/渲染合约；命名相同不代表 Figma 渲染结果等价，缺大规模独立像素基准 |
| 图像裁剪/调节、EXIF/ICC [F2][S2] | 部分实现：`image-crop.ts`、`model-image-adjust`、图像解码路径 | image-crop/io-format-contract/fixtures；不宣称完整照片编辑器或所有编码格式 |
| 色彩管理、P3/HDR、导出配置 [S4] | 部分实现：`color.ts`、`ColorPanel.tsx`、Rust 色彩内核 | color/export-native；显示器/系统 compositor/HDR 输出需真实设备，不由颜色元数据自动证明 |
| 文本编辑、富文本、字素边界/IME、自动/固定尺寸 [S5] | 已有实现：`TextEditor.tsx`、`text.ts`、Rust font | text/text-hug-limits/text-indent/formatting-kernel；复杂脚本/系统字体与 IME 必须实际验收 |
| 段落、对齐/两端对齐、字距行距、大小写/装饰 | 已有实现/部分排版：`TextStylePanel.tsx`、Rust font | 本轮 `__tests__/text-justify.test.ts` 测真实拉丁空格扩展/末行；不据此宣称 CJK 排版、阿拉伯/希伯来字形全部正确 |
| OpenType features、可变字体轴、fallback [S5] | 部分实现：`TextStylePanel.tsx`、`font-catalog.ts`、Rust `faces_json` / 桌面字体目录。内置 Noto Sans SC 是可变 `wght`；macOS、Windows、Linux 扫描标准字体目录并带出字重、斜体和最多 16 条变体轴。缺失字体需确认后才替换，简体中文内置字体可作 CJK 建议。不会下载字体 | `font-catalog.test.ts`、内核 `bundled_noto_sans_sc_reports_variable_weight_axis`、桌面 `linux_roots_cover_usr_share_and_dejavu_styles`。浏览器本机字体没有轴元数据；字重数字不会自动换成另一份静态字体文件，除非字重差为 0 或用户确认近似项。TC/JP/KR 没有独立内置字体。这不是 Figma 字体服务或全字形像素对照 |
| 文本沿路径 [F4][S2] | 部分实现：`utility-tools.tsx`、model textPath、Rust font | local-tools/authoring；复杂路径、富文本与恢复边界仍需独立用例 |

## 4. 布局、组件和设计系统

| 功能及官方对照 | 当前状态与产品证据 | 测试/剩余边界 |
| --- | --- | --- |
| 横向/纵向/网格布局、wrap、gap/padding/对齐 [F5][S6] | 已有实现：`LayoutPanel.tsx`、`model.ts`、Rust layout | model-layout/model-layout-grid/layout-order；不能因有 Grid 枚举就声称所有官方 grid 细节均一致 |
| Hug/Fill/固定、min/max、约束、绝对定位 | 已有实现：model sizing/constraints、LayoutPanel | text-hug/selection-scale/FIG layout；多层约束、像素取整需更多对照 |
| 自动建议布局/多容器推断 [F5] | 未找到与官方 Suggest auto layout 等价的多层推断闭环 | 现有“添加自动布局”只证明转换入口；需先定义保留位置/推断规则与反例 |
| 组件/实例、嵌套、覆盖、解除链接 [F6][S7] | 已有实现：`components.ts`、`ComponentPanel.tsx`、Rust components | components/component-override-fields/scratch-deep-detach（真实撤销/重做） |
| 变体与文本/布尔/实例交换属性 [F6][S7] | 已有实现：组件模型/ComponentPanel | components/variable-modes；新式 slots/所有嵌套暴露配置未找到完整等价证明 |
| 组件内容 Slots [F11] | 未找到完整自由内容插槽模型/实例内增删排序闭环；嵌套 instance-swap 和测试中名为 slot 的图标不是官方自由内容插槽 | 需 slot 准入、容器所有权、实例内容修改与主组件同步、覆盖/断开/复制测试 |
| 本地样式/组件库快照、更新与引用 [S8] | 部分实现：`design-system.ts`、`DesignTools.tsx`、`WorkspaceLibrary.tsx` | shared-style-parts/component tests；本地安装/验证与云订阅完全分开，不宣称 Sketch/Figma 插件库格式通用 |
| 变量集合/四类值、别名、模式、节点继承 [F7] | 已有实现：`design-system.ts`、`DesignTools.tsx`、model bindings | variable-modes/design-copy；别名循环和跨文档引用需要明确拒绝/保存回放 |
| 变量 description/scope/code syntax、批量管理 [F7] | 部分实现：当前变量模型主要为 name/collection/kind/values；未找到官方全套 scope/description/code syntax UI | 应独立扩展 schema 与导入/导出/批量事务，不能把 alias/mode 测试算作此覆盖 |
| Sketch Data 文本/图片/Linked Data/刷新 [S9] | 未找到完整实现：普通文本/图片导入和 API 批量创建不能替代持久 Data source/字段映射/刷新 UI | 可先实现本地 JSON/TXT 合成数据集，禁止默认网络素材来源 |

## 5. 原型、导出与本地扩展

| 功能及官方对照 | 当前状态与产品证据 | 测试/剩余边界 |
| --- | --- | --- |
| 点击/悬停/离开/延时、导航/返回、开始帧 | 部分实现：`prototype.ts`、`PrototypePlayer.tsx`、DesignTools | prototype-playback/schema-extras；当前 trigger 闭集不含官方全部 press/drag/key/media 触发 |
| Overlay 位置/背景/关闭与多层覆盖 [S10] | 已有实现/待细节验收：prototype overlayPosition/overlays | prototype-playback；层相对定位、手势/点击外部等应逐项真实 UI 对照 |
| 滚动/scroll-to、保留/重置滚动 [S11] | 已有实现/部分：`prototype-scroll.ts`、播放器、schema flags | prototype-scroll；多方向嵌套滚动/固定或 sticky 元素的全部官方语义未证明 |
| Smart Animate/过渡时长/缓动 [S12] | 部分实现：animation kernel/plan、prototype easing | prototype-easing/animation-orchestrator；匹配层名、形状、颜色、滤镜等所有过渡不等价承诺 |
| set-variable、多动作、条件执行 [F8] | 部分实现：有 actions 数组、变量值和 `{variable, equals}` 条件 | prototype-playback；只支持等值条件不能当作任意 if/else 和表达式 |
| 算术/比较/逻辑/字符串表达式、嵌套 if/else [F8] | 未找到完整实现：PrototypeAction.value 仍为 literal，condition 为单变量 equals | 这是优先可分批补齐的本地功能；需有界 AST 而非 eval、类型/循环/预算/取消测试 |
| 媒体播放/seek、交互组件状态重置 | 未实现执行：`prototype.ts` 对 mediaAction 和 resetInteractiveComponents 明确抛错；部分字段仅保留 | prototype-schema-extras 只证明 schema/拒绝，不能记作播放器通过 |
| Sketch hover/press 显隐切换 [S13] | 未找到完整独立 show/hide/toggle action 闭环；当前 action kind 不含对应类别 | 可通过变量控制部分属性，但需要显式菜单/运行时/还原语义，不能自动推定等价 |
| PNG/JPEG/WebP/SVG、按图层/切片/倍率批量导出 [F3][S14] | 已有实现：`export.tsx`、`ExportPanel.tsx`、`NodeExportPanel.tsx` | export-native/export-regions/layer-export；真实浏览器 Blob 下载和系统目标目录需原生验收 |
| PDF 矢量与回退、视觉 SVG | 部分实现：`pdfVectorIssues` 明确能力检查，复杂效果可回退位图 PDF | 导出提示/回退必须可见；位图回退不计入“全部矢量” |
| 原始设计文件、Sketch 兼容导出与再次打开 | 部分实现：forma codec、Sketch codec/worker | local-tools/sketch-import-contract；不可丢字段验证与真实 Sketch 重新打开仍需持续扩充 |
| 本地检查、代码/CSS 片段/自动化/MCP | 本轮新增边界：`client/automation/`、`desktop/src/automation-bridge.mjs`、`frontend/design-mcp/` | 见独立 AUTOMATION 文档；内存协议、真实 stdio、SQLite 与真实 socket 状态必须分开 |
| 完整 Figma/Sketch 插件宿主/插件 UI API [F1][S2] | 未找到通用兼容插件沙箱/第三方插件安装闭环；新本地操作 API/MCP 是受限接口 | 不能以工具数量/SDK 名称等同官方所有插件 API；插件执行授权与隔离需另行设计 |
| 本地便签/连接器/表格/代码块/标注/评论 | 已有实现/附加能力：`board-tools.ts`、`ReviewsPanel.tsx`、`local-tools` | 合成文档/撤销/序列化测试；是单机记录，不是多人协作 |

## 6. 最大缺口与下一批建议

1. **先关紧验收入口**：统一运行器涵盖所有已声明 CPU 测试类别，保存失败/跳过；三平台 CI 真的执行之后再汇总。原生 GUI、GPU、socket ACL、安装包不得借用纯 CPU 结果。
2. **原型表达式小闭环**：先实现 literal/variable/arithmetic/comparison/boolean 的有界 AST、if/else 和 UI 编辑，保留旧 equals 文档兼容。必须测试类型错误、非法字段、除零、预算耗尽、取消、undo、文件 round trip；不同时扩展媒体和交互组件完整状态机。
3. **Sketch 本地 Data 最小版本**：仅本地 JSON/TXT/图片目录，显式字段映射、可重复填充、刷新与撤销。合成公开夹具验证；不碰账户/网络内容。
4. **原生格式与绘制保真分开**：按不支持的 FIG/Sketch 字段建立拒绝/保留/可编辑矩阵，先修高频字段；高级笔刷另开 brush-source 模型批次。禁止静默扁平化后称“完全编辑”。
5. **最后验证工具到 UI 的全链路**：每个菜单/右键/快捷键都要覆盖 enabled/disabled、提交/取消、重复操作、undo/redo、保存重开、锁定/嵌套、IME 和跨平台修饰键。现有工具注册表只证明分发，不证明完整操作结果。

当前工作没有扩大到云账号、云协作或发布。没有远程 push、发布网站或宣称已开源；项目许可、外部设计夹具再分发和秘密/历史审查仍是单独的发布前门禁。

## 官方来源（读取于 2026-10-19）

- [F1：Figma 离线能力](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)
- [F2：Figma Design 文档入口](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
- [F3：Figma 静态导出](https://help.figma.com/hc/en-us/articles/360040028114-Export-static-designs-from-Figma)
- [F4：Figma Draw 画笔与自定义 Stretch/Scatter](https://help.figma.com/hc/en-us/articles/31440438150935-Draw-with-illustration-tools)
- [F5：Figma Auto layout 与 Suggest auto layout](https://help.figma.com/hc/en-us/articles/5731482952599-Toggle-on-auto-layout-in-designs)
- [F6：Figma 组件与变量结构](https://help.figma.com/hc/en-us/articles/38978644498199-AI-workflows-collection-Refine-your-components-and-variables-for-the-Figma-agent)（仅采用本地组件结构说明，云 AI 不纳入范围）
- [F7：Figma 变量集合、scope/code syntax](https://help.figma.com/hc/en-us/articles/15145852043927-Create-and-manage-variables-and-collections)
- [F8：Figma 多动作/条件](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals)；[变量与表达式](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma)
- [S1：Sketch 本地保存与文档管理](https://www.sketch.com/docs/getting-started/saving-and-managing-documents/)
- [S2：Sketch Designing 功能目录](https://www.sketch.com/docs/designing/)
- [S3：Sketch 基础形状](https://www.sketch.com/docs/designing/shapes/adding-shapes/)
- [S4：Sketch Color profiles](https://www.sketch.com/docs/designing/color-profiles/)
- [S5：Sketch 文本、OpenType/可变字体](https://www.sketch.com/docs/designing/text/)
- [S6：Sketch Frames](https://www.sketch.com/docs/designing/frames/)
- [S7：Sketch Symbols and Styles](https://www.sketch.com/docs/symbols-and-styles/)
- [S8：Sketch 本地 Libraries](https://www.sketch.com/docs/libraries/creating-and-adding-libraries/)
- [S9：Sketch Data](https://www.sketch.com/docs/designing/data/)
- [S10：Sketch Overlays](https://www.sketch.com/docs/prototyping/overlays/)
- [S11：Sketch 固定元素](https://www.sketch.com/docs/prototyping/creating-fixed-elements/)
- [S12：Sketch 动画](https://www.sketch.com/docs/prototyping/animating/)
- [S13：Sketch 显隐触发](https://www.sketch.com/docs/prototyping/customizing-layer-visibility/)
- [S14：Sketch Importing & exporting](https://www.sketch.com/docs/designing/importing-and-exporting/)

- [F9：Figma Shape builder](https://help.figma.com/hc/en-us/articles/31616004109847-Create-custom-shapes-with-the-shape-builder-tool)
- [F10：Figma 非破坏性线性/径向重复](https://help.figma.com/hc/en-us/articles/31440427042839-Create-patterns-with-transforms)
- [F11：Figma 内容 Slots](https://help.figma.com/hc/en-us/articles/38231200344599-Create-and-use-slots-to-build-flexible-components-in-Figma-Design)

## 2026-10-19 逐操作对照补充

详见 [本地画布流程逐项对照](LOCAL_CANVAS_WORKFLOW_COMPARISON.zh-CN.md)：逐项官方原文来源、预设差异、代码入口、正向/旧代码负向测试、已实现与剩余缺口分开记录。新增能力不能推导为 Figma/Sketch 全部一比一兼容。
