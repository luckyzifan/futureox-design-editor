# 本地自动化边界独立检查

日期：2026-10-19；本次文档核对基于最新整合树及资源优先输出实现。检查对象：Electron bridge、可信IPC、MCP stdio/socket适配器、输出资源缓存、SQLite元数据及打包脚本。检查方式：源码核对、CPU/in-memory负面测试、实际SQLite后端回归。不是渗透测试认证。

## 结果

本次检查未发现已证实的高严重度权限绕过。发现的审计元数据错误代码长度不一致已修复为64字符；传输预算为32 MiB帧上限/8 MiB普通请求，MCP默认tools/call结果另有256 KiB的模型上下文预算。较大传输只向指定导入、导出及显式资源读取开放。MCP CLI独立分发的说明已补入`frontend/design-mcp/README.md`。

此前待核实的两项host问题现已修复：socket帧用`TextDecoder("utf-8", { fatal: true })`严格解码；renderer回复必须恰有`result`或`error`之一，并校验error对象的code/message类型。已加入明确拒绝坏输入的负面断言，具体覆盖范围见下文；这不等于真实Electron窗口和操作系统socket已经验收。

## 已核对的边界

- 桥接默认关闭，授权由原生确认触发；scope限定read/write；偏好存储不能替代授权。
- Unix使用临时私有目录0700及socket0600，客户端检查当前用户所有权、非symlink、规范父路径、socket类型。没有TCP URL/任意远程地址接口。
- Windows仅接受产品命名的本地named pipe及临时token；实际平台权限/ACL仍待Windows验证。
- token为临时高熵值，恒定时间比较；持久化偏好/状态/SQLite不含token或endpoint；CLI只从环境取token、不提供token命令行参数。桥接错误有token脱敏测试。用户主动复制连接信息到系统剪贴板仍会产生剪贴板留存，应避免粘贴进日志/仓库。
- Host只接受指定window的真实mainFrame及精确app URL；注册/执行/回复/设置等IPC均校验sender。
- Host与MCP适配器均过滤只读权限；host还按注册的method白名单、显式documentId/session和写入expectedRevision检查。注释/工具annotation不是授权来源。
- 切文档、session变化、导航、关闭与撤销授权同步失效旧能力；不自动重连其他文档。
- 桥接限制4连接、每连接8请求、5秒认证期限；普通帧8 MiB，font/document/Sketch import及符合规则的一级batch可用32 MiB；document.export和sketch.export可用较大结果帧。缓冲+待处理原始输入48MiB，每连接最多一个heavy请求，输出队列40MiB。
- MCP限制8请求、1heavy、48 MiB待处理输入、40 MiB输出队列、65536个请求ID/session；默认tools/call完整结果不超过256 KiB，并为外层JSON-RPC预留空间。普通大查询返回result_too_large，要求缩小范围或分页，不静默删除字段。资源缓存为16项/32 MiB，文本也可使用该有界预算，不再是旧版4 MiB单项限制。原始帧预算不等于进程RSS上限，JSON对象/编码副本仍有额外内存。
- 取消/超时传递AbortSignal，错误明示已派发写入可能已经提交；不重试、不伪称回滚。客户端断开会清理受跟踪请求，忽略取消的工作仍占有MCP槽位直到终结/会话关闭。
- 导出采用资源优先输出：HTML/CSS、SVG/native JSON正文、FD/Sketch base64、非空代码资产清单不进入tools/call的inline结果；structuredContent保留元数据、resourceOnly和字段对应的资源引用。大型元数据另存为明确的$metadata资源。直接共享operation API的返回值没有因此改变。
- resources/read仅显式读取进程内已经生成的原始文本/blob，不触发任意文件读取或网络取回。建立链接前测量序列化后的资源响应，包括JSON转义，并为JSON-RPC/最长请求ID预留2 KiB；不能适配32 MiB帧的资源不会被宣称可读。
- 同一次导出的全部资源原子准入缓存，不能容纳时返回artifact_unavailable并要求缩小/拆分，不回退为inline大文件，也不静默丢弃不可获取的内容。后续导出可能淘汰旧资源；过期读取明确返回-32002，断开清空缓存。
- AI检查应使用有界context.get/node查询；resources/read用于客户端实际保存文件。显式读取本身仍会返回完整文件，不能据此宣称客户端模型上下文完全不会收到大数据。HTML/SVG在适配器中作为惰性字节，不执行。
- SQLite允许列与类型严格校验、参数化SQL、有限行数/长度、事务迁移与失败回滚。记录内容只为元数据；历史不是授权表或自动任务执行器。
- Electron打包脚本完整复制desktop/src，因此包括bridge；不会自动复制sibling MCP CLI或外部Node。没有启动正式安装包的证据。

## 实测证据及其边界

以下是定向验证，不是整个PR的总通过数，也不代表安全认证：

