# 4 GiB 源文件、局部编辑与后台调度验证

后续主画布重构及真实 Electron 的渲染、实例编辑、保存、完整导出结果见[工作集渲染验证](../verification-vector-geometry-20261023/README.md)。该轮发现大画板 CSG 段数和 36 色标渐变仍不能准入，因此未提交推送；不能把本文早期容量门当作整图渲染通过。

基线为 `c65ed474141825968cb5e032d6add4cecd584a6d`。本轮处理用户提供的两个 ZIP，并修复下载目录拓扑 Sketch 被旧 `Sketch archive: Limit("entry bytes")` 拒绝的问题。源数据留在原生磁盘缓存中，只有选中工作集进入现有 Editor / Rust-WASM / Canvas；完整导出保留未加载内容。

## 来源与合并

- `core-increment-c65-prepare-worker-pose-trace-dev-20261023T0246Z.zip`：SHA-256 `bcc98b3729529ff81f7b127be70baf736af1c2790dc7d4c08e0cd04208498f68`。21 个路径的前后 hash 均验证；14 个生产文件、7 个测试文件。与本轮新增源文件适配器无文件重叠，全部保留。
- `core-increment-e411-import1gib-diagnostics-dev-20261023T0203Z (1).zip`：SHA-256 `be05c0c639b03779e6bc9b62af52574f9bf0dd34099a147d36bae637e6425826`。解压审计，26 个源码文件均与基线 HEAD 完全一致，未重复覆盖。
- 包内脚本和文字作为交付资料，未作为用户操作指令执行。逐文件证据见 [package-integration.json](package-integration.json)。历史包的 GPU/GUI 未验边界没有被本次源码合并自动清除。

## 改动与边界

详见[源文件与工作集契约](../../docs/LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md)。源 JSON / Sketch 总展开量上限含 4,294,967,296 字节；对象索引最多 1,000,000。单次源片段最多 4 MiB，属性和画布 DTO 最多 2 MiB。UI 分页，Rust 流式扫描、源区间增量、耐久 checkpoint、源撤销/重做、恢复和完整导出均有独立边界。

普通工作区业务与大文件任务各一个有界执行通道；全局最多 8 个业务请求，大文件长任务最多 2 个（运行与排队合计）。主进程文件锁同样隔离。Tokio 使用 2 个异步线程、4 个 blocking 槽，给两个业务任务及 stdio/解析留下位置。排队与执行采用独立回执、独立期限。导出捕获源版本快照并释放会话锁；进度和取消独立响应。父子导航和短名称缓存全局低于 64 MiB，近期属性 LRU 为 8 MiB / 16 条。

本实现没有把整个 4 GiB 源文件变成完整 live scene，没有增加 GPU 工作预算、默认启用实验 GPU 路径或实现 Web OPFS。局部画布使用现有编辑器；整图 GPU、高倍率缩放、旋转和长时间连续编辑仍须分别验收。

## 冻结场景与实测

[acceptance-plan.json](acceptance-plan.json) 在容量测试前固定输入、oracle 和原生 RSS 门槛；[native-large-results.json](native-large-results.json) 绑定最终测试二进制和源 hash。两个 4 GiB 样本均为磁盘上的实际完整文件；第二个样本包含五份真实页面 JSON、约一千万曲线点和超过五十万个可定位对象。其重复 UUID 仅作为通用 JSON 数据，不冒充合并后的有效 Sketch live scene。内存指孤立原生测试进程 RSS，不包含 Electron 或文件系统缓存。

最终三项原生大文件门均通过：4 GiB 边界样本 61.276 秒 / 峰值 3.55 MiB；结构化 4 GiB 样本 127.812 秒 / 342.30 MiB；真实拓扑 JSON + 画布 codec 修改、导出、重开 49.447 秒 / 75.16 MiB。真实测试确认 63 个未修改 ZIP 成员解压字节一致，重开索引对象数一致。

真实拓扑输入为 118,272,240 字节，64 个 ZIP 成员，总展开 831,806,447 字节，最大页面 699,402,701 字节，124,399 个可定位对象。原文件保持只读，测试输出另存。

