# 画布与渲染架构

| 路径 | 准备与执行 | 画面所有权 |
| --- | --- | --- |
| 常规编辑页面 | [ProgressiveSurface](../../frontend/design-client/src/kernel/ProgressiveSurface.tsx) → [KernelClient](../../frontend/design-client/src/kernel/client.ts) → [Render Worker](../../frontend/design-client/src/kernel/render-worker.ts) → Rust/WASM 或原生准备 → 浏览器 GPU 或 CPU | 当前文档、页面、修订、请求、视口与采样条件共同约束画面 |
| 大型源页面 | [LargeDocumentWorkspace](../../frontend/design-client/src/LargeDocumentWorkspace.tsx) → [NativeSourceSurface](../../frontend/design-client/src/kernel/NativeSourceSurface.tsx) → 宿主源会话与 [Rust 源编译](../../design-studio/crates/design-kernel/src/source_compile.rs) → 原生 GPU 或相应回退 | 源文档／页／会话／修订和相机条件独立校验。源投影与装载状态随实际绘制回执更新 |
| 显式导出 | [共享导出入口](../../frontend/design-client/src/export.tsx)或受限的源导出 → 目标、分辨率、颜色和格式校验 → 原生编码或受支持的矢量序列化 | 使用选定的作者快照。预览用的重投影、驻留瓦片或中间覆盖只服务画布 |

## 准备与复用

- 文档通道按不可变作者快照顺序同步。已确认完整装载的快照和符合准入条件的已确认属性补丁，可以凭准备后端的收据派生交互通道。收据绑定会话、所有者和资源版本。缺少匹配的来源时走完整装载。传输结果不明确的写操作按失败边界处理。[已确认属性补丁的派生条件](../RENDER_POSTPATCH_DERIVATION.zh-CN.md)
- 设备执行逐步处理场景准备、可见任务、工作集准入、光栅与合成。缓存按内容修订、密度、采样相位、设备及资源所有权隔离。呈现取消按请求处理，已接纳的有序文档同步继续执行。
- 画布分别跟踪预览、待覆盖像素和当前精确结果。交接绑定位图与相机，旧请求完成时重新核对仍适用的所有权。提交回执、GPU 完成与窗口接受画面分别记录。
- 原生源编译按当前请求的渲染档位、视口和依赖范围，选择可用的场景准备路线。复用须满足原生准入条件，范围无法证明时使用完整路径。[具体回退、采样与配置](../DEVELOPMENT_CONTRACT_V1.md)

运行预算和实际驱动由可信启动配置及诊断记录标识。设置实验开关后，用当前产物复核实际命中的路径。[运行时诊断](../RENDER_RUNTIME_CONFIGURATION_V1.md) · [工作集预算快照](../RENDER_SURFACE_BUDGET_SNAPSHOT_V1.md) · [渲染验收规范](../RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)
