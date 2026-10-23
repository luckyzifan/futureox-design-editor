# 拓扑素材本地修复验证（2026-10-23 → 24）

针对这份拓扑素材的本地修复、真实 GUI/导出重开、硬件像素和分段火焰图已完成；通过范围见下表，不代表全应用/物理性能验收。本轮未执行提交/推送，没有停止其他任务进程。原始下载文件只读。说明和修改决策见 [修复文档](../../docs/TOPOLOGY_RENDERING_REPAIR_20261023.zh-CN.md)。


## 最终结果

- [source-gui-5.json](source-gui-5.json)：独立、可见 Electron；三个指定画板均真实 WebGPU 呈现、重命名、撤销/重做、保存、完整导出，并在新进程重开确认修改。
- [归档核对](source-gui-5-archive.json)：64 成员全保留、63 成员逐字节相同。唯一变化页面删除恰好三处预期名称后缀后，整成员 SHA-256 与原件相同；并非仅检查成员数量。原下载文件 SHA-256 未变。
- [最终分段火焰图](flames-candidate/flamegraphs.html)：导入、50/100/400/3200% 缩放、实例宽度 100→120、undo、redo、24 次正反滚轮。尺寸编辑/历史和所有缩放均完成；脚本最后实际保存到本机。
- [无采样重放](controls-no-sampler-summary.json)：同一候选与操作，关闭 CPU sampler 和同步 PNG 捕获。14 个 frame-window、uiStalls 0、最大 UI 间隔 215.2 ms；Editor 尺寸提交 126 ms。该轮完整属性操作 wall 706.6 ms 包含异步渲染等待；不能将 126 ms 说成输入到像素。
- [最终硬件像素](pixels-final.json)：WebGPU/WebGL2 12 项色标对照、分块字段 1,228,800 float words、取消负对照全部通过；身份为 [pixels-final-identity.json](pixels-final-identity.json)。最终前端组合 6 文件 39 项通过，见 `combined-final-tests.log`。
- [最终原生增量探针](native-probe-final.json)：同视口修改后新增程序构建 0 / 命中 149 / 保留节点 544，包 SHA-256 仍为 `3ba5e0a2f644dc4ce289dae3c2136851ea88f4e1d410e112a0ae507f267b9c91`。
- 最终 desktop/WASM/native 构建：`desktop-build-final-confirmed.log`；最终 dense 缓存回归 4 项：`dense-final-tests.log`。共享工作区源清单为 `final-source-manifest.json`，最终 GUI 加载身份为 `candidate-verified-runtime-identity.json`。

采样加截图版本出现一次 623.7 ms 的 UI 间隔，保留在 `controls-final-summary.json`，没有删除或当作通过。关闭这些观测动作后未复现；两次运行仍受其他构建活动影响，因此不能单凭这两轮断言停顿全部由探针导致，更不能报全局速度提升倍数。分段火焰图显示属性窗口主线程活动 CPU 363.340 ms、Worker 324.225 ms；连续滚轮窗口分别为 177.684 / 241.391 ms。Worker idle 不是 GPU 时间，未解析 WASM 索引仍不猜函数名。

`source-gui-5` 的两次采集器退出等待超过 15 秒；它在完整导出/重开记录落盘后只终止自有 Electron。正常退出协议不包含在本次通过声明中，也未将强制结束测试进程算成退出功能通过。源文件保存、导出和新进程重开已分别证明。

## 固定输入和环境

- 原 Sketch：118,272,240 字节，64 ZIP 成员；SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。
- “控件”：773 authored / 953 resolved 节点；不是先前误归属的 4,022 节点投影。实际问题大画板 `1:5` 为 4,022 节点；另两块 `1:32480`、`1:81474` 各 7,662 节点、36 色标。
- macOS arm64、实际 Electron 44.7.0；独立复制的 host/native/WASM/JS，独立 TMPDIR/profile。运行身份在 `*-identity.json`，初始源身份在 `baseline-manifest.json`。
- GPU 预算、四采样、现有屏幕数学、HDR/export 精度不变。未启用 exact whole tent、managed mode12、empty compose、adaptive density 等未验实验。
- 机器存在其他任务。本轮没有控制它们。采样、编译与 GUI 阶段时间是诊断数据，不能直接当作干净 A/B、物理输入延迟或稳定 FPS。
- 本轮初始 HEAD 为 `c65ed47`；期间其他任务在共享 checkout 提交 `3a264ae`。当前组合候选包含那些源变化，不能把总体时间差全部归因于本轮。

