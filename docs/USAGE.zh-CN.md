# 桌面使用方式

按[快速开始](../README.md#快速开始)构建并启动桌面应用。桌面默认打开本地工作区。

| 任务 | 操作 |
| --- | --- |
| 打开原生文档 | 从文件菜单选择「打开本机设计文件」，或使用 Cmd/Ctrl+O。`.fd` 保留可编辑的文档结构 |
| 导入其他格式 | 选择「导入 Sketch / FIG / SVG / PDF」。检查导入消息中的不支持项、替代字体和其他兼容性限制 |
| 打开大型 JSON 或 Sketch | 选择「打开大型 JSON / Sketch…」。按页和视口浏览，使用源工作台提供的编辑与导出入口 |
| 编辑与撤销 | 在画布或图层列表选择内容，在右侧属性面板修改。常用命令按当前快捷键预设执行 |
| 检查保存或恢复 | 等待自动保存回执。使用「本机项目目录」浏览工作区文件，使用「恢复未保存的设计」检查已有恢复快照 |
| 输出文件 | 用「导出副本…」保存独立文档，用「导出图像 · 1x / 2x / 3x」选择目标和倍率。大型源工作区使用「导出完整文件…」，选区 Sketch 和其他格式受当前会话支持范围约束 |

导入后的修改写入独立工作副本。跨工具交换时，看导出结果中的格式、字体、效果和色彩限制，可同时保留原生 `.fd`。保存、还原或导出后可重开对应副本核对。[格式与本地操作](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md) · [大源文件工作集](LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md) · [快捷键预设](../frontend/design-client/SHORTCUT_PROFILES.md)

## 可选能力

- 云端协作。在「设置 → 保存与范围」启用并填写服务地址和工作区令牌，从「服务器工作区」打开或同步。服务和 Web 应用独立维护。[Web 与协作服务](https://github.com/luckyzifan/futureox-desgin-server)
- 本地 MCP。在应用内开启本地自动化并授权所需会话，按指南配置适配器。用 `tools/list` 查看当前权限下可用操作，先读取文档身份与修订，再编辑和复核。[MCP 接入](ELECTRON_LOCAL_MCP.zh-CN.md) · [操作指南](MCP_OPERATION_GUIDE_V1.md)
- 插件。打开普通编辑文档，选择「插件」，运行内置样例或载入符合约束的文件夹／压缩包。支持的 API 随插件宿主入口而异。[Figma 插件宿主](FIGMA_PLUGIN_HOST_V1.md)

启动、构建、测试和打包见[桌面开发说明](../frontend/design-desktop/README.md#develop-and-test)与[本地测试使用方式](../testing/README.md)。
