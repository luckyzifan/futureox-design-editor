# Forma macOS 本地设计器测试用例与验收

更新：2026-10-11。范围：Electron、React 编辑器、Rust 本地后端、SQLite 文档库与同源 Rust/WASM 精确渲染。测试使用独立临时目录、数据库、浏览器配置和端口，不覆盖用户正在运行的应用包。

本轮已接通本机文档正文和历史保存、Mac 命令与字体桥、Figma 风格工作区和精确瓦片合成。完整 Figma 功能、任意 FIG 双向互通和复杂 HDR 性能仍须逐项验收。`ready=true` 只证明启动门禁，不能代替以下业务流程。

用户最新要求的多边形、椭圆、铅笔/画笔和右键菜单对应关系见[画布操作专项验收](design-canvas-interaction-parity.md)。

当前逐项清单和本轮修复见[画布、左右面板、导入导出与精确预览核对](../../testing/review/design-desktop-parity-2026-10-11/README.md)。该记录明确区分当前实测、源码存在、历史证据和功能缺口。

本轮[原生编辑续建与剩余清单](../../testing/review/design-local-completeness-2026-10-11/README.md)记录 schema 7 椭圆圆弧/圆环、多边形圆角、比例锁定、页面管理与复制/数值操作。10 项真实浏览器流程、11 项打包 Electron 检查通过，不能替代其余功能或 Figma 像素验收。

后续 [schema 8 操作与导出记录](../../testing/review/design-local-workflows-2026-10-11/README.md)补充原生端点、图层导出设置、临时父级与系统剪贴板验证；保留完整对齐的未完成范围。

## 不可回退的合同

- 实时预览遵守文档 profile、缩放与设备像素密度，不降低采样、DPR 或精度。
- 画布、命中和编辑叠层对应同一文档版本与视角，过期异步结果不能覆盖新编辑。
- “已保存到本机”只对应 Rust SQLite 已确认的版本。拖动中间态、IME 未提交输入和未知回执不能伪报成功。
- `.forma` 保留完整模型、资源和未知扩展字段；SQLite 内部引用不能泄漏到便携文件。
- 文件、字体与剪贴板只通过限定能力桥访问；画布没有原始路径、Node 或任意 IPC 权限。

## 自动化用例矩阵

每行是一组业务断言；跨层重复执行不累计为独立功能数量。前端测试在 `frontend/design-client/src`，浏览器脚本在同包 `scripts`，Electron 测试在 `frontend/design-desktop/test`，Rust 后端在 `design-studio/crates/design-desktop-backend`。

