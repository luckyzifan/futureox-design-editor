# 四相四附件覆盖：实现、精度与性能（2026-10-29）

## 结论

本次新增一个 **默认关闭** 的四相覆盖率候选：`VITE_DESIGN_PACKED_COVERAGE=1` 时，符合条件的 SDR 显示路径用一次 render pass 写四个独立 RGBA8 coverage 附件。未设置或为 `0` 时保持原路径。没有改变采样位置、区间程序、覆盖分类函数、HDR/导出策略、文档语义或工作集预算。

真实 Metal 的算子和生产显示像素均逐字节一致；直接算子有提速，但生产暖帧没有收益，因此不默认开启。

## 实现与边界

- `sample-only-area-shader.ts` 新增 `areaSamplesFragment`，四个 `@location` 分别输出四个原采样相位。越界像素在调用覆盖函数前返回零。
- `WebGpuDriver.maskAll` 只接受四个不同、私有、实际创建的 RGBA8 binary coverage 目标。当前 frame 必须具有 display intent，且实际上传程序通过原 `SampleOnlyAreaPrograms` 四相证明。
- 非显示、HDR、非相干采样、未知/变更程序、重复或外部目标、错误格式、缺少 pipeline 全部返回 `false`，调用方回退到原四次 `mask`。
- `GpuRenderer.maskFour` 只在四张 mask 都是本轮新光栅化目标时调用 `maskAll`；缓存命中不重写缓存纹理。主填充 mask 路径已接入，描边、backdrop、导出和其它路径未扩大。

## 定向检查

最终从 `frontend/design-client` 执行：

```
bun run test -- src/kernel/gpu/packed-coverage.test.ts src/kernel/gpu/sample-only-area-programs.test.ts src/kernel/gpu/sample-only-area-dispatch.test.ts src/kernel/gpu/sample-only-display-intent.test.ts
bun run typecheck
```

结果：4 个测试文件、**91 项通过**；TypeScript 通过。覆盖四附件一次绘制、区域原点、禁用回退、非显示、重复/外部/错误格式目标、上传程序变化、pipeline 失败、renderer 全新目标与缓存命中。

## 真实硬件精度

环境：macOS arm64，Apple Metal-3，明确非 fallback adapter。没有把这些结果称为物理 scanout、FPS、完整 GUI 或全 G2/G5。

### 独立算子

证据：[hardware-v3/gpu-result.json](hardware-v3/gpu-result.json)。

- 原通用 area fragment 四次单相绘制，对比新四附件一次绘制。
- header3 复杂区间和 header4 矩形；完整路径及两个负坐标区域。
- **1,011,904 个 RGBA8 字节，0 差异**；每例同时包含零和 255，排除空白假通过。
- 配对队列完成中位数：header3 约 **0.90 → 0.60 ms（-33.3%）**；header4 约 **1.20 → 0.15 ms（-87.5%）**。这是编码加实际队列完成，不是独立 GPU timestamp 或应用输入延迟。

### 生产显示入口

证据：[production-managed/gpu-result.json](production-managed/gpu-result.json)。

- 真实 `GpuRenderer.render(scene, false, true)` 和返回的 `ImageBitmap`。
- managed 文档、14 个编译节点，控制侧 `packedCoveragePasses=0`，候选侧实际为 2。
- **557,056 个显示 RGBA8 字节，0 差异**，含 31,216 个非均匀颜色检查值。
- 三次暖帧配对中位数约 **4.5 → 5.1 ms（-13.3%）**。没有生产收益，故不默认开启。冷启动含独立 pipeline 初始化，未用于推广判断。

先前 unmanaged 生产文档得到 `packedCoveragePasses=0/0`，证明其按既有目标类型回退，不能当作命中或提速证据。

## 保留的失败与修正

- 初次单元测试的区域期望、`undefined` 默认参数和两个测试类型错误已修正后重跑。
- 初次硬件脚本的 `manifest` 作用域错误和中位数索引错误已修正；`null` 统计没有作为性能证据。
- 生产 harness 的 managed/linearLight 参数和 bitmap 获取方式错误已修正；没有通过修改场景或跳过精度检查绕过。
- 前一项 sample-only 的完整 GPU 套件曾中断，桌面 smoke 停在首页且 `canvas=0`，均不构成本项整体验证通过。

## 验收状态

- G3（本次限定显示/覆盖率像素）：**PASS**。
- G4（生产性能推广）：**FAIL / 不推广**，保留默认关闭。
- G2 连续交互、完整 G5、全平台、独立 Sketch/Figma 全像素保真、33/100ms 目标：**NOT_RUN**。

## 源码与证据 SHA-256

```
b199b3cdf0d4457b2840169539c3f84231fdfa890bd5dd4512f676100cefcc41  frontend/design-client/src/kernel/gpu/webgpu.ts
0a2e865ec9a5368b1d3ea074fd0547b172507a5fb5a9872d79782d46be96c095  frontend/design-client/src/kernel/gpu/types.ts
083b1cc1d975044a6ad3081a96dba000ed0394f33eb72b8230e07d21abf9637f  frontend/design-client/src/kernel/gpu/sample-only-area-shader.ts
2aed4d64674ed06a3d9cfb385ab4d281a2de76d4ec980a189f42de917d1f7e33  frontend/design-client/src/kernel/gpu/renderer.ts
c478bbe22aa1269e1306359440ebd9e4f0db371b5046af2bf4fa7625466cf033  frontend/design-client/src/kernel/gpu/sample-only-area-dispatch.test.ts
67149b2daf8f09116f05922f4e2cd288cf08d9fcfc44732a548b87850bc3e66c  frontend/design-client/src/kernel/gpu/packed-coverage.test.ts
29c83678b69b661d224a9839aacf4506e7009c66b60aade772427709879ca07d  frontend/design-client/scripts/check-sample-only-coverage.ts
f0449ec131dbf8565cc9fc288a233e13c96e8f414c9eafe4c614663ab7e86055  frontend/design-client/scripts/check-packed-coverage.ts
607485c4875ae7cbc1770d9e6cbc72c047311a7c7458b79df6fe83ff5f2a2ef8  frontend/design-client/scripts/check-packed-production.ts
d7848b71c698466d2dfa6ea7d507322a617a3edd3c979498ddc4e77af106a51a  testing/verification-gpu-packed-coverage-20261029/hardware-v3/gpu-result.json
538082cf470cf619bf9afcff565b055a05f07c4cfb0de6de2fab229ab149ebb3  testing/verification-gpu-packed-coverage-20261029/production-managed/gpu-result.json
```

回滚时保持 `VITE_DESIGN_PACKED_COVERAGE` 未设置或显式为 `0` 即恢复原路径；源码回滚只处理本项文件，并先核对后续修改，不能 reset 整个工作区。
