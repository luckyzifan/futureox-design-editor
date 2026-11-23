# 文档索引

## 开始与参与

- [项目介绍与快速开始](../README.md) · [English introduction](../README.en.md)。
- [桌面使用方式](USAGE.zh-CN.md)。打开、导入、编辑、自动保存与导出的常用操作。
- [贡献指南 · Contributing](../CONTRIBUTING.md)：开发环境、PR 流程、验证与文档要求。
- [项目路线图 · Roadmap](ROADMAP.md)：当前阶段、优先事项与参与入口。

## 1. 架构与工程边界

- [架构分层与调用链](architecture/README.zh-CN.md)：客户端、协议适配、Rust 领域层和执行后端。
- [开发契约](DEVELOPMENT_CONTRACT_V1.md)：文档、事务、版本、平台与交付约束。
- [渲染优先验收规范](RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)：正确性、交互、性能与证据门槛。
- [功能矩阵](LOCAL_DESIGN_FEATURE_MATRIX.zh-CN.md)与[发布验收](LOCAL_RELEASE_ACCEPTANCE.zh-CN.md)。

## 2. 渲染与画布

- [画布与渲染架构](architecture/RENDERING.zh-CN.md)。常规页面、大型源与导出路径，准备与呈现边界。
- [渲染配置](RENDER_RUNTIME_CONFIGURATION_V1.md)、[资源预算](RENDER_SURFACE_BUDGET_SNAPSHOT_V1.md)与[颜色空间](COLOR_SPACE_SRGB_PATH.md)。
- [画布帧诊断](CANVAS_FRAME_GRID_DIAGNOSTICS.md)、[失败诊断](RENDER_FAILURE_DIAGNOSTICS.zh-CN.md)与[输入诊断](INPUT_STAGE_DIAGNOSTICS_2026-10-20.md)。
- [缩放清晰度](ZOOM_CLARITY_SELECTION_20261109.zh-CN.md)、[桌面 GPU 修复](ELECTRON_GPU_REPAIRS_20261109.zh-CN.md)与[拓扑渲染优化](TOPOLOGY_RENDER_OPTIMIZATION_20261109.zh-CN.md)。

## 3. 平台、文件与存储

- [桌面应用](../frontend/design-desktop/README.md)与[独立 Web 和协作服务](https://github.com/luckyzifan/futureox-desgin-server)。
- [大源文件工作集](LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md)与[全源画布容量](SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)。
- [导入与本地操作](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md)、[自动化存储](DESIGN_AUTOMATION_STORAGE.zh-CN.md)与[工作区接口](workspace-mcp.md)。
- [SVG 兼容性](SVG_COMPATIBILITY_AUDIT.zh-CN.md)。

## 4. 自动化与插件

- [MCP 操作指南](MCP_OPERATION_GUIDE_V1.md)、[操作权限](LOCAL_OPERATION_PERMISSIONS_V1.md)与[资源生命周期](MCP_RESOURCE_LIFECYCLE_V1.md)。
- [细粒度编辑](GRANULAR_MCP_EDITING.zh-CN.md)、[批量编辑](DESIGN_BULK_EDITS.zh-CN.md)与[操作覆盖表](OPERATION_COVERAGE_V1.json)。
- [Figma MCP 兼容入口](FIGMA_MCP_FACADE.md)、[插件宿主](FIGMA_PLUGIN_HOST_V1.md)与[Agent 接入](DESIGN_AGENT.md)。

## 5. 编辑功能

- [选择命令](SHARED_SELECTION_COMMANDS_V1.md)、[复制命令](SHARED_DUPLICATION_COMMAND_V1.md)与[自动布局命令](SHARED_AUTO_LAYOUT_COMMANDS_V1.md)。
- [变量](VARIABLE_MANAGEMENT.zh-CN.md)、[组件内容槽](COMPONENT_CONTENT_SLOTS.md)与[布局建议](LAYOUT_SUGGESTIONS.md)。
- [矢量笔刷](features/VECTOR_BRUSHES_2026-10-20.md)、[非破坏重复](features/non-destructive-repeat.md)与[形状生成器范围](next-features/SHAPE_BUILDER.md)。

## 6. 测试与验证

- [测试贡献指南](TESTING_CONTRIBUTIONS.zh-CN.md) · [本地测试使用方式](../testing/README.md) · [验证结论](verification/README.md)。
- [固定回归输入](../testing/fixtures/regression/README.md)记录脚本依赖的基线和夹具来源。

## 7. 来源与分发

- [第三方声明](../THIRD_PARTY_NOTICES.md)、[素材来源](UI_ASSET_PROVENANCE.md)与[分发评估](OPEN_SOURCE_COMMERCIAL_READINESS_20261109.zh-CN.md)。
- [品牌说明](BRANDING.md)。
