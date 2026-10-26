# 2026-10-25 原生导航 / 拖动继续验证

冻结基线：39ff10be8037eead583d54eb0d6df5ba5f9e2b4a，开始时工作树干净。当前显示、GPU 工作集、样本数、滤镜半径和 authored 数值预算均不变。验收继续以当前密度无旧纹理放大（maxUpscale<=1）、完整覆盖及真实操作链为准；不把无 250ms UI 停顿当作帧率。没有使用新渲染器、停止其他任务或切换默认实验开关。

## 已拒绝的候选

原生导航在完整同内容 / 同设备 ACK 覆盖存在时先给可见瓦片，并连续逐块重新读取最新相机：hardware gate 之前的实际栅格仍是现有原生区域编译和同一 GpuRenderer。`candidate-priority-1.json` 记录完整构建和私有运行配置。

- 首轮前台 `117-heavy-zoom-priority-1`：160 脚本输入外混入 13 次实际非 Ctrl 滚轮，173!=160，不能作严格 A/B，保留失败。
- `117-heavy-profile-priority-1`：160 可信输入、无外来输入，前台、采样器开启。maxUpscale=9.5137、停手719ms，motion FAIL。
- `117-heavy-zoom-priority-2`：160 可信输入，前台、无采样和截图负载，maxUpscale=11.3137、停手816ms；无渲染恢复错误和准入拒绝。相对此前 uniform-1 的 576ms 退化，FAIL。
- 已撤回该候选的四个产品/测试文件到本轮冻结内容，精确差异仅保存为 `rejected-native-tile-first.patch`，不留下无效生产调度分支。
- 对新 profile 的第一次分析误给了不存在的 profile 子目录；第二次使用实际 manifest 目录生成火焰图。原始错误日志保留。

## 继续中的有效候选

1. 现有 Rust 纯色组 + GPU 私有四样本程序批绘可进入完整 retained 捕获。部分移动 suffix 有 drawRegion 时仍走旧路径。driver 准备不再整体排除 retained。
2. 参数字段用现有 uploadParameters 上传；实际图像仍走原 uploadLinear 和完整指数范围证明。保留有限检查、同 f32 字节和纹理格式。
3. Rust ScenePlan 生成 sampleIndependentNodes，并复用一次原生后序遍历供源资源身份编码；删除 TS 对应递归方法和 Map。没有声称整个 renderer / FrameSceneHandle 重构已完成。

## 初步证据

- capture-batch-hardware-1 没有命中候选，FAIL；发现 driver 侧仍禁 retained 后补齐。
- capture-batch-hardware-2 Electron 提前关闭，无最终结果，NOT_ACCEPTED；未将其当通过。
- capture-batch-hardware-3，Apple Metal 非 fallback：当前真实 117 导入，完整1710×1672，6次读回，每次11,436,480 word，全部零差异。旧 retained 0批绘，新4批绘；暖 draw 9847→5355。只证明该运行的目标像素和路径，不是 GUI / 物理呈现验收。
- 旧定向测试29通过/1跳过；加入候选及边界后32通过/1跳过。调度候选随后已撤回，不把其单测算成已修运动。
- 原生 gpu:: 定向：46通过，1 ignored；包括资源身份、后序共享、10,000深度迭代及各类 mask/effect 依赖反例。portable WASM 正在重新构建，后续再运行前端和硬件。

参考约束：WebGPU 的提交与完成边界继续区分（https://gpuweb.github.io/gpuweb/）；接口拆分参考现有 WebGPU 高低层边界（https://www.figma.com/blog/figma-rendering-powered-by-webgpu/），不把商业实现描述或 wasm view 接口视作本产品已验结论。wasm view 的内存生命周期仍需 owner / grow 边界（https://wasm-bindgen.github.io/wasm-bindgen/reference/attributes/on-js-imports/slice.html）。
