# 小范围设计编辑：共享 API 与 MCP

这些操作调用现有编辑器、布局内核、组件覆盖和原生历史。没有新增模型执行器、任意 JavaScript 工具、网络/文件入口或另一套设计文档。它们提供可审计的小范围修改能力，不宣称与 Figma Plugin API、字体排版或所有组件覆盖行为相同。

## 新增操作

| API | MCP 工具 | 修改范围 |
| --- | --- | --- |
| `node.patch` | `design_node_patch` | 指定节点的标量、变换分量、单个圆角，以及已存在的 layout/sizing/constraints/textStyle 中的明确叶字段 |
| `layout.patch` | `design_layout_patch` | 上述布局字段子集；可独立修改 gap、lineGap 或四边 padding |
| `paint.patch` | `design_paint_patch` | 按稳定 paintId 修改一个 fill 或 stroke paint 的 color/opacity/visible/angle/blend/fit/已存在的 transform |
| `text.styleRange` | `design_text_styleRange` | UTF-16 半开区间 `[start,end)` 的 fontId/fontSize/weight/color/underline/strikethrough/link/textCase |
| `text.replaceRange` | `design_text_replaceRange` | 精确替换 UTF-16 半开区间 `[start,end)`，保留区间外的字符和富文本样式；支持空区间插入与空字符串删除 |
| `batch.preflight` | `design_batch_preflight` | 仅暂存并检查 authored 草稿，返回有限的字段差异；不提交 |

`api.capabilities` 与 MCP `tools/list` 是字段及数值范围的机器可读来源。所有新 patch 对象逐层拒绝未知字段及空对象，不接受任意字符串路径、原型键、身份/父子结构字段或非有限数值。变换使用 `{a,b,c,d,x,y}`；圆角顺序为 `{topLeft,topRight,bottomRight,bottomLeft}`；padding 使用 `{top,right,bottom,left}`。

`node.patch` 标量字段：name、width、height、visible、locked、opacity、blend、clip、mask、maskType、smoothing、cornerRadius、constrainProportions、points、innerRadius、fontSize。`textStyle` 叶字段包括 fontId、weight、lineHeight、letterSpacing、wrap、align、direction、textCase、paragraphSpacing、paragraphIndent、writingMode。这改变层级属性，不会隐式清除已有文本 run 中的覆盖。

layout/sizing/constraints/textStyle 必须已存在；使用原有 `layout.set` / `text.set` 初始化完整 facet。新工具不会为了一个叶字段偷偷补齐或替换其他属性。paintId 必须在每个目标节点的所选栈内恰好匹配一次。其他 paints、strokes、gradient stops、image bytes 和 effect stacks 均不被该工具替换。fit 只用于 image，angle 只用于 gradient，transform 只用于非 solid；color 保留 Inspector 的 authored 字段语义，在某些 paint kind 下不一定改变可见像素。points 只用于 polygon/star，innerRadius 只用于 star，cornerRadius 只用于没有 authored network 的 polygon/star。

前三种工具可携带同形的 `expected` 部分对象。每个指定的旧叶值都必须精确匹配，否则整批返回 `value_conflict`。它不能代替 documentId/session/expectedRevision：所有实际写操作仍要求这三个当前栅栏。

`text.styleRange` 的两个端点必须是完整 grapheme 边界，不能切开 surrogate pair、组合附加符或 ZWJ emoji。`expectedText` 如有提供，必须等于选中子串。沿用原生 `styleTextRange` 分割 run；区间以外的字符和 run 属性保持原值。段落级排版不是 run 样式字段。原生 run 覆盖可叠加在层级变量/共享文本样式之上，因此 range 工具允许这种局部覆盖，不要求解除层级默认样式。

### 精确替换文字

