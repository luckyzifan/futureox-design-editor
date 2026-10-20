# 本地 Design 显式批量小修改

`createEditorDesignAutomation` 的共享注册表提供以下紧凑入口，MCP 和嵌入式 UI 读取同一能力描述：

- `node.patchMany`：逐节点名称、尺寸、字体、已有布局等细粒度字段。
- `layout.patchMany`：逐节点已有 layout / sizing / constraints。
- `paint.patchMany`：逐节点以稳定 paintId 定位的填充/描边字段。
- `text.styleMany`：逐文本节点显式 UTF-16 范围样式。
- `text.replaceMany`：逐文本节点显式范围替换，必须给 expectedText。

每个入口参数为 `{ targets: [...] }`，每项以 `nodeId` 指定节点，其余字段与对应 `node.patch` / `layout.patch` / `paint.patch` / `text.styleRange` / `text.replaceRange` 完全一致。例如：

```json
{
  "method": "node.patchMany",
  "documentId": "从新读取取得的文档 ID",
  "session": 0,
  "expectedRevision": 12,
  "params": {
    "targets": [
      { "nodeId": "title-a", "patch": { "name": "新标题 A", "fontSize": 24 }, "expected": { "name": "旧标题 A", "fontSize": 20 } },
      { "nodeId": "title-b", "patch": { "name": "新标题 B", "fontSize": 28 }, "expected": { "name": "旧标题 B", "fontSize": 22 } }
    ]
  }
}
```

## 语义及边界

- 只是一层参数展开，没有第二套编辑实现。展开后仍走既有 schema、锁定/绑定/共享样式/字体/范围验证、原生 Editor 提交和历史。
- 一次请求最多 500 个展开操作；嵌套在 `batch.apply` 中的多个批量入口共同计数，不能乘法放大。
- 单个入口要求 nodeId 各不相同，避免同一文本多个范围的位移歧义。需要顺序修改同一节点时，使用明确排序的 `batch.apply`。
- 未指定字段保留。期望值冲突、节点缺失、类型不符、锁定、schema 失败均使整个请求失败，不跳过目标。
- 一次成功产生一个原生撤销事务；全部无变化时不制造历史。文档、会话和版本围栏仍必需。
- 有权限策略时，必须同时授予外层批量入口和每个展开后的底层操作，以及 `batch.apply`（如果使用）；权限资源仍是精确的文档会话。
- `batch.preflight` 接受已注册的上述入口，但仍只是 authored-only 差异预检，不保证最终布局、内核验证或像素结果。
- 如需丢响应重试，将入口放进 `batch.apply` 并使用现有 mutationId 收据。入口本身不另设收据协议。

## CPU 证据

`src/automation/bulk-benchmark.test.ts` 使用真实 Editor/WASM、graph-api 历史、1000 节点和 100 目标，分别测量紧凑入口与等价 batch.apply，检查一次撤销恢复整份文档。设置 BULK_CPU_REPORT 可保存 JSON。测量不含渲染、GPU 或网络；这项改进减少调用参数重复，不承诺更低 CPU 耗时。
