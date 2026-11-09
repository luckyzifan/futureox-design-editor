# GPU 表面峰值与视口调度：第三轮

本轮继续处理 Web/Electron 共用渲染链。第二轮累计增量已交付，本轮独立记录新增修改；不修改已交 ZIP，也不把既有通过结果当作新改动的验证。

## 已定位的表面峰值

高精度 coherent 路径的工作表面预算仍为 256 MiB，这属于应用准入策略，不代表物理显存大小。噪声/纹理分支原先创建了未消费的 resolved 面，并在四张新面创建后才释放四张旧面。按相同尺寸、RGBA32F 的局部阶段计，最多九张色彩面会同时占用。

生命周期修复保留原采样、shader、uniform 和混合语义：只在需要的效果分支 resolve；每个输入在最后一次编码读取后释放其逻辑引用，仍遵守别名和提交顺序。隔离记录驱动用例中的 1536² 表面：噪声 324→180 MiB；纹理含坐标场 360→216 MiB。该记录不是硬件显存读数或现场 GPU 性能。

## 厂商方法与本项目的对应

- [Sketch 的离屏优化](https://www.sketch.com/blog/tech-talk-how-we-made-the-mac-app-faster-with-improved-rendering/)强调在语义等价时消除不必要表面。本项目已有叶节点、透明/常量面、穿透组等证书，不能再次无条件扁平化组透明度。
- [Skia 生命周期分配器](https://skia.googlesource.com/skia/+/refs/heads/main/src/gpu/ganesh/GrResourceAllocator.h)以首次/末次使用复用存储。本项目已有动态池、别名和 checkpoint 回收；本轮先修明确的冗余生命周期，完整 pass DAG 仍是更大的架构工作。
- [MapLibre 瓦片管理](https://github.com/maplibre/maplibre-gl-js/blob/main/src/tile/tile_manager.ts)和 [deck.gl 无重叠替换](https://deck.gl/docs/api-reference/geo-layers/tile-layer#refinementstrategy)适用于完整回退覆盖。本项目 compositeDrawPlan 已进行旧图补洞与像素所有权划分，不应再引入会双重合成半透明内容的父子叠绘。
- [OpenLayers 调度](https://raw.githubusercontent.com/openlayers/openlayers/main/src/ol/TileQueue.js)提供全队列优先级思路。本项目需要避免中心优先被行顺序覆盖，以及切批后才补洞排序导致后批可见缺口无法提前。
- [Impeller 覆盖计算](https://api.flutter.dev/impeller/save__layer__utils_8cc_source.html)及 [Skia 模糊 ROI](https://skia.googlesource.com/skia/+/refs/heads/main/src/effects/imagefilters/SkBlurImageFilter.cpp)可参考反向传播滤镜所需区域。必须使用本项目实际支持域、边界规则、预乘 alpha 和色彩空间；不能把裁切边当作滤镜本来的边缘。

## 不能混淆的限制

分块输出不保证模糊/背景依赖也变小。working-set、互动缓存和驻留显示各有预算，不能把任一缓存上限当作设备总内存上限。当前设备损失、纹理维度、颜色管理、四采样以及导出合同继续保留。新算法未获证明前不提高上限、不降低最终精度、不切换产品默认 GPU 路径。

源码资料按 2026-10-19 公开版本核对，链接中 main 是可变分支。本轮借鉴思想，未复制外部实现或新增渲染库依赖。

## 本轮新增的 Rust 区域准入

仅在保守精度证书满足时，高精度文档中的点式 noise 才允许沿既有区域支持域传播路线编译：实际参与绘制的填充/描边为纯色、普通模糊/噪声、阴影位移为零，并且完整依赖范围在导出 2× 换算后的 ±2²⁰ 设备坐标内。noise 读取同一像素，不增加空间依赖；原效果顺序、遮罩/裁剪和 halo 不变。渐变、渐变模糊、非零阴影位移、大坐标、texture 位移、背景效果与未管理色彩文档继续使用旧路线。不能把所有 noise 或效果都视为可无条件区域化。

原生 CPU 编译合同用例中，analytic/subpixel 场景及节点矩形面积总和由 1,303,188 降为 466,016；export 由 5,203,092 降为 1,827,568。该数是编译区域代理指标，不是 GPU 实测显存或时间。完整/区域覆盖数据、noise 输入坐标位、CPU 全帧裁切结果、mask、页切换及效果补丁均有针对性用例。

## 再遇预算错误时的诊断

共享 Web/Electron worker→client 错误路径保留受限数值摘要：申请字节、当前工作字节、预算字节、已知申请宽高及 coherent 标志。只在现有诊断记录开启时加入导出，不记录文档/节点 ID、图片、坐标或堆栈，也不发送网络遥测。取消、设备丢失和无关错误不会携带此前的预算摘要。

可在已有 Ctrl/Cmd+Shift+P 面板开启记录、复现后导出。这些数据用于区分生命周期浪费和合法工作集超预算；不能仅凭一个错误字符串断定硬件显存不足。

## 未宣称解决的范围

本轮没有引入通用 pass DAG 的静态生命周期分配器，也没有完成所有滤镜的任意长链分条执行、跨所有者统一硬预算、实际 GPU 帧率/像素验收。已有相同精度保护继续有效，合法但过大的依赖区域仍可能被明确拒绝。现场异常必须结合失败摘要与实际样例继续定位，不能承诺无限尺寸下永不触发预算。

精度证书保留了两个反例：极大坐标丢失噪声采样原点的低位，以及普通坐标下分数阴影位移引起的双线性权重差异。本轮不改采样器去掩盖它们，而是限制新优化的适用范围。可见描边的 paint.visible=false 也不能绕过纯色证书。

## 最终冻结验证

- TypeScript 检查通过；完整 Vitest 245 个文件，1,601 通过、1 跳过、0 失败。额外 Node 用例去重后 130 项，前端合计 1,731 项通过。
- Rust CPU 针对性测试 28 项通过（10 项区域合同、18 项已有回归）；重新生成 portable WASM，并重建 Electron 的 design-prepare，本地准备桥接 3 项通过。
- 验证前后 662 个前端输入与 298 个 Rust/构建输入未变化；Web 生成和公开 WASM 字节一致。
- 新的全队列排序先补可见缺口，再按中心距离排序，随后才切 4/32 批次；保留逐批过时状态检查和精度/合成语义。
- 既有 export-ownership.test.mjs 源码提取器失败仍未修复，未计入通过矩阵；私有导入样例缺失和显式 117 样例跳过仍存在。详见 testing/verification-phase3/frontend-final-summary.json。
- 以上均不是实机 GPU 像素、显存或帧率验收。
