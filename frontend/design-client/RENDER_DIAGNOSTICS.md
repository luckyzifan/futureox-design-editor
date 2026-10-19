# 渲染诊断与验证边界

## 录制与导出

在 Web 或 Electron 编辑器按 **Ctrl / Cmd + Shift + P** 打开现有渲染性能面板。打开时开始一轮新录制，暂停或关闭面板立即停止；重新录制会清空上一轮。复现缩放、平移或错误后点击“导出 JSON”。导出由用户主动触发，不发送到服务器。

JSON 顶层 `schema: 2` 保留原有 `samples` 阶段耗时，新增 `diagnostics`。两个列表各自最多保存 512 条，新增列表用 `dropped` 记录被淘汰的旧事件数。只有内存记录，没有后台文件或自动控制台输出。

新增事件的字段采用固定白名单：

- `request`：相机缩放 `zoom`、设备像素比 `dpr`、请求密度 `requestedDensity`、计划采样密度 `sampledDensity`
- `cache`：可见计划的 `cacheHits` / `cacheMisses`，不含文档或瓦片标识
- `tile`：收到瓦片时的采样密度、缓存结果、编译/构图/提交/等待等阶段耗时；收到瓦片不等于已经呈现
- `present`：收到显示确认后的 `publishedDensity`。它是能映射到已确认纹理的最小采样密度；不能识别时省略。混合密度和遮盖可能使该值保守，不能单独用它证明可见边缘的清晰度
- `error`：只保留 `budget`、`device-lost`、`cancelled`、`timeout` 或 `unknown`，不保留原始异常文本

密度单位统一为“每世界坐标单位的采样像素”，不是屏幕 DPR。3200% = `zoom: 32`，DPR 2 时目标密度为 64。阶段耗时是毫秒壁钟，可能重叠，不能简单相加或宣称为 input-to-photon 延迟。

不记录文档/节点名称或 ID、图片 URI、二进制负载、原始错误文本或相机坐标。无效/无限/负值会被丢弃，不产生伪造的精度结果。

## 无 GPU 单元测试

需要支持直接加载可擦除 TypeScript 的 Node.js（本轮使用 Node 24.19.0）：

```sh
cd frontend/design-client
npm run test:render-diagnostics
npm run test:render-contracts
```

这些 `.test.mjs` 用 Node 自带测试运行器直接导入实际生产模块，不依赖 Vitest、WASM 或 GPU。诊断的 8 个测试覆盖默认关闭、暂停/重开、512 条上限、丢弃计数、字段白名单、错误脱敏、非法数值、不可变快照，以及现有性能面板录制控制的集成。

`test:render-contracts` 还包含图片导入、页面滤镜采样策略和精确 CPU 路由的纯逻辑测试。它不是全部前端测试，也不是 Electron 或 WebGPU 视觉验收。

## 仍需真实渲染验收

本轮环境未安装前端依赖或 Rust 工具链，没有运行 TypeScript 全量类型检查、Vitest、构建、WebGPU 或 Electron UI。下面的门禁应在具备依赖和真实 GPU 的机器补跑：

1. 默认 Web 和打包 Electron，DPR 1/2，同一文档持续缩放到 3200%，然后平移、反向缩放、回访旧倍率。
2. 核对输入相机与实际显示确认，确认手势期间收到新的高密度瓦片，而非仅缩放旧纹理。
3. 在同相机/剖面下与独立冷启动的新鲜渲染做像素比较，包含文字、斜线、曲线、阴影和图片。
4. 关注预算错误、设备丢失、取消后恢复、图集共享纹理的生命周期；错误不能把缺内容的帧标为完成。

“日志有采样密度”“测试通过”都不能替代这些像素与交互验收。
