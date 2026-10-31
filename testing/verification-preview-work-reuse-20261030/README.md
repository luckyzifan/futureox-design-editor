# 预览与交互规划复用核对

本轮始于 2026-10-30，验证完成于 2026-10-31（Asia/Shanghai）。这是已应用到工作区的限定范围源码优化，没有打包、发布或替换光栅算法。前置为 `baseline.json` 记录的工作区，包含此前未提交的 interactionScene 借用及导航实验。

## 对原判断的核对

| 判断 | 当前源码结论 |
| --- | --- |
| 同时构建 retained SVG、位图、split SVG | 成立。旧组件在隐藏时也构建两种 SVG 计划；位图满足捕获条件时还会复制。GPU 路径能覆盖后组件原本就会卸载，不能说三种策略始终同时工作。 |
| 相机变化重复复制画面 | 成立，但仅限满足捕获条件、区域完整且预算足够时。`drawImage` 是真实像素复制；没有重新光栅不等于免费，也不保证没有设备同步。 |
| 交互规划完全没有复用 Canvas 场景 | 已过时。开始本轮时工作区已通过 `CanvasSceneBorrow` 复用场景；父表、分层、效果检查及 bounds 仍会重复。根独立性与隔离根内部未知效果检查承担不同语义，不能简单删去后者。 |
| 导航和交互一定重复捕获同一视口 | 只能确认有竞争机会，不能说每次发生。已有私有取消、最新 pending 覆盖、共享客户端及 released-gesture handoff；导航静默等待仍是 `VITE_DESIGN_NAVIGATION_CAPTURE_PRIORITY=1` 实验。完整请求所有权重构本轮未做，实验开关未改。 |
| 合成过滤、排序和覆盖重复 | 源码确认这些计算仍存在；没有本轮整帧 profile 证明它们是主要瓶颈。透明洞、历史补洞、采样相位与 GPU 完成边界全部保留，未修改合成覆盖逻辑。 |

`client.ts` 的同快照序列化复用、`SourceViewportPlanner` 的移动/静止 key 复用以及 `compositeDrawPlan` 历史补洞规则都已存在，本轮未重复实现。

开源比较的方向合理，但需限定版本和证据：

