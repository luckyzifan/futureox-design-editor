---
name: futureox-rendering-first
description: Plan, implement, benchmark, review, or package Futureox Design Core rendering, canvas interaction, Rust kernel, and game-art editor increments. Use to enforce rendering-first priority and evidence gates in this repository; not as a claim that an existing candidate has passed.
---


2026-10-26 源页面载入修复见[本轮记录](../../../testing/verification-source-page-load-20261026/README.md)：macOS 原生内存探测、显式页面分段与有界转换并行分别验收。保留归档/文档/GPU 预算，逐段覆盖全部源对象不能代替整页同时渲染或 G2/G5。
# Futureox Design：渲染优先

2026-10-26 拓扑高倍缩放续轮见[证据记录](../../../testing/verification-topology-navigation-20261026/README.md)：偏移/描边阴影按完整支持范围分条；私有上传证明绑定系数、半径和实际 GPU 资源，写入即撤销。默认受限入口仅用于非 HDR 画布，原有全局实验开关、普通滤镜上限和全部内存预算不变。硬件逐位比较、GPU 完成等待、当前密度覆盖和输入到呈现分别记录；已测 3200% 视口通过不代表所有视口或全 G2/G5 已通过。

2026-10-26 局部材质失效优化见[真实文件记录](../../../testing/verification-local-edit-cache-20261026/README.md)：只在既有 Rust 材质证明成立时使用已解析布局计算脏区，嵌套蒙版限制到消费容器，背景依赖按页面/隔离边界传播。页面根蒙版、结构变化与相关未知光学读取继续保守失效。FIG 小蒙版重绘从 20 块降为 1 块；117 大蒙版的减少绘制不等于端到端改善。性能受后台编译干扰的样本与截图叠层失配必须保留并分开报告，不以本轮关闭完整 G2/G5。

2026-10-26 大文件编辑续轮见[配对 GUI 记录](../../../testing/verification-large-edit-20261026/README.md)：取消已释放的首捕获、原生瓦片优先、完整工作集同步减少了重复绘制及交互中反复复制 52 MB 文档。完整源确认仍由既有 native full-load 提供，局部编辑仍增量，不放宽 receipt/CAS。保留真实 pointerup 与代理时间区别，约 16.6→6.7 秒仍不是即时编辑。维护检查与非零平移关联候选未采用；局部测试不能替代真实路径收益。

2026-10-26 的透明缺口、准入与取消修复见[本轮证据](../../../testing/verification-motion-continuity-20261025/README.md)。零透明、覆盖与原生密度不能证明对象及时跟随输入；保留旧帧也可能得到这些指标。宽整数精确滤波候选继续默认关闭，真实快速缩放与拓扑编辑收敛仍失败，不得把局部通过说成用户全部目标完成。

2026-10-25 的依赖范围、编译片段、准备取消、资源身份、调度、维护与批绘改动见[本轮记录](../../../testing/verification-render-pipeline-20261025/README.md)。局部精确像素和定向回归不自动关闭既有运动失败；保留默认关闭、无共享内存浏览器取消回退及未完成全 G5 的边界。

本 Skill 是项目工程规范，不授予额外操作权限，也不把设计目标当成已实现功能。

## 先读哪些规则

- 每次本项目实现、性能复核或增量交付，先读[渲染优先工程与验收规范](../../../docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)。它是以下门槛、矩阵与证据字段的唯一详细定义。
- 涉及架构、存储、文档或平台边界，再读[现有开发 Skill](../futureox-design-development/SKILL.md)和[v1 开发契约](../../../docs/DEVELOPMENT_CONTRACT_V1.md)。新规范确定优先级，不撤销既有精度、所有权、默认关闭或安全边界。

## 决策规则

