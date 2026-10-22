# 117 定向原因定位增量

适用基线：1e4a3ba07b6922444801e81ba2ad3fbc7f7d5733。

这份独立增量补齐最新日志的三个缺口：
- 原生直接抛字符串时，记录失败边界、原始值类型和固定调用来源；错误字典V2新增39条经过源码核实的完整静态字面量。
- 分配失败区分acquire、materialField预估/实际字节等12类位置，附带精确Error拥有的常量时间账本快照。
- 保留imageAtlas、浮点/HDR/输出、compact/axes和实际工作预算来源等有界配置。已有计数器直接输出，不加逐像素日志。

这不是渲染修复，不包含浮点图片准入候选、缓存优化、设置UI或原生Rust变更。基线已包含WebGPU默认1GiB，本包不再次改变预算。原生Rust仍未在本包中修改。先前交付的ZIP没有被改动。

## 应用与撤回

先保存工作并停止并发编辑/构建。需要Git和Python3。

1. python3 apply_increment.py check /absolute/path/to/Core
2. python3 apply_increment.py apply /absolute/path/to/Core
3. 按项目既有流程重新构建，使用既有CORE_RENDER_DIAGNOSTICS=detail复现相同操作并保留新日志。

撤回：python3 apply_increment.py rollback /absolute/path/to/Core

check/apply 校验精确 HEAD；rollback 不要求 HEAD 仍为基线，但同样严格校验所有受影响文件。三种操作均校验18条受影响路径的旧/新SHA-256、负载、符号链接和暂存修改。不会checkout/reset、修改Git索引、清理其他文件、下载或构建。受影响文件有自行修改时拒绝覆盖。单文件替换原子，多文件不是整体原子事务；中断后仅允许各文件仍是精确旧/新状态时重试或撤回。不要强行覆盖失败检查。

这是新main之上的增量，不要再把旧ee97增量重复覆盖到新main。基线不匹配时先停止核对。

## 已验证

- 171项Vitest，9个测试文件。
- 57项Node测试，含真实Node MessageChannel清洗/转发路径。
- 受影响TypeScript依赖图严格检查。
- 12项应用/撤回保护检查，正向/反向patch检查。
- 293个测试依赖源码与基线/增量逐一核对。
- 独立源码审查未发现明确正确性或隐私阻断。

未运行生产构建、真实Electron Worker、GPU图像/性能或117/FIG整机验收。测试不是这些阶段的替代品。

## 如何读新证据

首先确认failureDictionaryVersion=2及构建输入身份。原生字符串即使无法携带failureStage标签，也有lastFailureBoundaryStage和lastFailureThrownKind；failure-origin事件进一步指出材质参数build、upload或其他已知边界。分配错误查看failureAllocationKind和failureRequestedBytes/WorkingBytes/BudgetBytes。完整枚举见source/docs/RENDER_FAILURE_GAPS_V2.md和RENDER_RUNTIME_CONFIGURATION_V1.md。

旧日志9个未知失败的具体文字仍不能倒推。复现证明了字符串丢失WeakMap标签的机制，不证明是哪一条错误。图集/axes启用和能力也不等于某次路径实际执行成功。账本类别可重叠，不能相加当作总显存；source/WASM输入摘要不证明实际加载的二进制。

归档完整性见 SHA256SUMS；最新日志的结论和限制见 ANALYSIS.zh-CN.md，源码输入核对见 source-provenance.json。
