# 文档索引

## 开始与参与

- [项目介绍与快速开始](../README.md) · [English introduction](../README.en.md)。
- [贡献指南 · Contributing](../CONTRIBUTING.md)：开发环境、PR 流程、验证与文档要求。
- [项目路线图 · Roadmap](ROADMAP.md)：当前阶段、优先事项与参与入口。

## 1. 架构与工程边界

- [架构分层与调用链](architecture/README.zh-CN.md)：客户端、协议适配、Rust 领域层和执行后端。
- [开发契约](DEVELOPMENT_CONTRACT_V1.md)：文档、事务、版本、平台与交付约束。
- [渲染优先验收规范](RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)：正确性、交互、性能与证据门槛。
- [功能矩阵](LOCAL_DESIGN_FEATURE_MATRIX.zh-CN.md)与[发布验收](LOCAL_RELEASE_ACCEPTANCE.zh-CN.md)。

## 2. 渲染与画布

- [渲染架构](RENDER_ARCHITECTURE_STAGE_ONE.zh-CN.md)与[派生数据](RENDER_DERIVATION_STAGE_TWO.zh-CN.md)。
- [渲染配置](RENDER_RUNTIME_CONFIGURATION_V1.md)、[资源预算](RENDER_SURFACE_BUDGET_SNAPSHOT_V1.md)与[颜色空间](COLOR_SPACE_SRGB_PATH.md)。
- [画布帧诊断](CANVAS_FRAME_GRID_DIAGNOSTICS.md)、[失败诊断](RENDER_FAILURE_DIAGNOSTICS.zh-CN.md)与[输入诊断](INPUT_STAGE_DIAGNOSTICS_2026-10-20.md)。
- [缩放清晰度](ZOOM_CLARITY_SELECTION_20261109.zh-CN.md)、[桌面 GPU 修复](ELECTRON_GPU_REPAIRS_20261109.zh-CN.md)与[拓扑渲染优化](TOPOLOGY_RENDER_OPTIMIZATION_20261109.zh-CN.md)。

## 3. 平台、文件与存储

- [桌面应用](../frontend/design-desktop/README.md)与[网页支持边界](WEB_SUPPORT_BOUNDARIES_2026-10-24.md)。
- [大源文件工作集](LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md)与[全源画布容量](SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)。
- [导入与本地操作](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md)、[自动化存储](DESIGN_AUTOMATION_STORAGE.zh-CN.md)与[工作区接口](workspace-mcp.md)。
- [SVG 兼容性](SVG_COMPATIBILITY_AUDIT.zh-CN.md)与[格式及本地操作契约](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md)。

## 4. 自动化与插件

- [MCP 操作指南](MCP_OPERATION_GUIDE_V1.md)、[操作权限](LOCAL_OPERATION_PERMISSIONS_V1.md)与[资源生命周期](MCP_RESOURCE_LIFECYCLE_V1.md)。
- [细粒度编辑](GRANULAR_MCP_EDITING.zh-CN.md)、[批量编辑](DESIGN_BULK_EDITS.zh-CN.md)与[操作覆盖表](OPERATION_COVERAGE_V1.json)。
- [Figma MCP 兼容入口](FIGMA_MCP_FACADE.md)、[插件宿主](FIGMA_PLUGIN_HOST_V1.md)与[Agent 接入](DESIGN_AGENT.md)。

## 5. 编辑功能

- [选择命令](SHARED_SELECTION_COMMANDS_V1.md)、[复制命令](SHARED_DUPLICATION_COMMAND_V1.md)与[自动布局命令](SHARED_AUTO_LAYOUT_COMMANDS_V1.md)。
- [变量](VARIABLE_MANAGEMENT.zh-CN.md)、[组件内容槽](COMPONENT_CONTENT_SLOTS.md)与[布局建议](LAYOUT_SUGGESTIONS.md)。
- [矢量笔刷](features/VECTOR_BRUSHES_2026-10-20.md)、[非破坏重复](features/non-destructive-repeat.md)与[形状生成器范围](next-features/SHAPE_BUILDER.md)。

## 6. 验证与来源

- [本轮 8 个 PR 的复核与合并记录](PR_REVIEW_20261110.zh-CN.md)：逐项结果、未合并门槛和已知失败。

- [测试贡献指南](TESTING_CONTRIBUTIONS.zh-CN.md)；已知回归和未验范围见[本轮复核](PR_REVIEW_20261110.zh-CN.md)。
- [第三方声明](../THIRD_PARTY_NOTICES.md)、[素材来源](UI_ASSET_PROVENANCE.md)与[分发评估](OPEN_SOURCE_COMMERCIAL_READINESS_20261109.zh-CN.md)。
- [品牌说明](BRANDING.md)。

回归夹具保留在 `testing/fixtures/` 和 `frontend/design-client/public/fidelity/`；它们的使用范围与生产资源分开管理。