| 用例组 | 操作和通过条件 | 可执行依据 |
| --- | --- | --- |
| STORE 01 持久保存 | 绘制、重命名、自动保存、结束自有 Rust 进程、重启；ID、正文、资源、hash、revision 完整 | `check-local-workspace.ts`、`workspace-runtime.test.mjs` |
| STORE 02 并发版本 | 旧 revision 提交必须冲突，head 和当前编辑保留；可保存独立副本 | `workspace.rs`、`workspace-session.test.ts` |
| STORE 03 未知回执 | 同一 mutation 重试返回原回执，只有一个版本；不同内容复用被拒绝 | 同上、`desktop-integrity-review.test.ts` |
| STORE 04 暂态编辑 | 拖动中自动/手动保存不入库；取消不留中间版本，提交只保存最终状态 | `workspace-session.test.ts`、`desktop-integrity-review.test.ts` |
| STORE 05 历史与回收站 | UI 恢复创建新 head，原历史不变；更早分页可达；删除再恢复保留正文 | `check-local-workspace.ts`、`workspace-ui.test.tsx`、`workspace.rs` |
| STORE 06 故障 | 损坏/未来库、写失败、资源损坏必须显式报错，保留原库和画布，允许便携紧急导出 | `workspace.rs`、`workspace-session.test.ts` |
| FILE 01 原生往返 | 玻璃、纹理、图片、扩展字段：SQLite → `.forma` → 读取 → 重启，完整 JSON 语义与资源一致 | `workspace-runtime.test.mjs` |
| FILE 02 同 ID 导入 | 已有本机 head 后打开同 ID 文件，导入独立文档；不能覆盖旧 head 或伪报保存 | `desktop-integrity-review.test.ts` |
| FILE 03 外部修改 | 磁盘文件被外部修改后保存，SHA 冲突必须保留外部文件和当前编辑 | `desktop_files.rs`、`sidecar-runtime.test.mjs` |
| SESSION 01 离开保护 | 打开/新建/关闭选择取消、不保存、保存；过期答案不能丢弃期间的新编辑 | `desktop-session.test.ts`、`check-desktop-lifecycle.ts` |
| SESSION 02 保存中输入 | 保存冻结快照后继续修改，回执只确认旧版本，新编辑仍 dirty | 同上 |
| SESSION 03 恢复 | 恢复文件损坏、恢复期间新编辑，均有可解释结果，不能覆盖原始文件 | 同上、`desktop_files.rs` |
| COMMAND 01 焦点 | 画布走编辑事务、文字走原生命令、模态背后的画布不响应快捷键 | `editor-commands.test.ts`、`main.test.mjs` |
| COMMAND 02 异步剪贴板 | 复制失败、读取中换文档/选区、Cut 外部依赖，不删原图层、不写错文档 | `editor-commands.test.ts`、`clipboard-semantics.test.ts` |
| COMMAND 03 语义复制 | 组件/字体/变量/闭合原型/动画共同映射；仿射父级下动画多时刻世界变换保持；单次撤销 | `clipboard-semantics.test.ts`、`design-copy-editor.test.ts` |
| UI 01 工作区 | 1440/1000 CSS px，工具与面板可达、无遮挡，设计/原型上下文正确 | `check-workspace-ui.ts` |
| UI 02 图层树 | Cmd/Shift 多选、F2/双击重命名、多项拖放；保持世界变换，拒绝环，单次撤销 | `workspace-ui.test.tsx`、`layers-rename.test.mjs`、`editor-commands.test.ts` |
| UI 03 多选属性 | 不同值显示“混合”，共同新值更新全部可编辑对象，撤销恢复各自原值 | `workspace-ui.test.tsx` |
| INPUT 01 待呈现输入 | 精确帧尚未完成时，连续绘制、旧位置命中与拖动仍有效；按实际显示的 camera 定位，删除/隐藏/锁定/换页/换文档有围栏 | `check-pending-input.ts`、`displayed-picking.test.ts` |
| INPUT 02 异步边界 | 钢笔稳定顶点续写、自动布局抓取点、新帧悬浮、跨页图片 drop；图片必须实际开始解码后才触发会话变更测试 | `canvas-published-input.test.ts`、`editor-lifecycle.test.tsx`、`check-pending-input.ts` |
| FONT 01 实际字体 | Mac 枚举、读取 TTC 非零面、中文/英文 shaping；独立字体字节和表校验和正确 | 后端 `fonts.rs`、`font_collection.rs` |
| FONT 02 错误边界 | 过大/越界/签名字体集、过期指纹明确拒绝；异步读取不能污染另一文档 | 后端字体测试、字体选择器会话围栏 |
| PIXEL 01 瓦片相位 | SDR/HDR、分数平移缩放、跨块玻璃、缓存往返；RGBA8 与 HDR 原始位零差，完整视口一致提交 | `check-preview-materials.ts`、`gpu_tile_culling.rs` |
| PIXEL 02 精确滤波 | 独立有理数、极值和准入边界；认证快路径位相等，无法证明时回原精确路径 | `check-certified-filter.ts`、`certified_filter.rs` |
| PIXEL 03 精确采样 | Fraction oracle、HDR、微小位移、零/非有限值；三个 GPU 后端零位差 | `check-sampling.ts`、`bounded_sampling.rs` |
| PIXEL 04 局部修改缓存 | 完整编译字节相等才复用；会话/字体/driver 失效、128 MiB 淘汰、全命中取消、复杂效果与资源错误不留旧像素 | `check-exact-tile-cache.ts`、`exact-tile-cache.test.ts`、`client.test.ts` |
| GPU 01 资源回收 | 多 owner mask、祖先 clip、缓存和提交中的纹理不提前 destroy，压力下安全归还 | `mask-lifetime.test.ts`、`coverage-cache.test.ts` |
| MATERIAL 01 参数闭环 | 玻璃深度/折射/色散/光照/磨砂、纹理尺寸/位移/裁剪改变像素，撤销恢复原像素，保存重开保留值 | `check-editor-flows.ts` |
| MATERIAL 02 效果管理 | 阴影/模糊/噪声/玻璃/纹理添加、隐藏、删除同步；GPU 故障明确回 CPU | 同上 |
| HOST 01 隔离 | 真 Electron ready、Rust health、CPU 帧完成；sandbox/contextIsolation/webSecurity 开启，Node integration 关闭，截图留档 | `scripts/smoke.mjs` |
| HOST 02 Mac 生命周期 | Finder 队列等 renderer ready；取消不消费文件；⌘W/Dock/⌘Q 遵守保存门禁；窗口位置可见 | `main.test.mjs`、`window-state.test.mjs`；原生实操另列 |
| PACKAGE 01 产物身份 | 独立 build-tag 打包；ASAR/WASM/sidecar 匹配构建输入，包内桥与真实 Rust 往返通过 | `build.mjs`、`verify-package.mjs` |