- 本次文档更新时重新执行host内存测试与MCP默认测试文件：59通过、0失败、0跳过，分为host 13项和MCP 46项。MCP测试包括实际spawn的stdio子进程，但其后端/流替身不证明桌面授权、真实socket或设计操作已经执行。
- `automation-bridge.test.mjs`使用MemorySocket与受控dispatch，测试认证、只读拒绝、session/revision、超时、限流等协议逻辑。它不启动Electron或操作系统监听。
- UTF-8负面用例在合法JSON字符串中插入非法字节，断言PARSE_ERROR、连接关闭、dispatch次数仍只有先前认证的一次。回复互斥用例断言缺少result/error、同时出现两者、null错误或非字符串错误code均抛出INVALID_RESPONSE。该用例直接注册mock IPC handler且stub了assertSender；合法但未知requestId返回accepted:false，只证明形状检查，不能冒称已完成真实renderer待处理请求的成功回复。
- IPC sender/mainFrame校验另有受控window/frame对象测试。它验证`assertSender`分支和拒绝路径，不等同于实际Electron跨frame攻击验证。GUI原生授权确认和剪贴板还需要目标设备验收。
- 资源测试校验：inline导出字段确实缺席、原始文本/blob逐字节相同、缓存原子失败不淘汰既有文件、过期明确报错、JSON转义及最长ID下的完整读取帧可容纳、超出模型预算的大查询明确失败。输出队列同时测试“已经读完的连续响应不会错误占用预算”和“受控Writable未排空的写入仍触发上限”。断言并非仅检查请求返回或硬编码成功值。
- `src/automation/mcp-e2e.test.ts`另有8项通过：真实Editor、真实WASM和共享operation API经MCP NDJSON内存流连接，覆盖实际创建/布局/文字细改、撤销重做、陈旧revision与原子回滚、HTML/SVG、FD/Sketch导出和重新导入、3000节点分页。没有把Editor/API替换成假文档存储，但该链路没有覆盖Electron host和OS socket。
- 完整17,772,300字节Noto字体用例核对FD资源与直接共享API导出的SHA-256相同，JSON保留相同字体字节，工具响应不含base64/content并小于256 KiB，缓存淘汰后的旧FD引用返回-32002。单独原始FD结果超过30 MiB的断言防止以微型替身掩盖真实负载。
- 已保存的真实样例生成记录中，FD tools/call响应为1,685字节，native JSON为1,634字节；文件由客户端显式resources/read保存。最大工具响应138,368字节。此为该次90节点样例测量，不是所有文档的性能保证或GPU/视觉质量证明。
- SQLite CPU后端记录为83通过、0失败、1项已有字体体积/时间基准忽略，含13项automation专用测试。单独`automation-storage-bridge.test.mjs`只有配置`FUTUREOX_BACKEND_TEST_BINARY`时才运行实际Sidecar/SQLite；未配置时的skip必须单独披露，不能算通过。即使使用真实SQLite，它的Electron IPC/window对象仍是mock。
- 实际Unix socket测试此前在此执行环境发生`listen EPERM`：host 8项与MCP 5项不能建立监听；同批另1项纯IPC通过不应混入socket成功数。本次文档更新没有重试或绕过该限制，没有把监听失败改成通过，也没有用内存测试冒称socket已验证。
- 正式安装包运行、macOS/Windows实际权限、GUI授权/剪贴板和真实Codex完整会话仍待目标设备验收。

### 可复现命令与PR门槛

```sh
# MCP：只运行明确列出的无监听测试，其中含stdio子进程
(cd frontend/design-mcp && npm run check && npm test)
# Host：MemorySocket / mock IPC，不等同于Electron运行时
node --test frontend/design-desktop/test/automation-bridge.test.mjs
# 真实Editor/WASM/API，但传输采用内存流
(cd frontend/design-client && node_modules/.bin/vitest run src/automation/mcp-e2e.test.ts)
# 有相应权限的目标设备上另外运行真实socket验证
(cd frontend/design-mcp && npm run test:integration)
node --test frontend/design-desktop/test/automation-bridge-socket.test.mjs
```

PR审查应分别记录断言通过、环境阻塞和显式skip；不能只汇总退出码或挑选替身测试来替代受影响的真实边界。未执行变异测试，不声称已经通过变异测试；本报告列出的负面输入、字节一致性和实际状态变化是当前可复核证据。遇到真实失败应保留日志并修复实现或明确声明缺口，不以删除断言、弱化期望值或条件跳过制造绿色结果。

可复核路径：`frontend/design-desktop/src/automation-bridge.mjs`、`security.mjs`、`main.mjs`、`preload.cjs`；`frontend/design-desktop/scripts/package.mjs`；`frontend/design-mcp/src/`；`design-studio/crates/design-desktop-backend/src/automation.rs`。