- 本项目 `area.wgsl` 同时有固定四采样分支和解析覆盖分支，不能把全部渲染概括成只有四采样；已有小区间扫描、二分和端点快速判断。
- 原来的计算着色器 Vello 确实采用分桶、粗细光栅。但当前上游还区分 Sparse Strips 的 `vello_cpu` / `vello_gpu` 与计算着色器研究实现；`vello_gpu` 使用 CPU 前处理和 GPU 顶点/片段渲染，不能把整个项目概括为纯 GPU compute。[官方架构](https://github.com/linebender/vello/blob/main/ARCHITECTURE.md)
- 本地 `../desigma/crates/desigma-gpu` 的 README、mesh.rs、frame.rs、exec.rs 确认 Lyon、4x MSAA、Frame/Program/Op/Execute、几何与结果缓存。结构值得借鉴，未做同源场景的跨渲染器性能竞赛。
- Skia 的跨硬件/软件后端、生产使用与测试工程有官方依据；本轮没有逐项审计双方字形图集、批绘和所有设备路径，不能据此宣称本项目这些能力全部缺失。[官方文档](https://skia.org/docs/)、[设计文档](https://skia.org/docs/dev/design/)
- f64、HDR、采样和导出是本项目必须保持的契约；没有跨渲染器同输入测量就不能将其写成普遍的精度或速度优势。先减重复工作，再决定是否改光栅算法，仍是合理顺序。

## 实际改动

1. Canvas 已有 GPU 覆盖时跳过 SVG 支持性遍历。否则把绑定 document/page 的支持结果交给 retained SVG；其它快照或页面仍重新校验。拖动中当前文档的变化不使不可变 base SVG 计划重建。
2. retained SVG 是首选时不准备位图。split SVG 仅在实际显示的编辑需要它时建立，不再隐藏预热两份派生文档。
3. 位图在精确呈现与相机稳定 150 ms 后捕获。新呈现、相机、DPR、尺寸、页面、会话或卸载撤销旧计时器；捕获前匹配 document/page/epoch/view/size/DPR，旧 bitmap 不能借新的呈现身份继续使用。该等待只影响可选预热，首个即时手势仍可走既有渲染回退。
4. 位图结构规划可借用已发布场景。交互根选择不建全文档 parent Map；嵌套选择在有效借用时使用现有祖先链。一次场景遍历完成未知效果检查和各绘制区间的 bounds 汇总，保留原始 padded-edge/union 浮点运算。
5. 每个 InteractionRenderer 最多缓存一份结构计划，包括拒绝结果；有效 Canvas 借用及 document/page/session/selection/policy 全部匹配才复用。相机变化只裁切静止区间，移动对象保持完整。借用撤销、未知/可变调用者仍重新计算，销毁清除计划，不另存场景条目或增加 GPU owner。

## 证据

环境：macOS 26.3 / 25D125，Node 24.12.0，Vitest 5.0.1，Chromium 153.0.8010.12。TS 使用已有 portable WASM；本轮没有 Rust、WGSL、采样、HDR、导出、文档格式或预算修改。源码与 WASM 身份见 `runtime-sources.json`，新旧文件及证据 hash 见 `manifest.json`。

| 验证 | 结果与范围 |
| --- | --- |
| `combined-tests-final.log` | 13 个 Vitest 文件，238 项通过。真实 Editor/WASM 的 CPU 测试与明确 mock 的渲染调度测试分别保留原边界。 |
| `component-tests-final.log` | 28 项 Node 测试通过；包含未使用计划不构建、连续相机不复制、DPR/呈现失效和整数像素规则。组件/捕获双桩不代表 GPU 像素。 |
| `typecheck-final-source.log` | TypeScript 检查，退出码 0。 |
| `component-negative.log` | 同一组件断言载入冻结旧实现，4 项预期失败，其余 10 项通过；失败包括 SVG 仍捕获、导航逐次复制、旧呈现仍被捕获。没有通过依赖缺失制造负对照。 |
| `planner-results.json` | 160 个固定生成场景 × 8 个视口 × fresh/cached 两条路径，共 2,560 次与旧实现逐值比较通过；包含层序、边界、父矩阵、阴影、隔离/直通、隐藏和未知效果拒绝。 |
| `browser-results.json` | 真实 React、SVG、Canvas2D 和 Chromium 截图。30 次连续平移，旧实现 60 次 drawImage，新实现 0 次；停稳后新实现 2 次复制。两者移动后 PNG 字节一致，简单 SVG 与位图的移动截图也一致。GPU/全编辑器验收未执行。 |

CPU 微基准使用实际规划函数及发布场景，固定 16 个选中根、每轮 20 个视口、1 轮预热及 7 轮交替 A/B。场景建立不计入两个版本的规划计时；首次结构建立单列。单位为单次调用中位毫秒，原始每轮结果全部保留。

| 合成矢量节点 | 旧规划 | 新结构首次建立 | 新结构复用，仅裁切 |
| ---: | ---: | ---: | ---: |
| 300 | 0.501 | 0.380 | 0.00241 |
| 3,000 | 3.466 | 1.312 | 0.00156 |
| 20,000 | 29.726 | 10.163 | 0.00167 |

这只是 CPU isolated 规划计时，既不是启动时间，也不是渲染帧时间。计时阶段本任务没有并行重构建/重测试；其他进程负载没有完全控制，因此不据此通过 G4 真实生产性能门。三个规模并不等于执行了 G5 的完整动作/效果/导出矩阵。

首次失败与修正均有日志：默认 Node 26 不再接受旧测试加载器的 transform 选项，改用已安装 Node 24；字体测试使用现有 `/tmp/futureox-font-tests-20261030` 的固定依赖；密度调度测试显式模拟的新 Planner 边界替代旧函数边界，九项原断言未降低。浏览器脚本先遇到本机监听沙箱限制，再修正 Playwright 的 CommonJS 导入；获准本机运行后最终通过。没有安装新依赖或修改全局运行时。

## 验收边界与复现

- G2：限定浏览器预览对照通过；真实全编辑器连续导航、选择框同帧及 visible P95 为 NOT_RUN。
- G3：结构逐值、采样规则及限定截图对照通过；完整 HDR/导出/持久化矩阵为 NOT_RUN，没有把未修改等同于重新验证。
- G4：上述 CPU isolated 实测；REAL117 及整帧 profile 为 NOT_RUN。
- G5：六格完整交互、REAL117、十份导入、600 张图标导出均 NOT_RUN。
- G6/G7：本轮基线、负对照、来源和限定取消/晚回/借用撤销测试具备证据；完整硬件压力与设备丢失矩阵 NOT_RUN。

工作区中另有并行产生的 GPU 文件改动，它们不在本轮改动清单内，也不归入本轮性能结论。原本未提交的 ProgressiveSurface、导航实验和 interaction-renderer 测试改动同样保留。

在仓库根目录执行：

```sh
/Users/Apple/.nvm/versions/node/v24.12.0/bin/node testing/verification-preview-work-reuse-20261030/verify-runtime.mjs
python3 testing/verification-preview-work-reuse-20261030/negative-control.py
```

浏览器测试需要本机监听权限；仅重跑浏览器可加 `--browser-only`。Node 组件测试的完整命令见 `commands.json`，Vitest 运行使用已有字体 Python 和 `--maxWorkers=1`。GUI截图、CPU微基准和功能测试应分开运行。

源码已经在工作区生效，无需再次应用补丁。`changes.patch` 仅含本轮相对开始工作区的修改。需要回滚时，先逐文件核对 `manifest.json` 的新 hash，再恢复对应 `before/` 文件；若 hash 已变化，先合并用户后续改动，不整库 reset，不覆盖其它 GPU/交互工作。没有发布包，也不声称完整渲染体验已验收。