格式支持另有 `export-native.test.ts`、`export-regions.test.ts`、`import-fig-layout.test.ts`、`material-import.test.ts`、SVG 和字体测试；有限格式断言不能证明任意 FIG 无损往返。

## 真实 Mac 操作验收

使用独立 `.app --desktop-gui-test` 临时 profile，保留用户原窗口。以最终可见状态和真实持久数据共同验收：

1. 中文名称、绘制、复制/粘贴/撤销、已保存、重启重开；核对名称与节点。
2. 实际中文输入法组合期间保存/换文档，结束后保存；emoji、组合字符、双向文字的光标与撤销。
3. 系统字体面选择，含 TTC 非零面；保存重开与导出核对实际字节和渲染。
4. 原生 Save As/Open、Finder 多文件、取消、最近文件、同 ID 导入；原文件和本机 head 完整。
5. dirty/保存错误/对话框情况下的 ⌘W、Dock 重开、⌘Q；多屏拔出后窗口仍可见。
6. 实体触控板 pinch/平移/惯性、空格拖动、中键和滚轮；1x/2x 屏幕的锚点、叠层和最终帧。

本轮首次独立 Forma Local 已显示 WebGPU 并完成名称保存，随后原生控制服务返回 `Sky Computer Use service startup request failed`。其余原生步骤保持待验；浏览器 composition 事件和合成手势不能代替真实输入法、触控板验收。

2026-10-11 补充：独立 `mac-20261011-precision-03` 包已通过[真实 Electron 鼠标/键盘与 SQLite 验收](../../testing/review/design-desktop-macos-gui-2026-10-10/precision-electron-2026-10-11/README.md)，包括 CPU 9 组与 GPU/HDR 10 组检查。实际修改玻璃宽度后，两笔指针均在新帧未完成时进入并正确保存，200%/DPR2 的 56 个 HDR GPU 瓦片完整呈现，独立 Rust 进程关闭后重读一致；这些通过不替代上列输入法、Finder/Dock、OS 剪贴板和物理触控板验收。

同日精确缓存接入后的 `mac-20261011-cache-02` 包又通过 [CPU 9 组、GPU/HDR 11 组及启动 smoke](../../testing/review/design-desktop-macos-gui-2026-10-10/exact-cache-electron-2026-10-11/README.md)。真实属性栏修改可见星形宽度，64 块中复用 60 块，重算记录 711.7 ms；相机、DPR 2 和原生 HDR 显示不变，最终 SQLite 独立读回一致。前端 660 项测试通过。这里仍没有达到实时帧率，完整功能与外部 Figma 严格像素一致继续保留为未完成。