## 已取得的证据

| 检查 | 结果 / 范围 | 文件 |
| --- | --- | --- |
| 真实基线 CDP 火焰图 | 主线程 + render-worker；按实际 JS/source-map hash 解码；WASM 未解析索引保留 | [火焰图](flames-baseline/flamegraphs.html)、[摘要](flames-baseline/summary.json) |
| 原生同视口增量探针 | 视口外实例改宽；149 程序由全重建变为全部复用；保留 544 节点，输出包字节相同 | [结果](native-probe-after.json)；旧结果在 `../analysis-topology-render-causes-20261023/native-probe.json` |
| Rust 派生 delta | 3 项：依赖范围与完整解析一致、无关实例不变、陈旧 receipt/非法 patch 原子拒绝 | `component-update-tests.log` |
| Editor/WASM 与相关前端 | 5 文件 74 项；真实 WASM、连续提交/undo/redo/分支，源保存与参数表 | `incremental-client-tests.log` |
| camera prepare | 可见修改与 fresh Engine 输出相同；视口外包相同、程序命中、拓扑 Arc 保留 | `camera-retention-tests.log` |
| Boolean cache / dense | 4 项，几何键 exact、材质修改复用、dense guard、原操作数保留 | `boolean-tests-final.log` |
| 36/64/65 色标与区域字段 | 36/64 保留、65 拒绝；区域字段使用原始采样域 | `gradient-kernel-valid-colors.log` |
| 实际 WebGPU + WebGL2 像素 | 32/36/64 stops × linear/radial × 两后端，12 项，每项 6,144 个 float words 与 Rust 逐位相同；含 HDR/负 RGB/alpha/重复 offset | [结果](pixels-2.json)、`pixels-2-identity.json` |
| 大渐变分块 / 取消 | 1,228,800 个 float words 与整块路径逐位相同；首次 yield 取消时整块上传 4、新路径上传 0；取消都成功 | `pixels-2.json`；它不是物理拖动延迟测试 |
| 诊断 allowlist | 26 项通过；本地少一次扫描，接收端仍完整过滤 | `diagnostics-tests.log` |
| 生成 shader | 两个生成器生成与 `--check` 均通过；实际 WebGL 编译已过 | `glsl-generation-complete.log`、`pixels-2.json` |
| flo_curves 全序修复 | 原 native panic / WASM unreachable 已复现；缩减至 3 操作数，旧冻结 native 必现。109 个上游单元测试通过，四种 Boolean 与独立 winding oracle 一致 | `source-native-panic.log`、`boolean-panic-isolation.json`、`boolean-panic-reduction.log`、`flo-curves-standalone-tests.log`、`boolean-ray-regression.log` |
| 36 色标完整场景准备 | 更新 WASM 后，两块实际 7,662 节点素材均完成准备 | `source-preparation-after.log` |
| 精确空间回退 | 32 项通过；场景总几何量超限可分区、单路径错误不分区、设备丢失/取消不吞掉；原 2,000,000 段上限不变 | `spatial-recovery-tests.log` |
| 实际区域 native 编译 | 36 色标真实素材 256×256 成功，618 程序 / 4,045 prepared 节点；使用和桌面一致的文档准入策略 | `source-region-policy.log` |
| 真实 dense Boolean 精度 | 修复前 436/1,763 填充偏差；更细 dense 工作容差后 1,763 点零差、排除边界 0、原操作数不变，输出 28,729 曲线命令 | `native-final-tests.log`（失败保留）、`dense-precision-oracle.log`（新通过） |
| 源导航晚回与 Editor 回归 | 4 文件 7 项，含过期可点击行清除、receipt delta、undo/redo 和参数表 | `frontend-final-tests.log` |
| 完整构建与类型检查 | WASM/native/renderer 重新构建成功；之后空间回退 TS 检查通过 | `desktop-build-ray-order.log`、`typecheck-spatial.log` |

## 保留的失败与修复轨迹

