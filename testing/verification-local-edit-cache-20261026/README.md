# 局部材质失效与重复绘制优化（2026-10-26）

本轮运行时只修改 Rust `dirty_region.rs` 与 `renderer.rs`。基线是 `39ff10be` 加开始时已有工作区修改；原桌面构建有 9 个输入与源码不一致，因此先从冻结工作树重建了基线。`baseline.json`、`candidate.json`、`frozen-artifacts.json` 绑定源码与实际二进制；主目录只按前置 hash 应用本轮文件，见 `integration.json`。

## 改动及保守边界

1. **布局后的材质脏区**：复用既有 `retainable_paint_changes` 的严格字段证明。只有几何、效果支持域、布局与光学隔离不变时，才用当前已经解析的场景计算脏区；不会拿自动布局前的 authored 坐标替代实际位置，也不会额外克隆整份解析文档。证明与脏区只计算一次。
2. **嵌套蒙版**：材质变化使蒙版消费容器失效，而非整页。原有祖先效果、蒙版消费者与背景模糊传播仍参与范围计算。没有消费容器的页面根蒙版、结构/几何/效果范围变化继续保守处理。
3. **页面和隔离范围**：背景读依赖只考虑能读到本次编辑的页面或最近隔离祖先。无关页/容器中的玻璃不再使局部修改全量失效；无关页的背景模糊也不消耗当前依赖候选上限。祖先改动、新建立的读取关系、同范围未知玻璃读取仍保留 full。

这沿用 Sketch 的特征差异驱动失效、Figma 的依赖范围传播思路，没有复制其光栅算法。没有改变数学精度、采样、HDR/导出、效果、工作集预算、实验开关、receipt/CAS 或 GPU 完成边界。减少的是不必要的失效及后续绘制。

## 真实文件结果

使用独立 Electron profile，通过实际生产导入、Inspector 透明度输入和 Editor 事务执行。相机按各文件原工作集适配并在每对中保持一致，实际值见各 `report.json`；并非完整 G2 原生拖动链。诊断为 detail，未启用 CPU profiler。计时为 UI 属性输入开始到既有精确内容就绪检查，含测试等待开销，不是物理输入到光子或 GPU timestamp。

| 场景 | 基线 | 候选 | 结论 |
| --- | --- | --- | --- |
| FIG，01_Dashboard 的 36×36 alpha 蒙版 | 每次 20 块、2,825 draw calls | 每次 1 块、163 draw calls | 减少 95% 瓦片与约 94.2% draw calls |
| FIG，两组无编译干扰配对、各四次编辑 | 中位 1380.5 ms | 中位 641 ms | 约降低 53.6%；对应 pair-fig-2/3，8 次/版本 |
| 117，显示原有隐藏大蒙版后编辑 | 每次 20 块；首对中位 918.5 ms | 每次 10 块；首对中位 929 ms | 绘制量减少，但没有端到端加速结论 |
| 拓扑素材，真实工作集 1:5 的叶蒙版 | 每次 25 块 | 每次 1 块 | 内容 QA 已验证；不把 QA 的计时当性能样本 |

FIG 和 117 上述有效配对的观测窗口均没有 >250 ms UI 回调停顿或渲染失败。其他运行中出现外部 Cargo/rustc，原样记录在 competition 字段并排除性能结论；不能把受干扰的更慢基线用于放大收益。部分早期检查曾提前读取旧 ready，后续脚本要求实际 canvas damage 和新 requestedRevision；该短样本不计性能。

### 像素与数据