`text.replaceRange` 的参数为 `nodeId/start/end/text/expectedText`，五者必填。`expectedText` 是替换前的**选中子串**，不是整个节点的文字；仍须携带 documentId/session/expectedRevision。`start === end` 表示插入，此时 expectedText 为 `""`；`text: ""` 表示删除。它不通过全文公共前后缀推测编辑位置，因此在 `"Go Go"` 中替换 `[0,2)` 明确修改第一个 `Go`，不会因重复文字而移动样式来源。

插入内容继承 start 所在 run 的全部属性；如果 start 正好是两个 run 的边界，取右侧 run。位于样式空隙时使用层默认样式；仅在文字末尾取紧邻前方的 run。剩余前后 run 按原属性截断或平移，不清空富文本，也不重写无关节点。替换内容与选中子串完全相同时是无操作，保留原 run 分段且不产生撤销项。实例中的修改继续使用原生整个 text/textRuns 字段覆盖，不提供叶级继承。

原区间端点以及替换后两条编辑边界都必须是完整 grapheme 边界。如果插入组合符、ZWJ 或删除分隔符导致与区间外文字合成一个 grapheme，整次操作返回 `invalid_text_range`，不会悄悄吞掉相邻文字；调用者应扩大选区并显式提供完整 grapheme。孤立 surrogate、结果超过 100000 UTF-16 单元或 4096 runs 同样被拒绝。直接绑定了 text 变量时须先显式解绑；层级字体/共享文本样式仍可作为默认样式。

```json
{ "method": "text.replaceRange", "params": { "nodeId": "observed-text-uuid", "start": 0, "end": 2, "expectedText": "Go", "text": "Start" } }
```

## 已有能力继续复用

- `variable.bind` / `variable.unbind` 已能独立修改一个受支持的绑定路径；不新增重复绑定工具。兼容类型和资源引用由原有验证器检查。
- `node.patch` 修改实例节点时，由原生 `Editor.change` 捕获组件覆盖。主组件和其他实例不直接被 patch 写入，相关原生派生变更会在提交差异中列出。
- 原有 `component.setOverride` / `component.clearOverride` / `component.setProperty` 等保持原协议。
- 原生覆盖单位仍是整个字段。例如修改一个 radius 会保存整组 radii 覆盖，保留当前另外三个角，但以后主组件另外三个角的变化不会穿透此整组覆盖。未被覆盖的其他字段仍可随主组件更新。没有新增叶级组件继承模型。
- 被变量或共享样式控制的直接值不能通过新 patch 静默写入一个无效值；先显式解绑或解除该共享样式。自动布局流内的 x/y 也必须通过布局/绝对定位控制。

## 仍未提供的细粒度字段

新 patch 不修改 node id/kind/父子结构、整个 fills/strokes/effects/network 或整个 textRuns、font fallbacks/features/variations、图像 bytes/adjust/tile、gradient stops 或 layout grids。文字字符仅经上述有边界及预期值保护的 replaceRange 修改。这些领域中已有的替换/结构/导入工具继续可用，但没有被包装成虚假的通用任意路径编辑。新工具没有字体下载、远端库/账户、任意代码执行、像素等价保证或跨文档事务。

## 可诚实使用的 preflight

只允许 `node.patch`、`layout.patch`、`paint.patch`、`text.styleRange`、`text.replaceRange`、`variable.bind`、`variable.unbind`。其他操作（包括 font/import、结构创建、组件换源或任意扩展）在执行前返回 `unsupported_preflight_operation`。

它在独立文档副本上运行这些操作，验证已发布的输入 schema、结构、安全 URL 和现有设计系统引用。返回：

```json
{
  "validation": "authored-only",
  "derivedResolution": "deferred",
  "authoritativeCommitValidationRequired": true,
  "receiptConsumed": false,
  "noAuthoredChange": false
}
```

它不调用 Editor.change、kernelLayout、字体激活、几何失效、Graph.applyOps，不修改当前文档、选择、历史、版本或字体资源 epoch。它不进行像素预览，也不保证后续提交通过所有模型/内核约束。派生布局、组件覆盖生成和原生历史提交都延迟到实际 apply；因此 apply 的最终 changedPaths 可能比暂存差异多。读取返回的 document/session/revision 后仍须处理用户抢先修改的情况。

