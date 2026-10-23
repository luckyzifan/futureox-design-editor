# 0246 → 0741 → 1338 开发增量合并

基线 `c65ed474141825968cb5e032d6add4cecd584a6d`。本轮按用户要求解压、合并并推送两个新 ZIP，连同其尚未提交的完整 0246 前置增量。包内文字作为交付数据审查，没有执行其关闭其他进程等操作建议。

## 合并范围

- 0246：21 路径，Worker 准备和 pose 关联诊断。
- 0741：16 路径，精确滤波二维系数存储与失败原因诊断。
- 1338：6 路径，managed 背景入口和空场景 compose 依赖候选。
- 三包共 39 个不同源码/测试路径。每一步校验旧文件和 payload hash，并分别校验 3198 / 3208 / 3222 个未改前置路径。
- 主工作区有相同前置代码及其他任务修改。通过三方合并实际更新 21 个文件，18 个无需重写；诊断文件使用完整 0246 作为共同基线，保留本地大文档诊断扩展。
- 只暂存上述增量链、两处新增测试的 TypeScript 类型修正及本验证记录。大文档、拓扑修复和研究目录的其他未提交工作保持本地，不混入本提交。

包 SHA-256、每条源码的前后 hash 及合并决策见 `package-integration.json`。输入 ZIP 和历史 GPU 二进制证据不重复上传；已有证据不能冒充本次组合测试。

## 本机验证

| 检查 | 结果与范围 |
|---|---|
| GPU 逻辑/传输/准备测试 | 6 套，180 passed；GPU/平台边界为 mock |
| pose / Worker / action 测试 | 7 套，151 passed；与上一组有两套重叠，不累加总数 |
| module lifecycle | Node 15 passed |
| TypeScript | 隔离提交候选及保留本地修改的主工作区均通过 |
| WASM | 候选源码重新构建 scalar release，独立 target，未覆盖其他任务产物 |
| Web | 使用匹配 WASM 的生产构建通过 |
| rational / certified GLSL | 各自生成结果一致 |
| 全量 GLSL 生成器 | FAIL：空参数解析 ValueError；干净 c65 基线复现同样失败 |

首次隔离逻辑测试在 WASM 生成前有 3 套因 generated 模块不存在而无法收集；重建后全部通过。首次 TypeScript 检查发现新增测试的可选能力被推断为必填 number，以及 spy 的 unknown 参数与 mock 的 number 参数冲突。只修正两处测试类型，未删断言、改预期或放宽运行准入，随后重跑通过。

具体命令、退出码、日志 hash 见 `results.json`；编译产物见 `build-artifacts.json`。当前没有硬件 GPU、GUI、真实 117、HDR/导出或性能 A/B 的新通过结论。上一轮大型拓扑渲染的失败边界不因本次合并自动解除。

`VITE_DESIGN_EXACT_WHOLE_TENT_2048`、`VITE_DESIGN_MANAGED_MODE12_ENTRY`、`VITE_DESIGN_EMPTY_SCENE_COMPOSE` 均保持仅显式 `1` 开启。预算、精度、设备生命周期限制保持原约束。共享系数 loader 在开关关闭时也发生代码变化；依赖 registry 排空仅覆盖本次请求闭包，不代表全设备空闲。

## 复跑

先从仓库根目录执行 `CARGO_BUILD_JOBS=2 python3 design-studio/scripts/build-web.py`。随后运行：

```sh
node frontend/design-client/node_modules/vitest/vitest.mjs run --config testing/verification-increment-0741-1338-20261023/vitest-logic.config.mjs
node --test frontend/design-client/src/kernel/module-lifecycle.test.mjs
python3 testing/verification-increment-0741-1338-20261023/verify-rational-glsl.py
python3 design-studio/scripts/generate-certified-rational-glsl.py --check
```

其他测试与构建命令在 `results.json` 中。未启动或终止其他任务的 Electron、服务或构建。回退使用本次提交的 Git revert，并重建匹配的生成产物；不改用户文档、缓存或数据库。
