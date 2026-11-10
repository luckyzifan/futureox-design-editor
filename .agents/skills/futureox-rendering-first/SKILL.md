---
name: futureox-rendering-first
description: Plan, implement, benchmark, review, or package Futureox Design Core rendering, canvas interaction, Rust kernel, and game-art editor increments. Use to enforce rendering-first priority and evidence gates in this repository; not as a claim that an existing candidate has passed.
---

# Futureox Design：渲染优先

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

当前实现与未完成范围见[渲染配置](../../../docs/RENDER_RUNTIME_CONFIGURATION_V1.md)、[缩放清晰度](../../../docs/ZOOM_CLARITY_SELECTION_20261109.zh-CN.md)、[连续缩放交接](../../../docs/ZOOM_HANDOFF_20261109.zh-CN.md)和[最新主线复核](../../../docs/PR_REVIEW_20261110.zh-CN.md)。历史测量只适用于对应提交；不在 Skill 中重复保存逐轮报告。
