# 公开 Figma 插件静态兼容率与字体真加载（2026-11-06）

## 范围与方法

- 夹具：13 个开源仓库、39 个 figma 编辑器插件（出处与许可见 `../fixtures/figma-plugins-public-20261106/SOURCE.json`；`thomas-lowry/figmotion` 克隆失败缺席）。
- 分析器 `../run_figmaplugin_coverage_20261106.mjs`：静态提取 manifest `main`/`ui`（未构建仓库回退扫源码树）中的 `figma.*` 调用链与节点属性访问，对照富宿主 `PLUGIN_API_COVERAGE` 矩阵分类。**不执行任何插件代码**（不可信下载物）。URL 文本（figma.com）剔除；裸命名空间（如 `figma.viewport`）按其已收录子项计 partial。
- 局限：静态扫描会漏掉别名/动态访问，无法证明运行时行为；兼容率是「调用的 API 是否被矩阵受理」的静态度量，不是运行验收。

## 结果（JSON 明细：`coverage.json`）

- 39 插件、515 处 API 用法：**supported 289 / partial 210 / unsupported 16 / unknown 19**，静态兼容率 **96.9%**。
- unsupported 阻断（按插件数）：`loadAllPagesAsync`(4)、`parameters`(4)、`codegen`(2)、`TextNode.getStyledTextSegments`(2)、`reactions`、`teamLibrary`、`payments`、`createVector`（各 1）。
- 矩阵未收录：`getLocalPaintStylesAsync`(3)、`getLocalEffectStylesAsync`(2)、`getLocalTextStylesAsync`(2)、`getNodeByIdAsync`(2)、`createSlice`、`findNodeById`、`getStyleByIdAsync`、`setCurrentPageAsync`、`createConnector`、`getShapeWithText` 等。
- 下一批低成本扩覆盖候选：`loadAllPagesAsync`（本地文档页已全载，可空解析）、`getNodeByIdAsync`/`setCurrentPageAsync`（同步版已支持，补 async 包装）、`getLocal*StylesAsync`（`style.list`/`collection.list` 已有）、`createSlice`（slice 类型已在 KINDS）。`parameters`/`codegen`/`payments`/`teamLibrary` 为结构性缺口，不计划补。

## 字体真加载（同轮实现）

`figma.loadFontAsync` 不再对文档外字体假拒绝：富宿主走 fetch 同款异步侧车道——QuickJS 侧挂起 promise → 控制器经桌面 `fonts.list/read` 取本机字体 → 复用 `font.import` 注册表操作过准入（解析、嵌入权限、24 MiB 预算）→ `__finishFont` 解/拒。变更点：`rich-host/session.ts`（任务队列、目录匹配、别名）、`prelude.ts`（挂起 promise）、`runtime.ts`（finishAsync 循环）、`PluginPanel/PluginHostDialog`（desktop.fonts 接线）、coverage 矩阵注记。斜体与未安装字体仍拒绝；Web 无目录维持原报错；不下载网络字体。

验证：`bun run test -- src/plugins/rich-host/` 36 项通过（含 3 项新端到端字体测试与 3 项 session 级测试）；`bun run typecheck` 通过。修复途中发现变更类注册表调用返回 batch 信封而非裸结果（别名曾因此丢失），已按信封解析并测试锁定。

## 扩覆盖批次（2026-11-06 第二轮）

按上轮阻断榜落地：`loadAllPagesAsync`（本地文档页常驻，立即解析）、`getNodeByIdAsync`/`setCurrentPageAsync`/`getStyleByIdAsync`/`getLocalPaintStylesAsync`/`getLocalTextStylesAsync`/`getLocalEffectStylesAsync`（同步版的 async 包装）、`createSlice`（放开 create 准入）、`exportAsync` PNG/JPG（经产品 CPU 光栅导出 `captureDesignPreview` 的 fetch 同款异步侧车道，scale 0.1–4，base64 传输上限 500,000 字符，超出报 `export_limit`；PDF 不支持）。`createNodeFromSvg` 复核确认此前已走 `svg.import` 实现，本轮未改代码。

字体修正：会话内别名改为按 `family|weight` 键控（静态族每权重保持独立 face，变量族共享一次嵌入），目录 face 以 catalog face id 去重——同 face 多风格只导入一次，避免撞 32-face 上限；变量 face 嵌入默认实例、渲染时由文本 weight 字段驱动 wght 轴。斜体维持拒绝（文档模型无 italic 字段，属模型级缺口）。快照宿主（worker 快照架构）维持仅文档字体，其 coverage 行与 FIGMA_PLUGIN_HOST.md 已如实标注与富宿主的差异。

复跑兼容率：**97.7%**（supported 305 / partial 210 / unsupported 12 / unknown 7）。剩余 unsupported 为结构性项（parameters/codegen/payments/teamLibrary/reactions/getStyledTextSegments/createVector）；剩余 unknown 多为正则误捕获（`figma.children`/`figma.svg`/`figma.json`）与单插件项（createConnector/findNodeById/getCanvasGrid）。

验证：`bun run test -- src/plugins/` 70 通过 2 跳过（rich-host 40/40，含 async 批量、createSlice、页切换、PDF 拒绝、静态双 face 别名/共享 face 复用等新用例）；`bun run typecheck` 通过；覆盖矩阵守卫测试（V1 文档逐条对账）通过。PNG 光栅全链路依赖已挂载的渲染 Worker，测试环境仅验证准入层，产品光栅路径由既有导出测试背书。
