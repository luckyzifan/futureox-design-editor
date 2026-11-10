# 渲染诊断与验证边界

## 录制与导出

在 Web 或 Electron 编辑器按 **Ctrl / Cmd + Shift + P** 打开现有渲染性能面板。打开时开始一轮新录制，暂停或关闭面板立即停止；重新录制会清空上一轮。复现缩放、平移或错误后点击“导出 JSON”。导出由用户主动触发，不发送到服务器。

JSON 顶层 `schema: 2` 保留原有 `samples` 阶段耗时，新增 `diagnostics`。两个列表各自最多保存 512 条，新增列表用 `dropped` 记录被淘汰的旧事件数。只有内存记录，没有后台文件或自动控制台输出。

新增事件的字段采用固定白名单：

- `request`：相机缩放 `zoom`、设备像素比 `dpr`、请求密度 `requestedDensity`、计划采样密度 `sampledDensity`
- `cache`：可见计划的 `cacheHits` / `cacheMisses`，不含文档或瓦片标识
- `tile`：收到瓦片时的采样密度、缓存结果、编译/构图/提交/等待等阶段耗时；收到瓦片不等于已经呈现
- `present`：收到显示确认后的 `publishedDensity`。它是能映射到已确认纹理的最小采样密度；不能识别时省略。混合密度和遮盖可能使该值保守，不能单独用它证明可见边缘的清晰度
- `error`：保留 `budget`、`device-lost`、`cancelled`、`timeout` 或 `unknown`，不保留原始异常文本。实际 GPU 分配被工作集预算拒绝时，可额外包含 `requestedBytes`、`workingBytes`、`budgetBytes`，以及已知的分配尺寸 `width` / `height` 和布尔值 `coherent`。尺寸不是位置；字节数是该次分配拒绝时的工作集账本，不是设备可用显存测量

密度单位统一为“每世界坐标单位的采样像素”，不是屏幕 DPR。3200% = `zoom: 32`，DPR 2 时目标密度为 64。阶段耗时是毫秒壁钟，可能重叠，不能简单相加或宣称为 input-to-photon 延迟。

不记录文档/节点名称或 ID、图片 URI、二进制负载、原始错误文本或相机坐标。无效/无限/负值会被丢弃，不产生伪造的精度结果。

预算摘要随具体失败经过 Web 和 Electron 共用的 worker/client 通道传递，在客户端收到拒绝时才交给启用中的录制器；不依赖开发构建或控制台钩子。错误随后被恢复或由界面再次报告时，可能还有一条原有的错误分类事件，因此错误事件数不是唯一故障次数。取消、设备丢失、其他失败和成功结果不会继承上一次预算摘要；已取消请求的迟到消息也不会进入录制。没有新遥测、网络请求或自动日志。

## 无 GPU 单元测试

这些脚本使用 Node 自带测试运行器，并依赖 Node 的 strip-only TypeScript 加载器。该加载器不解析无扩展名的相对导入。在 Node v22.23.4 上，`render-diagnostics.ts` 导入 `./render-failure-telemetry` 会在进入断言前抛出 `ERR_MODULE_NOT_FOUND`。`scripts/node-ts-local-resolver.mjs` 就是针对这条缺口的测试加载器；`test:render-diagnostics` 和 `test:render-contracts` 用 `--import` 预加载它。它只在默认解析失败时，把已经存在的相对 `.ts` 交回 Node 自己的类型剥离，不改写实现，也不处理 parameter property。直接运行必须带上同一个预加载，不能只写 `node --test`：

```sh
cd frontend/design-client
npm run test:render-diagnostics
npm run test:render-contracts
node --import ./scripts/node-ts-local-resolver.mjs --test src/image-import.test.mjs src/kernel/canvas-effect-sampling.test.mjs src/kernel/render-diagnostics.test.mjs src/kernel/cpu-frame-contract.test.mjs src/kernel/use-zoom-activity.test.mjs src/retained-board-capture.test.mjs
```

`use-zoom-activity.test.mjs` 会导入已安装的 `react`。省略该文件时也必须带上同一个 `--import`，否则 `render-diagnostics.test.mjs` 仍会在加载阶段失败。

Node 26 的类型剥离只支持 `strip`。帧防抖类使用显式字段初始化，Hook 测试也使用 `strip`，不依赖已经移除的 `transform` 模式；其帧数、相等性判断和取消断言保持不变。

这些 `.test.mjs` 用 Node 自带测试运行器直接导入实际生产模块，不依赖 Vitest、WASM 或 GPU。诊断的 14 个测试覆盖默认关闭、暂停/重开、512 条上限、丢弃计数、字段白名单、错误脱敏、非法数值、不可变快照、预算摘要跨边界验证，以及现有性能面板录制控制的集成。`scripts/node-ts-local-resolver.test.mjs` 只检查上述预加载：不带它时同一组文件在断言前失败，带上之后通过。它不计入这 14 个诊断用例。

`npm run test:renderer-contracts` 还验证生产分配拒绝携带的摘要、状态消费、成功/非法分配/新渲染尝试清除旧状态。安装依赖后，`npm test -- src/kernel/render-budget-client.test.ts src/kernel/client.test.ts` 用 worker 替身验证 Web 和 Electron 两种主机策略走同一通道，包含未启用录制、启用/暂停、错误分类隔离、取消后迟到消息和后续成功；不启动真实 GPU。

`test:render-contracts` 还包含图片导入、页面滤镜采样策略和精确 CPU 路由的纯逻辑测试。它不是全部前端测试，也不是 Electron 或 WebGPU 视觉验收。

## 仍需真实渲染验收

本次预算诊断扩展已运行 TypeScript 全量类型检查、上述 Node 测试和 Web/Electron 策略的 Vitest 通道测试；这些都是 CPU 验证，没有运行真实 WebGPU 或 Electron UI。下面的门禁仍应在真实 GPU 的机器补跑：

1. 默认 Web 和打包 Electron，DPR 1/2，同一文档持续缩放到 3200%，然后平移、反向缩放、回访旧倍率。
2. 核对输入相机与实际显示确认，确认手势期间收到新的高密度瓦片，而非仅缩放旧纹理。
3. 在同相机/剖面下与独立冷启动的新鲜渲染做像素比较，包含文字、斜线、曲线、阴影和图片。
4. 关注预算错误、设备丢失、取消后恢复、图集共享纹理的生命周期；错误不能把缺内容的帧标为完成。

“日志有采样密度”“测试通过”都不能替代这些像素与交互验收。