- `content-pixels.json`：FIG、117 各初始画面与四次修改，基线/候选 RGBA 全通道零差异。
- `topology-content-pixels.json`：拓扑工作集同五张图全通道零差异。此叶蒙版透明度在该导入场景中没有可见内容变化，作为冗余失效案例，不冒充对象运动延迟。
- 内容截图阶段取消选择、隐藏 DOM 悬停/工具栏/滚动条等叠层，再选回同一节点，不改文档相机或采样。截图不计性能；`screenshotRequests` 保留额外准备/预取工作。先前带选框或悬停轮廓的失配保留在 `paired-pixels-initial.json`、`fig-clean-pixels.json` 与 `pixel-investigation/`，不能把原失配改成通过。
- FIG、117 的非零蒙版透明度修改完成撤销/重做、保存、导出 FD、新建设计后重开核对。拓扑叶蒙版保存有**冻结基线已经存在**的 `Source field blend requires a dedicated structural transaction` 拒绝；本轮没有改变该存储边界。撤销本轮叶修改后，以原有根对象非零透明度修改验证完整源保存/导出/重开，基线与候选都通过。
- `source-export-integrity.json`：两份拓扑完整导出 SHA-256 相同，64 个归档成员中 63 个与原件内容一致，只有预期页面发生变化。下载原件保持只读。

## 正确性与构建检查

- 旧实现负对照：`old-damage-tests-2.log` 在 propagation-chain / glass-effect 的目标断言失败；`old-mask-tests.log` 在 masked-chain 的目标断言失败。最早夹具缺少色彩管理的失败另留存，不当作负对照。
- `float-damage-final-2.log`：9 个新增 Native 生产 Engine 用例通过，包括解析布局坐标、蒙版消费者范围、同范围玻璃拒绝、新光学依赖、页面根蒙版、513 个无关页背景模糊，以及 HDR/负值浮点逐位完整重绘对照。首个 HDR fixture 的透明合成结果并不会产生负值，修正输入后验证，原失败保留。
- `dirty-region-regressions.log`：42 个原有脏区测试通过。
- `retention-regressions.log`：23 个缓存保留回归通过，1 项原有 ignored，不计通过。
- `candidate-wasm-check.json`：实际生成 WASM 的布局材质和嵌套蒙版两例，增量结果与重新载入后的 f32 输出逐位一致。
- `build-commands.json`：候选完整 `bun run build --fast` 成功，包含 WASM、TypeScript、前端以及三个原生二进制。
- 主目录组合构建、9 项定向测试与实际 WASM 结果由 `main-validation.json`、`main-local-tests.log`、`main-wasm.log` 记录。组合来源保留了其他任务对 `interop.rs` 的后续更新，不能把冻结候选的结果冒充所有后续源码均已验收。

## 主工作区最终复核

主目录完整构建成功，`main-build-identity.json` 核对 2232 个构建输入一致；主目录新增 9 项测试和实际 WASM 两例再次通过。最终三个独立主构建实例均完成四次属性修改、实际 Editor 撤销/重做及非零修改保存/导出/重开，见 `final-main-gui-guarded.json` 和 `final-summary.json`。其中拓扑保存仍限定为上述原有根对象范围。

`main-content-pixels.json` 的三文件共 15 张主构建/已验证候选内容图全通道零差异。主目录的拓扑完整导出与冻结基线/候选导出 SHA-256 相同。三个下载原件 hash 均未变化。

最终 GUI 的早期一轮在测试脚本没有删除操作的情况下观察到节点被删除，未计通过。后续仅在本轮独立测试窗口隔离非脚本键盘输入，再完整重跑；没有修改产品输入处理。另修正了 Inspector 文本焦点截获撤销、虚拟图层列表滚动后旧 DOM 尚未更新等测试同步问题；失败日志保留。主组合 GUI 用于功能与像素验收，不加入上表性能数据。

## 范围与回滚

这解决有精确材质证明的局部失效，不是所有拓扑、布局、组件或重效果变化都已增量化；也不关闭快速缩放、持续对象跟随、完整 G2/G5、跨平台或 HDR/export 全矩阵。原件和用户已有窗口不被覆盖/重启。

`integration.json` 列出实际修改的前后 hash，`before/` 保存应用前文件。回滚必须先确认当前文件仍等于本轮 after hash，再恢复对应 before；新增测试仅在内容仍匹配时删除，不能覆盖后续用户修改。运行 `wasm-check.mjs <仓库绝对路径>` 可复查实际生成 WASM；真实 GUI 入口为 `local-edit.mjs`、`pixel-qa.mjs`，需使用 `runtime.json` 中冻结 host 或当前完整桌面构建。固定样本及原件 hash 见 `baseline.json`。
