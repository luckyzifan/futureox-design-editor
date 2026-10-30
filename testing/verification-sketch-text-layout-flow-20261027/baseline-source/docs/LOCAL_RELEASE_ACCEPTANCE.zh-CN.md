# 本地设计器：验收与增量交付边界

历史验收记录曾以 `71d32153e6f55b3723c99708b4c4c49ac7342e67` 为源码基准；该标记不代表当前源码或已完成验收。本次功能包合并在 `2e5db09e10011dbe2603046341b72a14b0b43d27` 上保留新版渲染代码，具体前后像见[本轮整合记录](../testing/verification-functional-merge-20261021/README.md)。后续性能改动遵循[当前开发契约](DEVELOPMENT_CONTRACT_V1.md)，不得以旧包覆盖已接受的画质、编辑和撤销行为。

## 本轮范围

- 本地编辑器、画布操作、上下文菜单和可切换快捷键。
- Web 与 Electron 的输入响应、缩放/拖动/高清补齐调度。
- 共享设计操作 API、MCP、本地授权、SQLite 操作记录及已有版本恢复入口。
- 结构化 `.fd`、JSON、HTML/CSS、SVG 与字体/素材依赖。
- Figma/Sketch 的本地能力对照。协作服务、云发布和账户系统不在本轮实施范围。

## 测试证据必须区分

1. 真实 Rust/WASM/编辑器测试：调用生产实现，检查文档、版本、历史、导出字节和错误行为。
2. DOM 测试：验证组件事件、控件状态、预览隔离和文件操作。jsdom 不执行真实浏览器布局，也不能证明视觉美观或 GPU 效果。
3. 内存流 MCP 测试：运行实际 JSON-RPC/工具分发和真实编辑器。它不等价于本地 socket、Electron 安装包或第三方 AI 客户端兼容性验收。
4. SQLite 集成：运行实际 Rust sidecar 和数据库，验证迁移、重启、过滤、容量及失败回滚。
5. 真机检查：macOS/Windows/Linux 的窗口、键盘、字体、剪贴板、通信和安装包分别验收。没有实机执行的项必须保留“未验证”。
6. GPU 验收：实际浏览器/桌面硬件帧率、像素差、显存和复杂文档耗时，不能由 CPU 合成场景或调度模型替代。

早期云环境曾拒绝 socket 监听，该记录不代表本地 macOS 当前结果。真实 socket 测试应在获授权、受支持的环境执行；遇到权限拒绝不得绕过，失败/受阻需显式显示。内存流通过不能替代它。历史私有样例缺失时必须 skip 或在必需样例模式下失败，不允许直接 return 冒充通过。

## 性能验收

分别报告输入到状态更新、高清任务准入、准备/编译、编码、发布耗时。记录节点数、视口、DPR、缩放、硬件、构建模式和冷/热状态。接口的时间不代表真实 FPS；缩短静止等待不等于像素生成速度提升。性能测试需同时检查最终相机/版本/画质选项一致、最新请求优先、取消资源释放及旧结果不发布。

旧导入器检查点 `final-safe-default-*` 的实际 117/FIG 编辑、完整文档撤销、24 张静态画布及选区 PNG 对照通过；这些旧画面与旧基线一致，不覆盖随后新增的曲线控制柄和 composite 缓存修复，也不能证明原导入几何正确。该检查点的连续快速缩放清晰度门槛仍未通过。更早 Rust workspace 的 **1,400 个实际执行通过**、一个未执行私有 FD 样例及 36 个 ignored 同属历史范围，不能当成新导入器的回归结论。

当前新增证据为：原始 117 新导入的 575 条路径在锚点、有效控制柄和拓扑对照中均零错误；一条原始小圆的真实 WebGPU 圆度最大误差为 **0.875 物理像素**，旧缺柄 network 负对照为 **68.875 px**，详见[控制柄证据](../testing/verification-complex-navigation-20261021/README.md)和[数值汇总](../testing/verification-complex-navigation-20261021/curves-summary.json)。composite 缓存保护的受控多密度、部分平移及缓存压力测试为 **142/142 通过**，类型检查通过，见[缓存回归范围](../testing/verification-functional-merge-20261021/cache-visible-use-summary.json)；不能由此认定真实白块根因已经修复。包含这些修改的最新默认构建已完成两文件编辑/完整文档撤销、三档 UI 选区 PNG 导出及八次零新增渲染/零缺失纹理的同相机重访，见[实机回归](../testing/verification-complex-navigation-20261021/REGRESSION-RESULTS.md)。

最新 `final-cpu-final-complex-v2` 已严格通过：客户端 **4,776/4,776、623 suites**，desktop **319/319**，真实 native preparation **3/3**，frontend contracts **324/324**，MCP unit/clipboard/真实 socket fixture 分别 **96/96、12/12、5/5**，syntax exit 0；各执行门均 0 failed/skip/todo。实际 117/FIG、11 个可选 native/corpus 用例及页面重现场景均真正开启执行。1,402 项源码 SHA 为 `bfbab905166edfa8540efdc1d345129369ccfbd234b9d7c1b9d0d72d3bdb36b4`，源码与严格选定 `final2` release 运行时前后均稳定、改变路径为空；manifest SHA `c9e87921d07fa2ef1c0823b354bb362c30d889d9857dccdeb813c914be7be0cf`、三项原生 release 程序及 public/generated/selected WASM `d2a6069e…` 均吻合，见[最终 CPU 汇总](../testing/verification-functional-merge-20261021/final-cpu-summary.json)。历史 4,747/4,749、2 失败与运行时漂移记录继续保留，当时源码稳定不等于运行时稳定。

