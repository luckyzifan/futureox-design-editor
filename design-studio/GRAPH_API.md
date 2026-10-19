# Design Kernel 句柄式图 API（facet 架构层）

本层把编辑内核从"JSON 字符串进出的平面属性面"升级为句柄式 API，模块划分对齐
业界成熟编辑引擎的公开边界形态：能力正交组合、不可变快照、op 日志、二进制
schema、压缩同步帧、瓦片寻址和布局感知快捷键。

## 模块

| 模块 | 职责 |
|---|---|
| `handles` | 世代句柄竞技场：`index(24bit) \| generation(8bit)`，释放后复用槽位必带新世代，陈旧句柄拒绝而非错认 |
| `facet` | Facet 组合：节点按 kind 暴露能力集（transform/clip/stack/constraints/vector/text/instance/…），投影读写桥接既有 `Node` 字段，渲染与持久化零改动 |
| `snapshot` | `im::OrdMap` + `Arc<Node>` 结构共享快照；HISTORY_LIMIT 环形 undo 缓冲 |
| `ops` | 编辑即 op：apply/invert（含 ClearFacet 语义），OpLog 的 undo 重放逆 op、redo 重放原 op |
| `protocol` | 双平面同步协议：文本信封 `{messageType: ping/ack/denormalizedMutations/ops}` + 二进制 op 帧（varuint revision 前缀 + 可选 lz4） |
| `binfmt` | 值树二进制文档格式：魔数+版本+SHA-256 截断校验、去重字符串表、类型标签 varint；重复键名只存一次 |
| `tile_stack` | 瓦片寻址：level/x/y 键、2 的幂缩放、viewport/scissor（绝对与相对）/uv 矩形/清除策略、tile→node 3x3 矩阵 |
| `shortcuts` | 布局感知快捷键 schema：OS × 键盘布局 × display 字符串，组合键反查 |
| `graph_api` | 汇聚层：句柄 API（节点遍历、facet 读写、op/undo、二进制导入导出、瓦片查询），wasm 面在 `lib.rs` 的 `GraphApi` |

## 设计约束

- GraphApi 将文档替换和 op 批次纳入同一撤销时间线；独立 OpLog 提供 op/inverse 操作。2026-10-12 起浏览器编辑接线为 op 流：TS 草稿仍是投影源，但每次提交把前后状态编译为 op 批次（标量 op / 结构 op / 无法命名字段的 remove+insert 对，经增广页伪节点覆盖根层级与页面），经压缩 op 帧编码-解码后 applyOps；整文档替换仅保留给打开/导入。文档级基础字段无 op 表示，以幂等锚点 op 保持时间线对齐。
- 桌面文件为自有 .forma JSON，工作区由 Rust SQLite 保存。浏览器本地持久化（IndexedDB）已走二进制文档格式（format 2 记录，旧 JSON 迁移读）。压缩 op 帧与二进制文档在桌面 .forma/SQLite、云端 API 侧尚未接入；presence/livegraph 仍非统一传输链路或完整多人协作产品入口。
- Facet 投影是既有字段的视图，不是第二份事实来源；`apply_facet` 拒绝 kind 未暴露的 facet。
- 二进制格式语义完全由 serde 定义，格式版本与校验和内嵌，解码失败显式报错。
- 句柄跨 wasm 边界是普通 `u32`；陈旧句柄返回错误而不是空数据。

## 前端

- `src/kernel/graph.ts`：`Graph` RAII 包装（`Symbol.dispose`、句柄校验、facet/ops/tile 类型化助手）。
- `bun scripts/check-graph-api.ts`（`test:graph-api`）：9 项端到端检查（句柄、遍历、facet、op undo/redo、缩放、lz4 帧、二进制文档、瓦片几何、陈旧句柄）。
- `src/kernel/graph-history.ts` 是实际编辑历史入口；API 检查通过不能代表上述每个接口都有 GUI 入口。产品接入清单见 [Electron 验收](../testing/review/design-kernel-electron-adoption-2026-10-12/README.md)。

## 瓦片帧规划（tile-frame）

`frontend/design-client/src/kernel/gpu/tile-frame.ts` 把瓦片寻址开放为画布层的一等模型：

- `planTileFrame(view, zoom, {graph, pad})`：世界矩形 + 缩放 → 2 的幂瓦片级与瓦片集，
  每瓦片给出设备视口、裁剪到可视矩形的 scissor、UV 矩形、tile→world 3×3 矩阵；
  传入 `graph` 时句柄由内核瓦片栈分配（单一事实来源）。
- `planKernelTileFrame` / `releaseTileFrame`：内核背书的规划与句柄回收。
- 一致性验证 `scripts/check-tile-frame.ts`（`test:tile-frame`，浏览器 + 实际 GPU 后端）：
  1. zoom 1 分瓦片合成 == 整帧渲染，逐像素精确；
  2. 任意缩放下每个规划瓦片 == 独立寻址的同尺寸参考渲染，逐像素精确；
  3. 跨视口尺寸的差异作为信息级度量报告——精确层的 AA 采样相位依赖视口尺寸，
     字节级一致只保证在同一尺寸瓦片网格上（这也是全局瓦片网格存在的理由）。

相机语义：`device = world × zoom + view`；显示世界区域 `[V, V+w)` 需要平移 `−V×zoom`。

生产画布目前通过 `kernel/tile-plan-aligned.ts` 调用 Rust `raster_tile_addresses_json`，使用实际倍率和分数设备相位。上文的 2 的幂 level/句柄规划仍是独立 API 与实验验证入口，不能将它的全部 viewport/scissor/clear 策略视为生产画布已采用。
