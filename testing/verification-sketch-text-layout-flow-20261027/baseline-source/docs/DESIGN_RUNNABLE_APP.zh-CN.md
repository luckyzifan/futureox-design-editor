# 可运行页面导出 v1

## 实际能力与边界

新增只读共享操作 `app.export`，对应 MCP 工具 `design_app_export`。它把**真实设计节点**与调用方显式提供的、版本化声明式行为配置编译成可以离线打开的 HTML/CSS/JavaScript 应用。现有 `code.export` 仍然只输出静态 HTML/CSS，其 `script-src 'none'` 未放宽。

可执行内容包括：

- 跨同一设计文档多个真实页面的本地 hash 路由，以及浏览器返回/前进
- 真正的 `button`、`form`、`input` 与可访问名称、聚焦和验证错误反馈
- 必填、文本长度、邮件格式、数字范围校验
- 本地集合的新增、读取、编辑、删除；取消编辑不提交修改
- 有类型的本地状态 `state.set` / `state.toggle`，状态及集合数量的文本绑定
- 按设计文档 ID 和应用 ID 隔离的 localStorage，重新打开时恢复数据
- localStorage 被禁用、配额不足、存储损坏或结构版本不符时的明确提示

这不是仅挂有事件名称的静态样例。导出的 `app.js` 包含闭集解释器，按钮、表单、列表会真实修改浏览器内的数据。它也**不从任意画面自动猜测业务流程**。调用方必须显式给出路由、动作、集合、字段和节点绑定；可先调用 `context.get` 获取真实节点 ID，再决定应用行为。

不提供、也不假定存在登录认证、生产后端、远程 API、云数据库、支付、服务器部署、同步或加密。本地数据不是秘密存储，不应放入凭据或敏感生产记录。动态列表行是根据集合数据创建的可访问 HTML 控件，绑定到真实设计中的列表宿主；并非把这些运行时行伪装成已创作的设计节点。

## 请求与响应

```json
{
  "method": "app.export",
  "params": {
    "version": 1,
    "pageId": "默认真实页面 ID",
    "maxNodes": 200,
    "app": {
      "id": "project-notebook",
      "routes": [
        {"path": "/overview", "pageId": "真实页面 A", "nodeId": "A 的真实根容器", "title": "Overview"},
        {"path": "/tasks", "pageId": "真实页面 B", "nodeId": "B 的真实根容器", "title": "Tasks"},
        {"path": "/edit", "pageId": "真实页面 C", "nodeId": "C 的真实根容器", "title": "Edit task"}
      ],
      "initialRoute": "/overview",
      "state": {"compact": false},
      "collections": [],
      "forms": [],
      "actions": [],
      "lists": [],
      "textBindings": []
    }
  }
}
```

上例中的描述性 ID 必须换成同一设计文档内真实节点和页面 ID。完整可运行的三页面配置及原创设计节点构造在 `frontend/design-client/src/automation/app-export-fixture.ts`；`api.capabilities` / MCP `tools/list` 返回机器可读的完整输入 schema。

返回格式为 `futureox.design-app.v1`，包含：

| 字段 | 保存文件 | 作用 |
| --- | --- | --- |
| html | index.html | 语义 DOM、离线 CSP |
| css | styles.css | 既有设计导出的布局与样式，加表单/列表运行时样式 |
| javascript | app.js | 可信解释器和经安全序列化的显式配置 |
| appJson | app.json | 实际使用的配置、节点映射、存储命名空间及结构签名 |
| readme | README.md | 打开方法、功能与限制 |

另外返回 `nodeIdMap`、`assets`、`warnings`、`pageIds`、`sourceNodeCount`、`fidelity: "approximate"`。MCP 将源码字段原子地转换为资源链接，不把 JavaScript 当工具代码执行；客户端通过 `resources/read` 保存以上文件。`appExportZip` 可在浏览器侧将它们打包成可解压即用的确定性 ZIP，并包含去除内联素材数据的设计清单。

## 行为定义

