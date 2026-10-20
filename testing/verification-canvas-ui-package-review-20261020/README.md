# Canvas/UI cumulative ZIP 静态审查

审查对象：`futureox-desgin-canvas-ui-performance-cumulative-20261020T1153Z.zip`。SHA-256：`fc28805350c4c3c2ed99089481b9d1dd10a0afda719645597d97a09040b9da2a`。

结论：可作为选择性合并候选，不能直接覆盖当前工作区并推送主分支。包已单独解压，文件内容与其清单的 after 哈希相符；这只验证包内一致性，不是独立签名或实机正确性证明。本轮遵照用户要求，没有执行包内脚本、测试、构建或 GUI，也没有覆盖产品源码、提交或推送。

## 与当前版本的关系

当前提交为 `22b2dcd`，已推送的上一包集成。本地两轮优化仍未提交。

- 清单 634 项，521 项与工作区相同，113 项不同。
- 相对当前 HEAD 有 98 项内容差异；其中包含将已修复的 terminal-quality 测试恢复成旧实现的一项回退。
- 26 项与本地未提交修改重叠：15 项包内仍是 HEAD 旧内容，11 项双方都修改了。
- 只在临时目录进行文本三方合并预览，4 个文件有显式冲突：`desktop-session.ts`、`document-lifecycle-diagnostics.ts`、`kernel/ProgressiveSurface.tsx`、`prepared-document.ts`。没有文本冲突不等于语义已经兼容。
- [逐文件比较及合并预览摘要](comparison.json)。审查结束时，比较涉及的工作区文件哈希全部保持不变。

## 值得保留的新增内容

本地首页、32 个参考画板预设及逻辑尺寸标签；32/96/192 MiB 的非活动页面缓存档位；共享 GPU handle/bitmap 生命周期处理；固体填充颜色和 paint opacity 的预览/提交/取消事务；部分设置与视图菜单中英文；原始 JSON 同步准入；MCP 导入和编辑来源合同；1 MiB/64 项的 CPU 系数字节缓存。

CPU 系数缓存只针对 certified-tent 构造，不改变 GPU 上传、fence 或整个高倍滤波规模，不能当作本地字段复用、精确除法等优化的替代。颜色功能也必须连同 Editor、保存、导出和命令边界整体合并，不能只复制弹层 UI。

## 阻止直接覆盖的明确问题

1. **会撤销已有优化并破坏接口。** 包内 renderer 缺少本地 filterImageFields 和临时字段 pin；texture-prefix 仍使用旧 band 规划；navigation-zoom/render-worker 没有本地平移静默与动态过时瓦片检查。包内 engine 没有本地 parentMap，prepared-document 缺少 currentPreparedDocumentJson、bindCurrent、DocumentPreparer，picking 缺少字体身份接口。包没有包含的本地 CanvasContextMenu、Worker 和序列化调用方仍依赖这些接口，不能用整文件复制合并。
2. **会重引入已知测试执行问题。** 包内 `frontend/design-client/src/kernel/gpu/terminal-quality.test.ts:29–32` 又使用源码截取和 `stripTypeScriptTypes(..., {mode:'transform'})`，与上一轮在本机失败后修掉的代码相同。应保留 `22b2dcd` 中直接导入实际类的修复。这里没有重新运行测试。

## 包内需要先修的静态逻辑问题

以下行号针对 ZIP 内的 `files/` 源码，未执行复现：

- **颜色提交后的重入校验缺口（P2）。** `frontend/design-client/src/engine.ts:345–347` 在 `set({page/selection})` 中提交颜色预览；提交通过第 717 行的 `this.set` 同步通知订阅者。订阅者若加载另一文档，外层 set 仍在第 371 行把旧 page/selection 合并进新的 state。应在提交前后核对 document/session，并重新验证导航目标；仅 switchPage 内部的校验不能覆盖直接 set 入口。
- **导航失败清理缺少具体请求归属（P2）。** `frontend/design-client/src/kernel/ProgressiveSurface.tsx:1118` 已建立独立 intent，但第 1409–1411 行只凭 contract 和字符串 key 清理。相同 sample.sequence 下尺寸 A→B→A，旧 A 延迟失败时可能清掉新 A 的 key，使新响应被丢弃。清理需要绑定具体 admission/intent 的对象身份，不能只比较可重复的字符串。

另有一项需核对的生命周期边界：BitmapRetirement 依赖调用者提供完整 survivor 集，当前调用点没有纳入 displayed.residents；本轮没有把它定性为已复现的资源提前释放故障。

## 未发现明确回归及验证边界

新 JSON 入口仍执行 JS 和 Rust 准入及共同布局准备；导入新身份与原有行为等价；MCP 来源标记不扩大权限。颜色事务已包含 owner/session/revision/selection/fill 身份检查和 authored/preview 分离。锁定图层在图层树被显式选中后允许属性编辑，是既有明确规则，本轮不将其误报为新回归。

包内 VERIFICATION 声称 427 个 Vitest 文件、3448 项测试通过，同时明确未做新 Rust/WASM 构建、实机 GUI/GPU、物理帧率或完整内存验收。这是供应包内的记录，本轮未重跑，不能代表与本地未提交优化合并后的结果。Home、预设和颜色弹层仍有中文，国际化是局部范围；缓存上限是表面估算，不是总进程内存或总显存上限。

建议先保留现有优化，只提取此包相对上一包的新增差异，修复上述重入和请求归属问题，再形成可审查的合并候选。当前不建议直接推送主分支。