1. 渲染体验是 No.1。模糊、白板、3200% 缩回、快速反向缩放、旋转、拖动、resize、紫色选择框同步和连续编辑不冻结优先于新增美术功能。按规范 G0/G2 的实际故障清单与真实应用回放验收，不能用“已加缓存”代替问题消失。
2. Rust 承担主要领域逻辑与权威语义；UI 负责输入、交互状态和展示。按 G1 给出 UI → Rust/WASM/native → 提交/渲染的实际调用与产物证据。现有 TS/GPU 适配层不是再建第二套业务核心的理由，也不应为形式上的迁移扩大本轮风险。
3. 保持现有精度、HDR/浮点、export、persistence、撤销重做和文档语义。G3 不通过时性能收益无效；不靠抬预算、删 guard、降效果/分辨率、跳过错误或复用过期画面“通过”。未验实验继续默认关闭。
4. 优化主 CPU 必须测真实生产热路径。G4 区分真实 117、十份真实导入、固定规模场景与小合成；分别标注 CPU、mock、software GPU、GUI、hardware GPU，以及 wall、提交 ACK、GPU 完成、真实像素。只报告测得的层级。
5. 使用 G5 固定矩阵：300/3000/20000 纯矢量与重效果六格；100 图标各自按 1/2/3 倍导出，修改后重复；真实 117 和十份副本另列。不可把缺失、拒绝、跳过或未执行的格子算通过。
6. 按 G6/G7 绑定来源、构建、配置、hash、真实 oracle、旧失败新通过及取消/晚回/压力证据。测试命中真实改动路径；输入 ACK 不证明像素呈现，CPU/mock 不替代硬件与 GUI 门。
7. 独立工作可并行，但构建/测试并发受明确资源上界约束，性能 A/B 不与重负载争用。协作接口保留 ID、操作、版本、幂等与快照/增量边界；按 G8 验证，不在渲染热路径等待网络、持久化或全量序列化。
8. 六项游戏美术能力及 VectorCraft 启发项属于 G9 后续范围：核心在 Rust，右侧面板直接编辑当前画布，必须闭合撤销/保存/导出链路。PSD/ABR 明确排除；参考源码不等于许可已核或产品能力已验证。
9. 增量交付遵循 G10：仅新增/变化文件及相关测试、精确前置 hash、文件清单、回滚和未验边界；不改已发布包、不发空包、不复制无关仓库。文档检查通过只能叫文档检查通过。

## 执行与报告

开始前写明本轮解决的渲染故障、受影响门槛、冻结基线、测试环境及停止/取消边界。运行前冻结场景、oracle、阈值和配置；阈值缺失时明确 BLOCKED，不事后放宽。

修改后优先给出：本轮改了什么；哪些 G 门已实测；哪些 FAIL/BLOCKED/NOT_RUN；证据与源码/产物 hash；下一步尚缺什么。全应用完成声明须满足规范的联合判定，单项候选只报告自身已证明范围。

- 4 GiB 大源文件与调度隔离的边界见[本机验证记录](../../../testing/verification-large-document-4gib-20261023/README.md)：完整源字节留在磁盘，局部画布仍使用现有 Editor/Rust/WASM；原生流式导入、导出、后台保存延迟和真实 GUI 像素必须分别报告，不能以展开容量替代全图渲染验收。

- 2026-10-23 的 0246 / 0741 / 1338 组合增量见[合并验证记录](../../../testing/verification-increment-0741-1338-20261023/README.md)。精确滤波、managed 背景入口和空场景 compose 候选保持默认关闭；源码和 mock 测试不替代真实硬件、全编辑器或导出/HDR 门。

- 2026-10-24 拓扑素材修复的真实 GUI、完整归档字节核对、硬件浮点对照及分段火焰图见[验证记录](../../../testing/verification-topology-repairs-20261023/README.md)。保留早期能显示但 winding 不一致的失败候选；最终 dense 工作容差收紧后真实几何 oracle 才通过。无采样重放 uiStalls=0 只证明该轮素材操作，不能替代完整 G2/G5、物理显示或退出协议验收。