- `app.id`：非秘密标识符，用来隔离同一文档的不同本地应用。
- `routes`：每条必须指向指定页面的真实根 `frame` / `section` / `group`。不能重叠、不能引用不存在或跨错页面的节点。只接受本地斜线路径，不接受协议、查询或 fragment。
- `actions`：`{nodeId,label,steps}`。节点变成原生按钮，最多 8 步。动作只有 `navigate:{to}`、`state.set:{key,value}`、`state.toggle:{key}`、`form.reset:{form}`。
- `collections`：`{id,fields:[{name,type}],records?}`。字段类型是 `string`、`number`、`boolean`，记录有独立 `id`。数据字段不能叫 `id`，不能使用原型污染键或常见秘密字段名。显式初始数据须满足集合类型；表单输入另执行对应表单约束。
- `forms`：`{id,nodeId,collection,submitNodeId,submitLabel,fields,successRoute?}`。表单和提交控件必须是实际设计节点，输入和提交控件必须位于表单内部。每个集合字段必须恰有一个输入。输入 `{nodeId,name,label,type,required?,minLength?,maxLength?,min?,max?}` 支持 text/email/number/checkbox。
- `lists`：`{nodeId,collection,label,columns:[{field,label}],editForm?,editRoute?,allowDelete?,emptyText?}`。列表宿主必须是叶节点。可编辑列表必须指定同一集合的表单以及该表单所在的路由。动态编辑/删除控件带有 `data-source-node-id`，行带 `data-record-id`。
- `textBindings`：`{nodeId,state?,collectionCount?,prefix?}`。两种数据源恰选一种；节点必须为叶节点。

原生设计动画和 prototype 交互不自动迁移为该应用行为。它们仍保留在原生文档中，导出报告明确警告；应用仅执行上述显式配置。

## 安全与限额

没有 eval、Function 构造器、动态表达式、任意事件脚本、网络动作、服务秘密或自由 HTML 注入。字段白名单、引用关系、角色冲突、数值类型、配置字节数、原型污染键及纯 JSON 结构都会在导出前检查。文本/属性转义与安全 JSON 序列化分开处理。远程或本地路径图片和外链均不进入离线输出；仅携带既有导出器认可的内嵌栅格图像。

默认最多 200 个解析后设计节点，调用方可提高到 500；预算跨所有路由累计。另有 16 路由、128 动作、32 表单、32 列表、16 集合、每集合 24 字段和 500 记录、每值 4096 字符、256 KiB 配置、2 MiB 本地数据、2 MiB 合计嵌入素材和 8 MiB 合计响应限额。已有数据和新表单提交都检查限额。超限失败，不静默截断。

普通输出的 CSP 禁止网络连接、表单网络提交、对象和 base URL；脚本与样式仅从同目录加载。`sandboxedAppPreview` 是单独的预览辅助函数，只允许实际生成的脚本和样式的 SHA-256 CSP 哈希，并要求 iframe 使用返回的 `sandbox="allow-scripts"`，绝不能添加 `allow-same-origin`。不透明来源预览只在内存保存；这不改变原有静态 HTML 预览。

## 运行与验收

直接在浏览器打开解压后的 `index.html`，无需安装依赖或运行服务。`file://` 的 localStorage 行为由浏览器决定：不可用时页面显示“本标签页有效”；真正持久化需要浏览器允许该来源的 localStorage。同一来源、文档和应用 ID 的标签页共享存储，最近一次保存覆盖旧值；没有自动冲突合并或数据迁移。

测试使用真实 Editor/WASM 和真实 MCP JSON-RPC，通过内存流传输取得实际资源，再让 JSDOM 加载原样 `index.html`、`styles.css`、`app.js` 并操作真实 DOM 控件。它覆盖跨页导航、返回/前进、无效/有效表单、新增/编辑/删除、取消、重新打开、命名空间、存储故障、恶意字符串、错误引用、秘密字段、限额和 CSP 结构。

这证明生成物的实际 DOM 行为和协议路径；不等同于 Chromium/Safari 的完整浏览器验收、CSP 执行验收或像素/GPU 渲染验收。本轮没有调用真实浏览器、OS socket 或 GPU。HTML/CSS 沿用既有近似导出能力，不声称原生字体、材质、布局细节和像素完全等价。
