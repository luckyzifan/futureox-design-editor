# Futureox Design 自动化 API / MCP 能力对标与验收计划

版本基线：2026-10-19。范围：Figma 官方公开文档以及集成接口能力观察。本文为 Futureox 的独立能力设计与验收计划，不是官方 SDK、兼容认证或已经完成的实现报告。本次研究没有调用 Figma 文件读取、生成、上传、编辑或发布，也没有改动 Futureox 渲染。

## 当前产品范围更新

用户最新要求为**本地设计软件**，优先性能与使用体验；协作、云发布、账户/租户体系不在产品目标内。下列Figma 48工具仍作为研究盘点保留，涉及账户、云部署、云生成托管、Gallery、Weave计费或云协作的条目仅作边界参考，其早期“计划”标记不构成当前实施路线。后续本地功能矩阵应同时对照Figma与Sketch，另行逐项验收；本文未完成Sketch功能研究。

## 1. 结论

1. 当前连接器共暴露 **48 个 Figma 工具**。它已经远超只读 design-to-code，覆盖原生场景图读写、设计系统、素材、动画、代码项目、生成插件、Shader 与 Weave。
2. 应区分五层：**MCP 协议、Figma MCP 工具、Figma Plugin API、Figma REST API、客户端工作流**。实现一个 MCP HTTP 端点并不会自动获得 Figma 的布局、文本、渲染、组件或生成能力。
3. 对 Futureox 最有价值的等价目标是：**可持久化的原生设计结构 + 可控批量修改 + 可检索的组件/变量 + 可验证的截图与导出 + 项目代码映射**。仅返回伪造成功或静态 HTML 截图，不是原生设计能力等价。
4. 接口兼容与视觉/行为兼容必须分别验收。当前约 48 个顶层方法的数量不是实现成本的好指标；单个 use_figma 背后是大量节点、文本、布局、变量和组件行为。
5. Figma 云端执行、AI 生成、Make 部署、账户库、Weave 计费和宿主内嵌视图是厂商服务，不是开放 MCP 标准。可以设计独立等价实现；不能承诺复用其内部服务。

官方确认远程服务允许直接编辑真实设计结构；桌面服务不支持写画布。远程服务器只接受其列出的受支持客户端，新客户端接入有申请流程。[远程接入](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)、[桌面服务](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)、[写画布](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)

## 2. 证据与版本纪律

- **L：集成接口观察**。48项能力用于确定对标范围，参数为能力摘要，并非冻结的完整 JSON Schema。未来实现需根据授权取得的公开规范与兼容测试维护版本。
- **P：公开官方文档**。用于交叉验证产品能力、协议边界和限制。
- **R：建议**。为 Futureox 提出的架构、验收及安全要求，不声称 Figma 现有实现具有这些细节。
- 文件/节点身份：通常 fileKey 标识文件；nodeId 是文件内节点身份，URL 的 1-2 通常规范化为 1:2。分支 URL 的 branchKey 不能混作主文件 key。
- 并非所有工具都允许缺省 nodeId。get_metadata 可省略以列页；其他具体节点工具大多必填；不能对任意文件都使用 0:1。
- 编辑器类型需显式区分 Design、FigJam、Slides、Code/Make；同名节点方法在不同编辑器可能不存在。
- 公开资料、当前 schema、实际服务结果可能存在版本差异。生产调用以当次 tools/list 的 schema 和服务返回为准。

发现的具体差异：

| 项目 | 官方页面 / 当前契约差异 | 对实现的影响 |
|---|---|---|
| html_to_figma | 官方索引列出，当前 48 工具中没有 | 记为公开可见但本会话未开放，不伪造可调用方法 |
| create_design_system_rules | 官方定位为 MCP prompt，非普通 mutation tool | 应提供 prompts/list、prompts/get，不能只登记成工具 |
| download_assets | 页面写至多 20 节点；当前入参只有单个 nodeId | 此版本单节点调用；rawImages 与 svgAssets 各有自己的 20 项上限，不能混淆 |
| export 参数优先级 | 当前工具契约称显式 defaultFormat/defaultScale 覆盖节点设置；页面描述不同 | 对兼容层写契约测试，不凭通用说明猜优先级 |
| generate_figma_design | 官网描述新文件/已有文件/剪贴板；当前参数必须给 fileKey | 当前使用前先具备目标文件；不要自造 outputMode 等不存在参数 |
| create_new_file | 工具 enum 还包括 figmake | 不能只按页面文字实现 design/figjam/slides |
| get_code_connect_map | 当前可选 codeConnectLabel；页面强调 clientFrameworks/clientLanguages | 此工具当前只能传其真实 schema，get_design_context 另有 framework/language 参数 |
| Shader metadata | 当前 update_shader 有 isAnimated、usesMouse；公开文章对 features.json 有限制 | 不把“文件不能替换”等同于“所有对应元数据不能改变”；需独立验证 |
| 来源读取权限 | 公开页面的概述/细分权限措辞不完全一致 | 以资源所有者、文件访问与服务实际授权检查为准，不承诺任意私有源码可读 |