## 一次小修改示例

先读取真实节点、paintId 和最新栅栏。以下 node-uuid 等是占位符，不能直接提交：

```json
{
  "params": {
    "operations": [
      { "method": "node.patch", "params": { "ids": ["node-uuid"], "patch": { "radii": { "topLeft": 12 } }, "expected": { "radii": { "topLeft": 8 } } } },
      { "method": "paint.patch", "params": { "ids": ["node-uuid"], "target": "fill", "paintId": "observed-paint-id", "patch": { "color": "#224466" } } }
    ]
  },
  "documentId": "observed-document-uuid",
  "session": 3,
  "expectedRevision": 12
}
```

将上述参数提交给 `design_batch_preflight`。检查 authored 差异后，把同一 operations 放进 `design_batch_apply`，使用仍有效的栅栏并可加 `params.mutationId: "rounded-card-1"`。成功批次只产生一个原生撤销项。出现任何失败都不发布部分修改。

## 差异与重试凭据

普通 authored 写入及 batch.apply 的成功结果现在包含以下字段；history.undo/redo 仍沿用原有响应：

- `changedPaths`：RFC 6901 JSON Pointer 数组
- `changes`：add/remove/replace，加有限的 before/after 标量
- `changesTruncated`：达到 256 路径或 48 KiB 摘要预算时为 true

长字符串、对象、新建子树、字体数据、image/data/base64/content 等字段值不复制到摘要。被省略的值使用 beforeOmitted/afterOmitted 标记。路径摘要表示实际提交后的 authored 文档差异，包括真实内核派生的相关位置。它不是位图差异或完整数据导出；完整数据仍通过既有只读/导出操作取得。

`batch.apply` 可选 mutationId，允许 1–128 个 ASCII 字母、数字、下划线或连字符。同一文档 session 内，相同键、相同参数和相同原始栅栏的重试返回原提交结果及 `receipt.replayed: true`，不会重新提交，旧 revision 因此只在确切已成功重试时可被接受。参数对象键顺序及请求传输 id 不影响匹配。参数或栅栏变化返回 mutation_conflict。不同 document/session 仍被拒绝。

`receipt.revision` 是原提交版本；外层 response.revision 是当前版本。用户已经撤销原修改后，重试也只查询原凭据，不重做已撤销操作。失败和 preflight 不消费 mutationId；修复可恢复错误后可使用原请求重试。

凭据只保存在当前 API/文档 session 内，最多 128 条，有 32 MiB 序列化数据总预算。暂存后按真实操作结果、资源 ID 和选择长度，加上原生节点数量上限允许的派生 UUID 及有限差异，预先保留完整响应的保守上界；该预算不表示 JavaScript 总堆内存的精确上限。成功凭据不被静默逐出；额度不足时在提交前返回 receipt_limit。关闭 API 或更换文档/session 后清空，非持久化跨进程保证。无 mutationId 的现有 batch 继续兼容。取消、断开连接或 MCP 输出额度错误并不撤销已经提交的修改；同一活跃会话中应首先用原 mutationId 精确重试，必要时重新读取文档/历史，而不是猜测成功与否。

## 验证范围

`automation/granular.test.ts`：真实 Editor + WASM，精确 before/after 路径、单次撤销/重做、混合 run 与 emoji、锁、未知/结构字段、expected 冲突、变量解绑、原生覆盖及主组件传播、真实 Graph.applyOps 失败回滚、重复/no-op/过期/session 凭据、无内核副作用的 preflight 和摘要额度。

`automation/mcp-e2e.test.ts`：真实 MCP JSON-RPC 内存字节流、tools/list、读写 scope、preflight/apply/确切重试、原生 `.fd` 导出再导入、一次撤销以及已有导出/大字体/分页回归。

这些验证不代表 OS socket、外部 AI 客户端、桌面授权 UI 或 GPU 像素验收；本轮没有启用这些被限制的路径。