新 Rust workspace 已包含控制柄修复并完成 `cargo test --workspace --locked --offline`，**685.776 秒**内 Cargo 报告 **1,404 passed / 0 failed / 36 ignored**，源码身份前后稳定。扣除一个未执行样例断言的私有 FD 字体样例，实际接受执行通过为 **1,403**；ignored 与该未执行样例不算通过覆盖。详情及源码 SHA 见[新 Rust 汇总](../testing/verification-functional-merge-20261021/rust-regression-summary.json)。该结果不覆盖 TypeScript 缓存实现或复杂交互和 material 候选的实际画质，也不把历史 1,400 检查点改称当前结果。

两文件六轮混合压力各完成 366 次滚轮输入与 60 次拖动手势，应用无记录到的错误，但每文件仅 **14/16** 份精细参考可用，另两份被原生 halo 面积门拒绝；连续清晰度门与完整视觉门仍为 false，见[压力结果](../testing/verification-complex-navigation-20261021/COMPLEX-RESULTS.md)。CPU/Rust 通过不证明全程无模糊、所有中间帧无白块或真实 90/120 FPS。Material source cache 的高频实际 GPU 对照已有 **51/255** 画质失败，与出现整机回退的 resident scratch、整视口实验一起保持默认关闭；历史与当前源码身份、原始分量证明、抽样缺口检测和回归状态见[交付记录](../testing/verification-sharp-sequential-20261021/FINAL-VERIFICATION.md)。

## 导入导出

- `.fd` 是原生结构化二进制格式，须经现有编码器/解码器，不能用 JSON 改后缀。
- 原生导出/解码应保留文档结构；追加导入会按现有导入器重映射 ID，并明确返回映射，不声称原地替换会话。
- HTML/CSS 是浏览器可表达范围的派生输出，未实现的效果、字体依赖和布局差异必须报告。
- SVG 使用现有几何与文字轮廓路径，不支持的效果需拒绝或明确报告，不能静默删掉。
- 字体文件只从明确提供的资源注册，检查格式与大小；字体授权不能仅凭文件存在推断。示例附字体时保留原许可。
- Sketch 控制柄修复只影响从原始文件重新导入的几何；旧 FD/SQLite 中已丢失的控制柄不会自动恢复，不得根据名称或外观猜测并改写用户文档。

### 本轮独立副本与 MCP 检查点

- `workspace.importCopy` 分别覆盖 native JSON、FD、Sketch、FIG；确认主机生成 UUID、create-only SQLite revision 1、完整读回一致、相同 mutationId 精确重放、冲突/不确定结果处理。不能覆盖旧文档，不能自动激活新副本或改变当前页、选择、编辑撤销。真实 SQLite 与协议替身结果分别记账。
- FIG 的 ZIP/DEFLATE/Zstd 边界、解压预算和警告限制属于解码测试。实际浏览器 Worker 的启动、30 秒超时、取消、终止和迟到消息丢弃另做本机交互验收；Worker 协议替身不能代替这些结果。Sketch/FIG 的 compatibility / lossless:false 不等于无损或像素保真。
- 保留 legacy 2025-11-25 握手测试；modern 2026-07-28 分别验证逐请求 metadata、backend-free discovery、请求 ID/取消/超时、写出前撤权和资源寿命。官方 SDK 的实际 stdio 子进程测试仍使用 fixture backend；SDK 未提供导致的 skip 不计通过。
- 真实临时 Unix socket + CLI 测试、实际 Electron 原生授权/撤权 + Editor + SQLite、外部 AI 客户端各有独立边界。测试用 socket bridge fixture 不能拼成桌面全链路证明。Windows/Linux 的原生通信和 GUI 另行验收。
- 包内 `historical-*` 是旧源码的复用结果；新合并版本的命令、源码身份、失败和 skip 写入[本轮整合记录](../testing/verification-functional-merge-20261021/README.md)，不得相加或改名为本次全量全绿。

## 日志与恢复

操作记录保存时间、文档/版本、来源、摘要、结果等元数据；不保存临时令牌、模型密钥、提示词或整个操作参数。人工编辑与 API 自动化分开标记，API 不必然来自 AI。操作日志不是设计快照，恢复使用既有文档版本机制。

## PR 与交付

每项修复应有能失败的回归用例，保持失败输入、撤销/回滚、过期版本、取消及边界测试。Mock 必须说明隔离范围。不得改断言、吞异常或跳过失败来制造绿色结果。完整运行命令与结果由测试套件记录，受限项目不得算入成功数。

增量包附基准、路径、前像与后像摘要以及只读检查器。未知本地字节必须停止覆盖。重新构建必要的前端、Rust/WASM 和桌面程序后，再进行本机验收；源码测试通过不等于安装包已验收。
