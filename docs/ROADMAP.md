# Futureox Design 路线图 · Roadmap

[简体中文](#当前方向) · [English](#english)

## 当前方向

Futureox Design 处于**开发者 Alpha**。当前重点是把日常设计与文件操作打磨可靠，再逐步扩展创作能力。本页描述优先级；具体进度、复现和验收以关联 Issue 与验证记录为准，不承诺发布日期。

| 优先级 | 方向 | 接下来关注什么 |
| --- | --- | --- |
| 1 | **画布连续性** | 连续缩放、快速反向、平移、旋转与选择框同步；继续处理 [#58](https://github.com/luckyzifan/futureoxDesgin/issues/58) 的剩余场景 |
| 2 | **大文件与重效果** | 完整源画布、视口准备、停手精修、资源生命周期与真实素材性能；保持既有画质和预算边界 |
| 3 | **文档与格式可靠性** | FIG／Sketch 导入中的字段保留、可编辑性与明确限制；撤销、保存重开和导出回归 |
| 4 | **跨平台开发体验** | 完善从源码启动、三平台 CPU／host CI、真实桌面与 GPU 验证、打包与发布流程 |
| 5 | **开放的参与入口** | 更清晰的文档、原创公开夹具、可复现的问题和范围清晰的 PR；持续维护中英文首页 |

## 已有基础

Rust 文档与编辑内核、共享网页／桌面客户端、本地工作区、设计文件适配和 MCP 接口已经在代码库中持续演进。功能层面的实现与缺口见[能力核对表](LOCAL_DESIGN_FEATURE_MATRIX.zh-CN.md)，各主题入口见[文档索引](README.md)。历史记录具有各自的版本与环境，不替代当前组合版本验收。

## 怎样参与

近期问题汇总在[索引 #91](https://github.com/luckyzifan/futureoxDesgin/issues/91)。你可以提交一个最小复现、验证一个已知问题，或提出能改善真实设计工作流的方案。准备开发时先读[贡献指南](../CONTRIBUTING.md)，较大调整先在 Issue 中讨论。

渲染目标与验收方法见[渲染优先规范](RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)。单个修复合入后，仅更新它已经证明的范围；完整连续交互、固定规模矩阵和性能目标仍分别验收。

## English

Futureox Design is a **Developer Alpha**. The priority is dependable everyday editing and file workflows, followed by broader creative capabilities. This is a direction of work, not a release schedule. Issues and verification records track actual progress.

1. **Canvas continuity:** continuous and reversed zoom, pan, rotation, and synchronized selection chrome; remaining cases in [#58](https://github.com/luckyzifan/futureoxDesgin/issues/58).
2. **Large documents and effects:** full-source canvases, viewport preparation, refinement, resource lifetimes, and real-file performance within existing quality and memory limits.
3. **Reliable documents and formats:** FIG/Sketch field preservation, editability, explicit limits, undo, save/reopen, and export regression coverage.
4. **Cross-platform development:** clearer source setup, three-platform CPU/host CI, real desktop/GPU verification, packaging, and release workflows.
5. **Open participation:** approachable documentation, original public fixtures, reproducible reports, focused PRs, and aligned Chinese/English introductions.

The Rust kernel, shared web/desktop client, local workspaces, format adapters, and MCP interface provide existing foundations. The [capability review](LOCAL_DESIGN_FEATURE_MATRIX.zh-CN.md) and [documentation index](README.md) describe their scope. Historical results apply to their recorded versions and environments.

See [issue index #91](https://github.com/luckyzifan/futureoxDesgin/issues/91) and [CONTRIBUTING.md](../CONTRIBUTING.md#english) to join in. Rendering acceptance follows the [engineering contract](RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md); individual fixes do not establish complete interaction, scale, or performance acceptance.