[scheduling-results.json](scheduling-results.json) 使用真实原生 stdio 与该输入：旧串行后台在扫描时保存普通 FD 等待 14,693 ms；新后台 30 次保存最大 336.5 ms，其后约 10–17 ms。进度/读取最大 0.944 ms，分页查询中位数 0.222 ms；导出取消 6.381 ms，未发布取消的目标，之后 health 仍响应。预先固定门槛为保存 2 秒、读取/进度 1 秒、取消 2 秒。基线对照只证明排队阻塞，候选满足这些调度门槛；它们不是 GUI 帧率或 GPU 像素证据。

## 回归与失败修正

- 完整原生 backend 回归：110 通过、5 ignored。3 个大文件手动门另行显式执行；其余 ignored 不是通过。
- 新源扫描器：4 项通过，包括嵌套子树索引上下文、UTF-8/语法拒绝和区间导出。
- 前端目标回归：8 套 206 项及另 6 套 81 项通过。大文件面板 3 项在调度 UI 调整后再次通过，与前述 206 中的同名测试不重复相加。
- 桌面 host / sidecar / security：27 项通过，包括会话身份、不确定打开后查询、取消、双倍转义响应预算和独立排队期限。
- TypeScript 检查、实际 release WASM + desktop-dev native / Electron 构建通过。构建前后受控输入一致；[build-identity.json](build-identity.json) 记录产物及构建输入 hash。
- 首次真实文件测试在最终重开步骤因测试重复会话目录失败；测试身份已改为每次递增。随后实测发现局部子树被按顶层 JSON 重建索引，导致重开对象计数不一致；已保留原深度并加入失败对应测试。见 [prior-topology-failure.txt](prior-topology-failure.txt)。另修正取消使用 `Interrupted` 被 `io::copy` 持续重试的问题。

GUI 首次运行已通过普通导入入口打开源文件及属性修改，但局部画布暴露了中间 Sketch 页面引用 `working` / `dependencies` 不满足前端 UUID 约束的问题。原生工作集改为 UUID 成员引用，保留共享 codec；前端既有校验复现旧失败并接受修正引用。修正后真实原生 Sketch 编辑/导出/重开门再次通过，见 [native-topology-final-results.json](native-topology-final-results.json)。前两项 4 GiB 容量门与调度数据使用修正前产物，容量和调度实现未在页面引用修正中改变。进一步的真实 Editor 编辑暴露了 managed 文档在首次修改时回退到 analytic 的问题；局部工作集现在复用现有 editing-adoption，native 基线也显式采用对应的 figma 配置。挂载 Inspector + 真 Editor/WASM 的回归验证了改宽度、草稿归属、撤销/重做和父文档不变。最新 lib 回归另验证嵌套未知字段/禁用画笔保留、标量变容器后的索引更新，以及只读组件依赖被修改时拒绝假确认。只读元数据比较同时接受浏览器数值规范化（0.0→0），保持原始源字节不动。最新 native lib 45 项通过；[working-editor-result.json](working-editor-result.json) 使用真正的现有 Editor/WASM 和原生源服务，覆盖宽度/填充、撤销/重做、回写、完整导出。[native-editor-export-verification.json](native-editor-export-verification.json) 进一步证明最大页面只有选中对象区间变化，其余前缀/后缀及另外 63 个成员逐字节相同。最终 GUI 结果待下文补录。

## 复跑

从仓库根目录，先使用有界 `-j2` 编译 backend 的 desktop-dev lib tests，带 `--no-run --message-format=json` 将结果写入本目录 `native-build.jsonl`；然后执行 `python3 testing/verification-large-document-4gib-20261023/verify_native.py --sketch /absolute/path/to/input.sketch`。三项大文件测试串行运行，避免其他重负载。私有素材及生成的 GiB 文件不入库。

在 `frontend/design-desktop` 运行 `CARGO_BUILD_JOBS=2 bun run build --fast` 重建后，从仓库根目录执行 `node testing/verification-large-document-4gib-20261023/verify_scheduling.mjs frontend/design-desktop/dist/sidecar/futureox-design-desktop-backend /absolute/path/to/input.sketch`。可选第三个参数为本轮保留的旧 native 后台，只用于历史串行基线比较。

源码回滚需回退本轮提交并重建匹配产物；缓存为独立版本格式，回滚不删除用户源文件、另存输出或本机库。原始输入和完整测试生成物未随提交发送。
