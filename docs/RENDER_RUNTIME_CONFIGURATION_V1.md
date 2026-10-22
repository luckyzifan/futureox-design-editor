# 运行时配置诊断 v1

这是已交付 117 诊断 + WebGPU 默认 1 GiB 增量之上的独立诊断层，不包含浮点图片准入修复，也不改变任何分配、上传、采样、等待、回退或默认开关。

## 为什么需要

原日志含 backendCode、rendererCode、samplingMode、readback 和 admissionBudgetBytes，但没有 imageAtlas 等实际运行时分支配置。源码/WASM 输入摘要本身不能证明运行时配置。新字段不能倒推出旧日志的配置，也不能证明旧失败必定命中某项候选优化。

## 采集位置与字段

GpuRenderer.renderAttempt 在选定实际 frameBudget 后，从本次局部、已规范化 scene 参数、该 renderer 的构造配置和实际 driver 采集。不会读取尚未替换的 this.scene，也不会扫描节点、资源内容、环境字符串或设备描述文本。

- runtimeConfigVersion = 1；缺失表示没有可用快照，不能视为全关。
- runtimeDriverCode：0 未知、1 WebGL2、2 WebGPU。
- runtimeImageAtlas、runtimeImageMips：构造时启用状态。
- runtimeDriverManaged、runtimeLinearLight、runtimeHdr、runtimeDisplayMath、runtimeCaptureDisplay：实际 driver 的布尔模式，0/1。
- runtimeFloatUpload、runtimeFloatAtlasUpload：对应 uploadLinear、uploadAtlasLinear 方法是否存在，0/1。仅证明接口能力，不证明调用、分配或物理显示器能力。
- runtimeFloatCompositing、runtimeColorManaged、runtimeCoherentSamples、runtimeSoftwareRaster：本次 scene 的有效布尔选项，0/1。不包含色彩配置名称、值或文档内容。
- runtimeCompactImageFields、runtimeImageAxesEnabled、runtimeImageAxesEligible、runtimeStreamImageFields：紧凑字段和axes/stream开关的有效布尔值；eligible按当前driver/scene/flag规则计算，不表示某个图片实际生成了轴字段。已有结果里的imageAxisFields、imageFieldBytes也作为有界数值保留，不新增逐像素日志。
- runtimeReadback、runtimePresent：实际 render 调用的布尔输出意图，不代表结果已成功读回或呈现。
- runtimeWorkingBudgetBytes：本次有效工作资源准入上限，256 MiB 至 4 GiB；不是已用显存、总进程显存上限或预分配量。
- runtimeBudgetSource：1 默认策略、2 显式构造参数覆盖。runtimeConfiguredBudgetMiB：默认时 0，否则 256..4096。显式 1024 与默认 1024 因此可以区分，不输出原始环境变量或设置来源字符串。

imageAtlas=1 仅表示开启，不能证明某个失败图片实际走了图集路径。部分调用会传入 intoAtlas=false；图片尺寸也决定是否使用图集，而现有浮点图片预算检查位于该分支之前。imageMips=1 同样不证明实际选择了非零 mip。

## 事件和错误归属

新增 runtime-config 事件使用原有 GPU 诊断接收器，因此继承已有 session、requestId。每个 renderer、每次诊断 sink 生命周期最多发送 16 个不同配置；重复 A→B→A 只发送两次。只有固定数量的布尔/整数比较和短标量键，不做逐帧哈希、内容序列化或额外 GPU 等待。关闭诊断时不计算配置。

事件上限仅限制独立配置事件，不限制错误快照。预算错误在产生时把当前不可变标量快照关联到该精确 Error 的 WeakMap 条目；恢复、后续请求或其他 renderer 不会改写它。已存在的错误包装继承该条目；renderFailureFields 将其作为受限标量交给原 Worker 错误消息与终端记录。渲染入口/退出清除活动归属，未知、取消或非预算错误不借用旧快照。

普通日志模式仍会按原规则合并/限流，detail 模式仍有固定缓冲和丢弃机制，因此不保证保留每个配置事件。预算失败本身携带快照，避免只依赖早期事件。主线程终端记录保留受限平面字段；现有 client.ts 重建的 Error 不会重建此私有 WeakMap 条目，不能据此承诺所有后续 Error 消费者都拥有快照。

## 验证边界

新增测试覆盖：实际渲染入口、局部 scene 而非旧 this.scene、默认/显式 1024/4096、重复配置、16 项上限、诊断重启/关闭再开启、独立 renderer、错误不可变归属及包装、禁止 getter/继承字段/文本、真实 Node MessageChannel 和两次现有清洗边界。原有失败代码保持不变。

这些是 CPU/mock 与 Node 传输测试，不是实际 Electron Worker、GPU 纹理、HDR 显示器、117/FIG 或整机性能验收。真实启用分支和失败结果仍需重建后的新日志确认。
