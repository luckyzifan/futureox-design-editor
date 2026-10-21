# 完整滤镜结果缓存候选归档

此候选保存的是不含 opacity/blend 的完整 RGBA32F 模糊结果，按实际源纹理和精确采样上下文复用。它没有通过实际场景的性能验收：命中少，保留结果会占用原工作预算并挤压其它中间结果。因此从活跃渲染路径移除，避免保留未被收益支持的所有权及准入复杂度。此归档不表示视觉正确性或性能验收通过。

保留的功能包括水平滤镜缓存、整面 H/V 路径、实际图像表、非负结果准入、不透明 alpha 支撑证明、精确 raw copy 接口及原 256 MiB 工作预算。删除包含完整结果缓存模块及专用测试、renderer 准入/命中/发布/清理、worker 汇总和桌面专属遥测字段。共享 types 中没有专属字段，因此未修改。

`complete-filter-cache-parked.patch` 的方向是**删除后的源码 → 恢复候选**，同时恢复候选自己的回归用例和遥测。它只包含本次删除的差异，不包含其它渲染优化。`complete-filter-cache-parked.manifest.json` 记录每个文件删除后与恢复后的 SHA-256；补丁已经在独立临时目录完成 `git apply --check`、实际重放和逐文件哈希核对。

从仓库根目录检查及恢复：

```sh
git apply --check testing/verification-render-low-latency-20261021/complete-filter-cache-parked.patch
git apply testing/verification-render-low-latency-20261021/complete-filter-cache-parked.patch
```

恢复不会自动启用候选；原开关是 `VITE_DESIGN_COMPLETE_FILTER_CACHE=1`。补丁对应清理时的源码快照。后续默认开关或上下文修改可能需要重新审查、合并冲突，不能强行套用或覆盖其它已验收变更。归档不包含大型运行数据。

whole 对照测试在两侧都打开整面候选的低半径入口，但对照 transport 不授予 `nonnegativeResolved` 私有证明，因此仍验证原 strip/blit 路径。CPU 检查只证明其测试路径，不能代替真实 GPU 像素或交互验收。

删除后的定向检查：renderer、水平缓存、取消、维护回收、不透明滤镜、瓦片诊断共 84 项通过；whole 7 项通过；桌面渲染诊断 18 项通过。最初 whole 的极小预算夹具在维护策略改变后无法容纳原 strip 暂存池；成功回退用例改为较高区域，同时新增原 tiny 预算的拒绝分配、无超额分配、等待 abort fence 后重试覆盖。新增 retry 用例首次因 CPU transport 未接受既有非 prefix 参数形式失败，补齐 transport 后通过。未运行全量测试或 GPU。
