# 全行稀疏覆盖：实现与实测（2026-10-29）

## 结论

实现了保守的全行覆盖证明和 sample-only 独立快速入口，但本组算子与生产测试都没有显示可测性能提升。`VITE_DESIGN_SPARSE_COVERAGE` 保持默认关闭，不能宣称稀疏化已提速。

## 实现

- `AreaProgram` 只在单个 span 覆盖整行所有采样位置时写 `record.z=1`。证明使用最左/最右采样位置的安全边界；部分行不写标记。
- `sample-only-area-shader.ts` 新增 `areaSampleFragmentSparse` / `areaSamplesFragmentSparse`，遇到已证明全行时直接返回 1，其它行走原 `sampleCoverage`。
- 私有程序证明仅接受单 span 的 0/1 标记，非法标记回退。
- 通用 area 管线顶点模块修正为实际 `areaModule`，避免真实驱动找不到 `areaQuad`。
- 原采样位置、区间端点、分类函数、HDR/导出、预算和资源生命周期未改变。最终没有采用 WGSL override 特化，控制与候选入口完全分离。

## 正确性

- Rust 核心库 area_program：6 项通过；raster oracle：1 项通过。
- 前端 sample-only 定向：3 文件、84 项通过；TypeScript 通过。
- 边界包括阈值下一浮点数、全/部分行、非法标记、上传程序变化、缓存命中、非显示与回退。
- 真实 Metal 算子：1,049,000 个 R32 词零差异。
- 生产显示：1,048,576 个 RGBA8 字节零差异，包含非均匀颜色检查。

## 性能

环境：macOS arm64、Apple Metal-3，明确非 fallback adapter。计时包含编码和实际队列完成，不是物理输入到显示延迟或完整 GUI FPS。

### 算子

[基线](baseline/gpu-result.json)已有 sample-only 约 1.15ms；[最终候选](candidate/gpu-result.json)约 1.20ms。没有显示全行快速入口收益，额外分支开销不能忽略。

### 生产

最终使用带阴影的派生椭圆，并关闭测试侧纯色批绘以命中通用 mask 路径：

- [控制](production-shadow-control-v2/gpu-result.json)：暖帧中位约 3.4ms，候选侧 packed=1 时约 3.5ms。
- [稀疏候选](production-shadow-candidate/gpu-result.json)：暖帧中位约 3.2ms，packed=1 时约 3.2ms。
- 稀疏 0/1 暖帧均约 3.2ms，未测得提升。

普通实色椭圆和默认纯色批绘场景曾出现 packed=0/0，未冒充命中证据。初次 override 管线失败、统计/断言和测试配置错误均修正后重跑。

## 验收边界

- G3 限定覆盖率/显示像素：PASS。
- G4 性能推广：FAIL / 不推广，默认关闭。
- 全 G2/G5、跨平台、独立 Sketch/Figma 全像素保真、33/100ms：NOT_RUN。

## 当前源码与结果 SHA-256

```
fd1735d36ded6a2243da894adee7a2ed8384e7907bf1c5c1ccb9a2de0f1a5bdf  design-studio/crates/design-kernel/src/area_program.rs
9aec4a2067b585bd86bc49af3a564e3eaef9271fc5e771b30df10b3dc23bde42  frontend/design-client/src/kernel/gpu/webgpu.ts
aaeac214c39638dea937eb2793fb0519ee19f98b4cd7a11ccb33908bb26f6661  frontend/design-client/src/kernel/gpu/sample-only-area-shader.ts
34d04a364c79cd0d7c74f719ee60e6e0a6b0f48b8c66e363ee00c7660346ecda  frontend/design-client/src/kernel/gpu/sample-only-area-programs.ts
1e39979dc75988aebc6ebacb7c6626694675b41be1ac0241176084d734dce3f1  frontend/design-client/src/kernel/gpu/sample-only-area-programs.test.ts
bb5273e04968d9afbeb91939205ef7a57fa525b69aadd8c970ea87756011b401  frontend/design-client/src/kernel/gpu/sample-only-area-dispatch.test.ts
97d0baac9dc824cbbf3990361ac7f16ac88f6a7349e502f2c3ab06df1cde9b46  testing/verification-sparse-coverage-20261029/candidate/gpu-result.json
3e76e583dcf1eff0bde61cdf4d65dbf436ef9dd6b8f4f8edf42418d68f652b23  testing/verification-sparse-coverage-20261029/production-shadow-candidate/gpu-result.json
```

回滚时保持 `VITE_DESIGN_SPARSE_COVERAGE` 未设置或显式为 `0`，即使用原 sample-only 入口。不要 reset 其他工作区改动。