1. 首次独立 host 缺少 branding assets、启动页没有画布却等待 ready；修正采集脚本后才采到有效基线，原失败日志保留。
2. `candidate-edit` 搜索了展开前实例名；展开后名称为“地球”。失败 CPU profiles 保留，不能标为编辑通过。
3. `pixels-1` 的 WebGPU 通过、WebGL 因生成 GLSL 缺少 int materialSelect / channel-alpha helper 失败；修正共享生成后 `pixels-2` 两后端通过。
4. `source-gui-1`：大画板已呈现、重命名成功，真实鼠标撤销被 SVG 遮挡。修正工具条 z-index，未使用 force click。
5. `source-gui-2`：大画板渲染/rename/undo/redo/save 通过；下一素材 WASM unreachable。追到 flo_curves 排序比较器并修复，见 vendored `PATCHES.md`。
6. `source-gui-3`：36 色标素材通过准备，渲染阶段出现 `Scene path budget exceeded`。同素材小区域实际成功；增加分类明确的精确分区回退，撤回可选的相机范围 prepare guard。
7. 初次原生小区域探针未指定桌面文档策略，自动准入额度较低而拒绝；`source-region-policy.log` 才是匹配桌面策略后的运行。没有提高 GPU 预算。
8. 一次 `sample` 尝试遇到本轮原生子进程已经结束，没有取得采样；`source-native-sample.log` 是失败记录，不能当成 native 火焰图。
9. 失败 GUI 的关闭请求可能被未完成源会话 veto。采集器记录超时后只结束它自己启动的 Electron PID；其他任务的独立 Electron 保持运行。三个失败 run 的缓存已在进程结束后清理，截图和日志保留于原输出目录，清单为 `owned-profile-cleanup-20261024.json`。

## 可复现入口

- `freeze-host.mjs NEW_NAME`：复制当前构建及 host，独立 Vite 构建并写身份。
- `check-source-gui.mjs NEW_RUN OWNED_HOST`：真实原 Sketch 导入 → 三个画板 → rename/undo/redo → save → 完整导出 → 独立重开；仅 preset 保存对话框目的地，真实 renderer/native I/O 不替换。`SOURCE_GUI_VISIBLE=1` 保持独立窗口可见。
- `verify-export.py RUN`：按流核对所有 64 个成员、预期 63 个不变、原始 SHA 未改。
- `run-profile.mjs NEW_RUN OWNED_HOST`：同一控件 fixture 的真实 Electron；`DESIGN_PROFILE_EDIT=1`、`DESIGN_PROFILE_SEGMENTS=1` 分别采集导入、缩放、属性、撤销重做、连续滚动。
- `package-profiles.mjs RUN_DIR OWNED_HOST PREFIX STAGES...` 与 `analyze-flames.mjs`：只转换实际 CDP profiles，绑定对应 JS/maps。
- `native-final-tests.log`：scoped Rust tests 通过；其最后的真实 dense Boolean oracle 失败。`dense-precision-oracle.log` 是后续精度修复的新通过证据，不覆盖旧失败。

## 不作出的结论

单元/CPU 通过不等于全应用完成。WebGPU/WebGL 像素通过不等于 Rust 原生 GPU compositor 或物理屏幕通过。G2 活跃窗口 uiStalls、117/十份样本、完整六格规模矩阵、跨平台和物理输入到屏幕仍需分别验收。不存在“所有阶段已完全增量化”的声明：全局准入、历史验证及未证明安全的依赖仍保留完整路径。


后续追踪：`source-gui-4` 中大画板和第一块 36 色标素材均实际渲染、编辑、撤销重做、保存成功；切换另一块同名素材时测试点中了旧搜索结果。它不计作三块整体通过。已修正晚回行为与按源 key 定位，并保留该轮失败。另一次真实 dense Boolean oracle 揭示仅能显示的粗容差候选不正确，现已修复并以同一 oracle 重跑通过；见上表，不能用早期截图代替新的完整验收。


退出补测：整份 Sketch 的补测 `source-close.json` 在打开时因磁盘空间不足失败，不能算关闭失败或通过。随后同一 SourceWorkspace/父窗口退出路径使用 65 MiB 空白前缀加有效控件 JSON、先保存父文档进行独立 GUI 对照：旧实现 `source-close-baseline-parent.json` 正常退出约 557 ms，额外释放阻挡的实验 `source-close-saved-parent.json` 约 585 ms，两者均未结束进程来绕过关闭。该额外关闭改动没有被证明为必要，已从最终源撤回；`source-close-tests.log` 的第三个实验测试也未留在最终源。无已保存父文档条件的早期超时仍保留，不能把它们确定归因到渲染或关闭逻辑。本轮完整 Sketch 的数据/GUI 通过声明仍以 `source-gui-5` 和归档核对为准。