以下 8 个工具在当前工具契约中存在，但未见于本次查看的官方 Tools and prompts 主索引：check_prompt_status、export_video、generate_deck、get_chat_threads、list_file_components_for_code_connect、open_figma_mcp_app_in_thread、publish_to_gallery、send_prompt。这仅表示索引覆盖不同，不代表它们无任何公开资料。

公开能力索引与 prompt 分类可核对：[Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)、[规则 prompt](https://developers.figma.com/docs/figma-mcp-server/add-custom-rules/)

## 3. 完整顶层工具能力矩阵

说明：参数中的 ? 表示选填；F=fileKey，N=nodeId。R=读，W=写/外部副作用，J=异步作业，U=宿主界面。

下列48项按Figma完整工具合同保留初始“计划/未验收”或“非目标”状态。本轮已验证的Futureox基础设施另见第9节；局部实现不会自动升级为完整工具兼容。必须由负责人补齐实现路径、契约测试、结构/视觉验证和负面测试，才能改为“已验收”。“非目标”不计入兼容完成率。目标都是 Futureox 自有文档/账户/资产上的独立实现，不继承 Figma 账户权限或云端基础设施。

### 3.1 身份、文件、结构与视觉读取（8）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| whoami | R | 无 | 当前身份、计划/团队、席位；计划 key 供创建目标选择 | 身份、租户、角色、功能权限  自有身份等价；Figma计划/席位非目标 | P0 计划/未验收 |
| create_new_file | W | editorType、fileName、planKey；projectId? | 新建文件及 URL；默认 drafts；editorType=design/figjam/slides/figmake | 文件仓库、目录、编辑器类型、初始文档  自有文件等价；Figma账户存储非目标 | P0 计划/未验收 |
| get_metadata | R | F；N? | 有节点时为轻量 XML：ID/名称/类型/位置/尺寸；省略节点则列顶层页 | 层级查询、几何元数据、分页/深度限制  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| get_design_context | R | F、N；clientFrameworks?、clientLanguages?、disableCodeConnect?、excludeScreenshot?、forceCode? | 设计参考代码、资源链接、元数据及默认截图；大结果可能退化为 sparse/metadata | 场景语义序列化、代码生成、资源解析、预算控制、代码映射  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| get_screenshot | R | F、N；maxDimension?、contentsOnly?、enableBase64Response? | PNG、短期 URL、渲染尺寸和自然尺寸；maxDimension 默认1024，正整数且不超过65536；可隔离节点或包含重叠内容 | 服务端渲染、裁剪、画布叠放语义、图像存储  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| get_figjam | R | F、N；includeImagesOfNodes? | FigJam 上下文；官网描述 XML 与节点图像，工具描述还称 UI code，实际结果需实测 | 白板图结构、文本/连线语义、局部预览  自有设计引擎等价；不代理Figma云端实现/权限 | P2 计划/未验收 |
| get_motion_context | R | F、N；recursive?、clientFrameworks?、clientLanguages? | 动画节点、轨道、easing、CSS/Motion 片段与时间轴关联；recursive 取后代 | 时间轴模型、关键帧序列化、代码转换  自有设计引擎等价；不代理Figma云端实现/权限 | P2 计划/未验收 |
| open_figma_mcp_app_in_thread | U | 无 | 在宿主会话内打开 Figma 视图 | 客户端嵌入/路由集成；不是通用设计 REST 能力  Figma宿主嵌入专属；Futureox嵌入另议 | 非目标；独立替代另议 |

get_design_context 的参考代码应视为可供目标工程适配的实现上下文，不能把整张截图充当最终 UI。截图的自然尺寸与输出尺寸应分开；元数据不是高保真样式全集。Make 源代码也能通过资源协议提供。[Make resources](https://developers.figma.com/docs/figma-mcp-server/bringing-make-context-to-your-agent/)

### 3.2 通用画布、资产与设计生成（6）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| use_figma | R/W | F、code、description | 在文件上下文执行 JavaScript，操作 Plugin API 风格 figma 全局；可创建/编辑/删除/查询原生节点、变量、组件和样式 | 类型化批量操作优先；受限解释器需另审，不以任意eval实现  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| upload_assets | W | F；count?、currentPageId?、nodeId?、nodeIds?、scaleMode?、batchCommit? | 申请单次上传 URL，再 POST 原始字节；raster 可设置目标 fill，未指定则新建；SVG 成可编辑矢量树 | 上传票据、MIME/体积验证、图片去重存储、SVG 解析、原生节点放置  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| download_assets | R | F、N；defaultFormat?、defaultScale? | 整节点 export、原始 raster fills、合适矢量的 SVG；export=png/jpg/svg/pdf；临时 URL | 渲染导出、原图追溯、矢量分离与资源打包  自有设计引擎等价；不代理Figma云端实现/权限 | P0 计划/未验收 |
| generate_figma_design | W/J | F；captureId?、N? | 首次拿 capture 脚本/ID，浏览器采集后按 captureId 轮询；单次捕获 ID；上限50MB | DOM/样式/资源采集、布局反推、场景图导入、异步捕获状态  独立网页采集；Figma私有capture后端非目标 | P2 计划/未验收 |
| generate_image | W/J | prompt；width?、height?、model?、F?、N?、planKey? | 图像生成，结果 PNG/JPEG URL；宽高主要约束比例，不保证精确像素；链接7天 | 独立模型接入、费用、任务、图像资源，后续显式导入  可选独立生成器；Figma模型/额度非目标 | P2 计划/未验收 |
| generate_diagram | W | mermaidSyntax、name；F?、planKey? | 新建或写入 FigJam 的可编辑图；支持 graph/flowchart/sequence/state/gantt/ER | Mermaid 解析、图布局、形状/文本/连接器映射  自有设计引擎等价；不代理Figma云端实现/权限 | P2 计划/未验收 |

upload_assets 的当前限制为每资产10MB、每次至多60个上传 URL；nodeIds 按返回槽位顺序对应，SVG 不使用 raster 的 nodeIds/scaleMode 语义。不要把“拿到上传 URL”视为上传成功；不要把“捕获完成”视为已经生成复用组件的设计系统。

use_figma 与 Plugin API 不是完全相同的执行环境。当前契约明确不支持 loadAllPagesAsync、setPluginData、createImageAsync；因此不可承诺现成 Figma 插件任意运行。图片进入文档应使用资产通路。官方还说明其远程字体需在账户可用，写画布有输出预算及 beta 限制。[写画布限制](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)

### 3.3 变量、样式、库与 Code Connect（9）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| get_variable_defs | R | F、N | 选择范围内使用的变量/样式；不是所有变量集合管理接口 | used-token 追踪、作用域内解析  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| get_libraries | R | F；offset? | 已订阅库、可添加库；组织可用库有后续 offset | 租户库目录、订阅关系、权限、分页  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| search_design_system | R | F、queries[{entity,query}]；includeLibraryKeys?、disableCodeConnect? | entity 为 component/variable/style；批量搜索，每个返回项对应同序请求；可限定库 | 类型化资产索引、搜索、库过滤、代码映射富化  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| get_code_connect_map | R | F、N；codeConnectLabel? | 实例/节点到代码组件来源及名称，可能有 snippet/imports/label | 组件映射注册表、实例解析、框架选择  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| add_code_connect_map | W | F、N、componentName、source、label；template?、templateDataJson? | 单条映射；带 template 表示完整可执行模板，不只是路径关联 | 持久化映射 + 模板版本与编译/安全边界  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| get_code_connect_suggestions | R | F、N；excludeMappingPrompt? | 建议组件映射策略；不是已保存映射 | 匹配/候选排序、置信度及审阅流程  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| get_context_for_code_connect | R | F、N | 单组件/组件集合属性、variant、后代实例/文本与属性引用 | 组件语义树、稳定 selector、模板上下文  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| list_file_components_for_code_connect | R | F | 全文件已发布组件/组件集合、属性与依赖图；未发布本地组件不包含 | 已发布资产图、依赖排序、slot/variant/instance 语义  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |
| send_code_connect_mappings | W | F、N、mappings[]；clientFrameworks?、clientLanguages? | 一批映射保存；每项包含 nodeId、source、componentName、label，以及可选 template/templateDataJson | 批量校验、映射提交、逐项结果/错误  自有设计引擎等价；不代理Figma云端实现/权限 | P1 计划/未验收 |

label 是枚举而不是任意字符串，当前为 React、Web Components、Vue、Svelte、Storybook、Javascript、Swift、Swift UIKit、Objective-C UIKit、SwiftUI、Compose、Java、Kotlin、Android XML Layout、Flutter、Markdown。

组件代码映射的价值是把设计属性转成真实组件调用、props 与 import；仅保存“节点→文件路径”只覆盖简单层。Futureox 要保留多框架标签、嵌套组件与实例属性，不宜把代码映射和视觉节点混成同一对象。官方说明 UI 映射和 CLI 模板的细节精度不同，模板可跨框架生成代码。[Code Connect 集成](https://developers.figma.com/docs/figma-mcp-server/code-connect-integration/)、[Code Connect 模板](https://developers.figma.com/docs/code-connect/)

### 3.4 Slides 与视频（2）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| generate_deck | W/J | title、description、objectives[]、outline[]、templateQuery；theme?、rules?、planKey? | 产生至多3套可编辑 Slides 候选及缩略图/链接；outline 每页含目的、角色、主题、内容、视觉建议，邻页上下文可选 | 模板/主题检索、叙事规划、图文布局、原生 slides、预览  可选独立deck生成；Figma模板云非目标 | P2 计划/未验收 |
| export_video | R/J | F + N 或 jobId；fps?、quality?、constraint?、ttlSeconds? | 顶层时间轴 frame/slide 导出MP4；处理中返回 jobId，再查；nodeId/jobId互斥 | 时间轴离线渲染、视频编码、队列与过期资源  自有设计引擎等价；不代理Figma云端实现/权限 | P2 计划/未验收 |

export_video 当前契约：fps 5–60；quality=low/medium/high；constraint 以 SCALE/WIDTH/HEIGHT 控制等比输出，上限10倍和每边4096px；保留时长默认1小时，服务端限制30秒至7天。轮询阶段不应改变起始渲染参数。当前不提供 GIF/animated SVG 导出等价保证。

### 3.5 Code/Make 代码项目和生成会话（5）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| send_code_to_figma | W/J | F；pageId?、repairFrom?、upload? | 两阶段项目归档导入；先拿上传指导，成功上传后继续；输出 importReceipt、目标文件/节点；Design 里成为代码层，不是原生形状 | 项目包导入、路径安全、沙箱构建、代码层、幂等续传状态  可选自有项目导入；Figma Code环境非目标 | P3 计划/未验收 |
| get_chat_threads | R | F；N? | 可继续的 Code 会话；代码层可有自己的会话；其他节点未必缩小范围 | 文件/代码层绑定的会话记录  可选自有会话；Figma会话库非目标 | P3 计划/未验收 |
| send_prompt | W/J | F、prompt；N?、pageId?、threadId?、messageType?、attachment_count?、attachmentUploadResume?、continuation? | Code agent 创建/修改项目；返回runId/threadId/target；附带本地文件时先准备上传槽，再继续生成 | 代码生成代理、会话、附件、目标锁、作业、人工问答  可选自有代码代理；Figma代理非目标 | P3 计划/未验收 |
| check_prompt_status | R/J | F、runId | in_progress/needs_input/completed/failed/credits_exhausted/aborted/unknown；有 pollAfterMs 与待答问题 | 单作业状态机、事件、可恢复问答、完成证据  可选自有作业；Figma run访问非目标 | P3 计划/未验收 |
| publish_to_gallery | W/J | F、runId；title?、description? | 符合条件独立 Code 文件部署并投稿 Gallery；要求已完成生成与最终部署验证 | 站点部署、外部发布授权、公共目录、发布回执  Figma Gallery投稿非目标；自有发布另议 | 非目标；独立替代另议 |

关键区别：
- 原生设计写入、网页捕获、项目导入、代码生成是四条不同流水线，不能让它们都返回一个“designId”然后宣称同等可编辑。
- send_code_to_figma 的 upload.archivePath 是服务端存储路径，不是本机路径；首次阶段的 upload 省略。
- send_prompt 的附件为1–10项、每项至多5MiB、上传续接窗口1小时；附件不是仓库整体替换。
- needs_input 要保留原问题/选项/上下文与 continuation 目标；重发同一 prompt 不是轮询。
- check_prompt_status 的已完成记录保留1小时；unknown 不能解释成成功。
- 导入成功不等于依赖安装成功、预览成功或发布成功，验收状态应分开。

Figma 当前将图像生成、Make 提示与 Weave 的计费分别处理；其配额也随计划和席位变化。Futureox 应暴露独立能力/额度信息，而非写死某一历史配额。[官方当前配额与计费边界](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)

### 3.6 生成插件和 Shader 资源库（9）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| list_generative_plugins | R | cursor? | 账户可见插件目录，含ID/名称/描述/owner及nextCursor | 扩展资源目录  可选自有目录；Figma账户库非目标 | P3 计划/未验收 |
| get_generative_plugin | R | id；version?、includeSource? | 元数据、版本、源文件清单与resource URI；可选内联源码 | 版本化源码资源与权限  可选自有源码；Figma私有源码授权非目标 | P3 计划/未验收 |
| create_generative_plugin | W | name、description、planKey | 创建可运行 starter；不是用户最终需求已完成 | 脚手架创建、归属、ID  可选自有脚手架；Figma模板非目标 | P3 计划/未验收 |
| update_generative_plugin | W/J | id、commitMessage；files?、metadata? | 可替换 code.ts/ui.html 完整内容；可改名称描述 | 源码校验、构建、版本、发布  可选自有构建版本；Figma部署非目标 | P3 计划/未验收 |
| list_shaders | R | cursor? | shader fill/effect 资源目录 | Shader 注册表  可选自有效果目录；Figma库非目标 | P3 计划/未验收 |
| get_shader | R | id；version?、includeSource? | Shader 元数据/版本/文件清单/源码资源 | Shader 源码资源与版本  可选自有Shader源码；Figma源码授权非目标 | P3 计划/未验收 |
| list_file_shaders | R | F | 文档使用的shader及版本、发布状态和源码清单 | 文档→效果依赖图  可选自有效果依赖；Figma资源权限非目标 | P3 计划/未验收 |
| create_shader | W | name、description、planKey、kind | 创建effect或fill starter | Shader 模板、资产归属  可选自有Shader脚手架；Figma运行时非目标 | P3 计划/未验收 |
| update_shader | W/J | id、kind、commitMessage；files?、metadata? | main.ts整文件替换，kind匹配原资源；metadata含name/description/isAnimated/usesMouse | 编译、运行时特征、版本、部署  可选自有编译部署；Figma运行时非目标 | P3 计划/未验收 |

通用语义：
- version 可指定40字符提交SHA；读默认最新已构建版。
- get_* 默认给资源URI；includeSource 为资源读取不可用时的内联替代，当前上限100文件、总量1,000,000字节。
- 更新为指定文件的完整内容替换，不是diff；未提交文件保留；不能以任意路径新增工程文件。
- Generative plugin 不等于安装任意 Community 插件。创建插件资源、更新其代码、在画布运行插件是不同能力。
- shader effect 处理底层输入画面；shader fill 自己产生像素。
- Futureox 若做等价资源平台，需要独立编译/隔离/版本/运行时；不能假设 Figma 专属控件与部署机制可直接复用。

公开资料确认这是版本化源码读取、starter创建、整文件更新与服务端构建/部署的资源流程。[插件与Shader流程](https://developers.figma.com/docs/figma-mcp-server/generative-plugins-and-shaders/)

### 3.7 Weave 模型与工作流（9）

| 工具 | 类型 | 主要输入 | 结果与语义 | Futureox 对应底层能力  边界/非目标 | 阶段与初始状态 |
|---|---|---|---|---|---|
| weave_list_tools | R | search? | 发布的工作流目录 | 工作流目录/搜索  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_get_tool_inputs | R | recipeId；version? | 扁平输入契约、版本、默认值、必填、枚举、范围、迭代和输出摘要 | 动态输入schema及版本锁  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_run_tool | W/J | recipeId；version?、inputs[{nodeId,value}]?、numberOfRuns?、acknowledgedCost? | 未确认费用时只报价；确认后创建一组runId | 报价→授权→作业，批量运行与费用约束  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_get_tool_run_output | R/J | recipeId；runIds? | RUNNING/COMPLETED/FAILED/CANCELED、进度、错误、媒体链接；省略runIds取最近 | 作业观察和类型化产物  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_cancel_tool_run | W | recipeId；runIds? | 取消指定或本人该工作流所有正在跑的作业 | 取消请求、计费/资源终止状态  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_find_model | R | query | 模型候选、ID、输入/参数契约、预估费用 | 模型目录与契约  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_run_model | W/J | id、input；acknowledgedCost? | 直接模型运行，返回predictionId；不经工作流 | 单模型网关、费用与作业  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_get_model_run_output | R/J | predictionIds[] | 直接模型作业输出/状态 | 模型作业轮询  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |
| weave_upload_asset | W | 无 | 上传地址与约10分钟token；multipart提交后得到资产对象 | 带时效上传票据与媒体资产  Weave账户/模型/费用非目标；自有媒体编排可选 | P3 计划/未验收 |

这是可独立排期的 AI 媒体服务子产品，不是原生设计 CRUD 的先决条件。模型运行与工作流运行有不同 ID 和状态接口，不应混用。把报价、明确授权、输入默认值确认及实际执行拆开，是 Futureox 可采用的设计，不代表 MCP 协议自带账务系统。

## 4. use_figma 背后应对齐的对象语义

以下是从公开 Plugin API 归纳出的设计引擎能力基线，**不是对当前远程执行器所有方法的实测可用承诺**。

| 对象域 | 最低有用语义 | 为什么不能仅做JSON存储 |
|---|---|---|
| 文档/页面/节点 | 稳定ID、父子层级、增删/克隆/重排、查询、名称、可见/锁定、坐标变换 | 编辑器、导出与查询必须看到同一树和同一坐标 |
| Frame/布局 | 固定与自适应尺寸、HUG/FILL、水平/垂直布局、间距/padding/对齐、嵌套约束、绝对定位 | 子节点变更必须触发确定性的布局重算 |
| 图形/矢量 | 基础形状、path、矢量网络、布尔、fill/stroke、圆角、遮罩、效果、透明与blend | PNG/SVG与编辑器显示要保持一致 |
| 文本 | 字体发现/加载、字体run、字号/行高/字距、范围样式、换行、自动尺寸与富文本 | 真正文本测量决定布局，字符串长度不是测量替代 |
| 变量 | BOOLEAN/FLOAT/STRING/COLOR、集合、mode、alias、作用域、节点绑定、代码语法 | 模式切换和别名变化应传播；避免循环引用 |
| 样式 | 色彩/文字/效果/网格样式及引用 | 共享样式更新要传播且保留实例引用 |
| 组件 | component/set、variant、公开属性、instance、主组件身份、overrides、swap、detach | 克隆图形不能代替组件实例；主组件更新需传播 |
| 库 | 发布资产key、本地/远程、订阅/导入、版本和可用性 | 搜索命中只是索引，导入须得到可用的真实引用 |
| Code Connect | 多框架映射、props、imports、嵌套模板、component依赖 | 才能复用真实工程组件，而非每次生成div |
| 动画 | timeline、duration、track、keyframe、easing、组合时间基准 | code与视频要从同一时间模型输出 |
| FigJam | shape/sticky/text/table/connector、连接端点、图布局 | 线条端点不能只是截取时的像素 |
| Slides | slide与顺序、尺寸、文本/图片/布局、逐页预览 | 可编辑演示稿不等于一叠PNG |

公开 Plugin API 定义了节点创建、异步节点查找、页面与变量/库入口；Frame 是布局容器；组件与实例有继承更新及覆盖语义。[Plugin API](https://developers.figma.com/docs/plugins/api/figma/)、[Frame](https://developers.figma.com/docs/plugins/api/FrameNode/)、[Component](https://developers.figma.com/docs/plugins/api/ComponentNode/)、[Instance](https://developers.figma.com/docs/plugins/api/InstanceNode/)、[Variables](https://developers.figma.com/docs/plugins/api/figma-variables/)

Figma REST API 适合作为读取/导出与部分管理接口的参考，但它不是通用画布写入API。文件接口有文档树、局部节点、导出与原图；Variables REST API单独支持变量集合、mode、变量和mode值批量修改，且有计划/权限限制。[文件REST接口](https://developers.figma.com/docs/rest-api/file-endpoints/)、[变量REST接口](https://developers.figma.com/docs/rest-api/variables-endpoints/)

## 5. 建议的 Futureox 分层与开放接口

本节全部为 R：独立产品设计建议，不是现有Figma接口描述。不要求重写或调整现有渲染算法；自动化应使用已有场景/渲染能力，并以回归测试保护它。

### 5.1 核心分层

1. **Design Core**：唯一文档模型、布局、文本、组件、变量、样式、动画与变更操作。
2. **服务API**：鉴权/租户、文件、查询、批量变更、资产、导出、库、代码映射、异步作业。
3. **MCP Adapter**：把稳定服务API封装成工具、资源与提示；不另建一份影子文档。
4. **受限脚本/操作API**：优先提供类型化操作列表。只有隔离、权限、超时、资源预算及兼容用例均成立后才考虑受限脚本。不得以任意eval、new Function或暴露宿主进程冒充use_figma；不支持的调用明确返回unsupported。
5. **客户端**：交互编辑器、可视化审阅、作业状态、授权与预览。
6. **可选生成服务**：文生图、布局生成、deck、code agent、Weave等价媒体工作流。

### 5.2 建议优先开放的API族

- 文件：create/get/list、pages、角色与能力、revision。
- 查询：get node/tree、typed query、metadata、selection context、design context。
- 变更：create/update/delete/move/clone/group、batch mutations、script execute。
- 布局/文本：set layout、measure text、font availability、text ranges。
- 变量/样式：collections/modes/values/aliases/bindings、shared styles。
- 组件/库：components/variants/instances/properties/overrides、publish/import、asset search。
- 视觉：screenshot、render/export、原图下载、批量导出、产物元数据。
- 资源：upload ticket/commit、SVG import、assets manifest、library search。
- Code Connect等价：mapping CRUD、template registry、component context、dependency graph。
- 作业：start/get/events/cancel/resume、input_required、cost quote/approval、artifact links。
- 扩展：plugin/shader source/version/build/status；代码项目import/generate/preview/deploy。
- 能力发现：编辑器支持、格式支持、限制、版本、计费模型，避免客户端猜测。

### 5.3 MCP协议本身该做什么

- tools/list、tools/call：参数的JSON Schema；将状态读和有副作用执行分开，明确输出schema及错误。
- resources/list、resources/read、resource templates：源码、资产、文档快照；支持URI、MIME、可选订阅/列表变化。
- prompts/list、prompts/get：如项目设计规范生成，属于prompt而非画布API。
- 远程使用Streamable HTTP；本地可选stdio；按协议版本协商，不硬编码未来版本。
- 远程授权依OAuth相关规范；作用域区分read/write/export/publish，避免任意脚本突破权限。
- Tool annotations仅是客户端提示，不能取代服务端鉴权、费用确认或目标检查。

这些是协议能力，不提供设计工具算法。参照[MCP工具](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[资源](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

### 5.4 推荐的执行可靠性合同

- 每次写入返回 changed/created/deleted IDs、before/after revision、mutationId及部分失败信息。
- 提供 optimistic revision 检查和 idempotency key；对超时/断网支持查询已有操作，不盲重放。
- read-only脚本使用真正只读上下文，不靠描述文字判断；写入脚本禁止任意文件、网络及秘密访问。
- 不承诺一段任意JS天然事务化；明确原子批量边界、回滚/撤销和部分提交。
- 图像输出包含自然尺寸、渲染尺寸、格式、revision、到期时间；预览应对应确切文档版本。
- 资源上传区分 allocated/uploaded/validated/committed；SVG禁用脚本、外链与危险实体。
- 模型/代码作业有稳定runId、状态与继续条件；unknown明确为未知，不当作完成。
- 发布到公共站点或Gallery等价目录，必须单独授权与可核验回执。
- 超限用分页、截断标志和子节点建议；禁止静默截断后假称完整。
- 任意自动生成结果，验收至少同时看结构与渲染；不要只检查返回JSON存在。

## 6. 应覆盖的端到端工作流与验收

| 工作流 | 顺序 | 最终验收 |
|---|---|---|
| 设计转工程代码 | 定位文件/节点 → context+截图 → 读变量/映射/资源 → 适配项目 → 局部对照 | 真实组件复用、静态资产完整、布局与文字一致、交互符合需求 |
| 从零原生界面 | 查文件/库 → 建tokens → 建组件 → instance布局 → 预览 | 可选中/编辑层级、实例关系、变量绑定与布局有效 |
| 现有界面修改 | 查当前revision/目标 → 有界修改 → 返回变更证据 → 新预览 | 不重建无关树、旧引用尽量稳定、越界改动为零 |
| 网页转设计 | 运行页面 → 浏览器采集 → 任务完成 → 原生层导入 → 可选组件化 | DOM层不是截图；资源字体齐；布局可编辑 |
| 代码导入与继续生成 | 请求上传 → 完整包提交 → 导入回执 → setup/preview → prompt → poll/resume | import/install/preview/test/deploy状态分别可见 |
| 设计系统同步 | 查本地与发布资产 → 差异规划 → 变量/组件更新 → 验证实例 → 更新映射 | 无重复key、别名无环、variant完整、旧实例可用 |
| 跨文件资产迁移 | 读原图 → 上传目标 → 放置/绑定 → 验证hash/格式/显示 | 图片不被无意压缩成截图；SVG保留可编辑性 |
| 动画交付 | 静态context → motion context → 代码或MP4 job → 成功产物 | 时间轴根正确、帧率/尺寸一致、媒体可播放 |
| 生成插件/Shader | list/get → create starter或选已有 → 完整源码更新 → build → 测试 | 版本与构建日志齐，运行效果和授权边界正确 |
| 媒体工作流 | 查动态输入 → 填值/资产 → 报价授权 → run → poll/cancel →产物 | 不重复计费、正确参数版本、终态与输出可核验 |

### 最低验收用例

1. 元数据→节点详情→预览三者对同revision一致。
2. 相同文档分别经UI与API改动后，另一端立即读取到同一状态。
3. 文本修改触发HUG容器和兄弟节点正确重排；缺字体有明确错误或受控替代。
4. 改一个token后多个绑定节点同步；mode切换、alias与循环检测正确。
5. 改主组件后实例更新且合法overrides保留；swap和detach语义明确。
6. raster原图能回收且MIME/尺寸一致；SVG导入后仍是矢量树。
7. 大节点请求能明确分片；截断信息不会伪装完整。
8. 失败写入和网络超时后可判断提交程度；重试不产生重复层。
9. 跨租户、只读文件、无效nodeId、失效上传票据、越权脚本都有负面测试。
10. 作业经过needs_input/failed/canceled/unknown时不会被客户端误判completed。
11. 在支持格式上导出成功；未支持格式返回明确capability错误，不返回占位产物。
12. 发布作业在缺少目标授权或未验证预览时拒绝，避免意外公开。

## 7. 实施优先级建议

以下是完整能力路线；本轮已实施和验证的有限范围见第9节。

- **P0 原生设计闭环**：身份/文件/页/节点、只读context、受控批量写、布局/文本/样式、截图、资产上传/下载、稳定ID/revision/错误/权限。先保证现有渲染不被此研究任务更改。
- **P1 设计系统闭环**：变量mode/alias/binding、组件variant/instance/override、库导入搜索、Code Connect等价、SVG/PDF、跨文件资产。
- **P2 内容生产**：网页capture、FigJam图、Slides/deck、动画与视频、生成任务/人工续接。
- **P3 可扩展与生成平台**：项目导入/代码agent/部署、插件/Shader源代码平台、媒体工作流及模型网关、宿主内嵌应用。

不建议以“先把48个名字都挂出来”作为第一阶段完成条件。可以在协议层先返回精确 capabilities，把未实现模块明确标为unsupported；已实现部分必须具备真实持久化与可验收结果。

## 8. 状态维护规则与完成判据

每项能力负责人应补齐：能力ID/接口版本、负责人、实现路径、支持编辑器/节点类型；输入输出schema、权限和副作用；失败/超时/部分提交行为；正向与负向测试、幂等/冲突测试、验证命令；结构证据和对应revision的视觉证据；已知差异与后续工作。

状态仅使用：计划/未验收、实现中、部分支持、已验收、阻塞、非目标。不得因方法名存在、HTTP 200、空数组或占位图片而标记完成。已验收也只覆盖明确列出的类型、参数、格式及权限组合。

48项是能力盘点范围，不承诺完整复制Figma。分别报告核心设计自动化、可选高级功能、云厂商专属非目标，不把非目标算作实现成功，也不隐去以制造100%兼容结论。


## 9. 本轮已验证的实现范围（2026-10-19）

本节记录独立Futureox能力的工程证据，不把它们算作48项Figma工具全部通过。更高层节点/组件/字体/资产导出的支持范围，应以实时capabilities、对应测试与实际产物为准。

| 子系统 | 当前状态 | 已核验范围 | 证据与剩余边界 |
|---|---|---|---|
| SQLite配置、审计、编辑记录与任务元数据 | 已验收（限定后端合同） | 复用现有workspace数据库；schema v5；人工/自动化来源、文档筛选与游标；严格白名单、行数/长度/保留期、重启持久化、v3/v4迁移与失败回滚 | `crates/design-desktop-backend/src/automation.rs`及13项专用测试；CPU后端完整回归83通过、1项已有字体基准忽略。仅元数据，不代表执行器/恢复授权已实现 |
| 本地临时授权与Electron桥接 | 部分支持 | 默认关闭；原生确认；只读/读写范围；文档+session+revision围栏；撤销/断开/超时；凭据不在status/SQLite；可信主frame IPC | 独立源码审查及内存传输测试通过；真实Unix socket测试在本环境因`listen EPERM`阻塞，未据此宣称跨平台打包运行已验收 |
| MCP stdio协议适配 | 部分支持 | initialize、tools、resources、prompts、结构化结果、取消/超时、输入输出预算；工具来自实际操作schema；不提供任意JS/文件/网络执行 | MCP与host内存测试合计49通过；协议测试不等同于每种设计结构和每个导出格式的端到端验收 |
| 包装与交付路径 | 部分支持 | Electron脚本复制完整src目录，包含新的bridge模块；MCP CLI为独立Node程序，不是Electron自动附带的可执行文件 | 需Node>=22和CLI目录；正式安装包、签名、公证、Windows命名管道行为仍需目标平台验证 |
| 性能基线 | 已验收（单次本机测量） | Linux x86_64 debug后端，真实stdio+SQLite；1000次编辑记录写入p50=1.172ms、p95=1.759ms；100条过滤读取p95=6.573ms；保留1000条、数据库258048字节 | `testing/automation-sqlite-benchmark.py`和结果JSON可复现；不包含GUI/GPU/渲染，也不是发布版SLA |

后端实现在`design-studio/crates/design-desktop-backend/`。验证日志位于`testing/verification-automation/`。存储接口、隐私边界与运行命令见[本地记录与SQLite说明](DESIGN_AUTOMATION_STORAGE.zh-CN.md)。

当前仍需分别验收：真实桌面UI到MCP再回到UI的完整编辑闭环、对应revision的视觉结果、正式分发包启动、各目标平台本地IPC。任务元数据仅保存任务状态，不会自动恢复或重新执行任务；重启后必须重新授权桥接。没有实现的Figma云端生成、部署、Weave计费和发布能力继续保留计划/非目标状态。