最新 `mac-20261011-prefix-01` 包包含限定条件下的精确整数前缀滤波及缓存命中的延迟解析，[再次通过 CPU 9 组、GPU/HDR 11 组、17 项包检查和 665 项前端测试](../../testing/review/design-desktop-macos-gui-2026-10-10/exact-prefix-electron-2026-10-11/README.md)。真实 pointerdown/up 对应的 8 个保存几何值完全相等，`1e-9` 门限通过；原生星形宽度修改的精确重算记录为 638.4 ms。受控算法对照中，200% 复杂 HDR 约快 15.45%，仍约 19.65 秒，不代表完整组合应用达到实时帧率。

## 性能门禁

固定机器、构建、fixture、CSS 尺寸、DPR、profile 和色彩空间，分开记录首次编译与热态。记录输入 → 场景 → GPU → 读回/合成 → 完整呈现，不能拿内核耗时代替操作延迟。平移、长拖动、连续缩放、节点拖动、材质编辑分别记录 p50/p95/max、失败帧、过期提交、缓存命中与显存峰值。60 Hz 的16.7 ms/帧是目标，不能改成“最终能显示”。保留失败样本和中间退化。

SQLite 分别记录空资源与大字体/图片多版本的保存延迟、磁盘体积和重启读取，检查同一大资源是否重复存储。性能采样串行占用 GPU，避免并发构建；任何优化都重新通过相关零位差门禁。

## 复现入口

在 `frontend/design-client`：

```sh
bun run typecheck
bun run test
bun run test:desktop-lifecycle
bun run test:workspace-ui
bun run test:local-workspace
FORMA_WORKSPACE_GPU=1 bun run test:local-workspace
bun run test:editor-flows
bun run test:preview-materials
bun run test:canvas-motion
bun scripts/check-sampling.ts
bun scripts/check-certified-filter.ts
```

在项目根目录：

```sh
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --lib --tests
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-desktop-backend
bun --cwd frontend/design-desktop run test
python3 scripts/check-foundation.py
```

实际 Mac 字体用例按后端显式 opt-in 运行，普通跨平台测试不假装拥有 Mac 字体。`CORE_DESKTOP_SIDECAR` 必须指向本轮真实二进制。普通 `bun run test` 不自动涵盖浏览器、Rust、原生 GPU 和系统 GUI 全部旅程。

新包在 `frontend/design-desktop` 使用独立目录，避免覆盖正在运行的 Mach-O；已经启动后再次构建须换 build-tag：

```sh
node scripts/build.mjs --release
node scripts/package.mjs --local --build-tag=mac-20261010-final
node scripts/verify-package.mjs --local --build-tag=mac-20261010-final
```

官方 Electron ZIP 本地缓存的使用方法见桌面 README。

## 剩余完整对齐范围

尚无 FIG 导出器，FIG 导入有明确语义边界，JPEG/PDF 全流程未齐；高级 Smart Animate、交互组件和完整文字排版仍有差距。标签页目前在会话内管理，重启恢复最近更新文档，尚未恢复所有标签和各自视角。内核互相一致不能代替外部 Figma 对照。

此前根级检查的 bastion route/action 集合漂移已在 `e8379d25` 修复并推送；本轮总检查退出 0。具体路由、资源范围和独占数据库测试见 [Bastion 验收](../../testing/review/bastion-route-contract-2026-10-10/README.md)，不能外推为全部 77 条路由的运行验收。签名、公证、Windows/Linux GUI、多屏和长期运行没有本轮通过证据。

相关：[现行桌面契约](design-desktop.md)、[实施前分析](design-macos-local-parity.md)、[后端接口](../../design-studio/crates/design-desktop-backend/README.md)。


2026-10-11 HDR 后续：真实 Metal 基准、25 帧跨候选位哈希对照、采用的颜色通道/alpha 精确采样和 Figma 控制连接边界，见[专题记录](../../testing/review/design-hdr-profiling-2026-10-11/README.md)。热运行改善不代表冷启动或完整 Figma 性能通过。
