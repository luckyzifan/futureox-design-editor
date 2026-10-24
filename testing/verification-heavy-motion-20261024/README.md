# 重效果与真实导入验证

**总体状态：未验收。三个文件的快速运动清晰度仍 FAIL。**

- [完整中文记录](../../docs/HEAVY_MOTION_COMBINED_IMPORT_20261024.zh-CN.md)
- [最终源码/产物/原件摘要及结果](final-evidence.json)：source6 两套完整构建，2193 个输入一致；原件未变。
- [前台 Electron 运行清单](foreground-runs-6.json)：FIG Dashboard、117 主画板、拓扑三个工作集的编辑/历史/保存重开通过；生产后台限流设置，实际焦点记录。
- [硬件原始结果](tile-image-residency-6.json)：80 次输出读回，20 帧参考，60 次对应后端的逐位比较，零差异。
- [最终回归](regressions-6.json)：397 前端 + 14 维护 + 27 桌面测试通过。未作为全 G2/G5。
- [真实 5 GiB 源文件测试](actual-5gib.log)：完整导出、预期修改范围外逐字节一致，实际存储卷容量拒绝检查。
- [ZIP 应用清单](zip-integration-applied.json)、[三方合并](zip-merged-review.patch)。未执行包内脚本作为指令。
- [真实 CPU 重复覆盖检查对照](coverage-profile-comparison.json)、[区域图片重复验证对照](image-profile-comparison.json)。采样局部改善不等于全应用改善。
- [集成 Worker 火焰图](117-profile-images-6/flames.html)、[自然轨迹火焰图](../verification-fig-import-20261024/heavy-117-natural-profile-6/flames.html)、[真实单项 WebGPU 火焰图](flames/webgpu-unit/flames.html)。
- [进程清理核对](owned-process-check.json)：只操作任务自有进程句柄。
- [详细过程与失败尝试](WORKLOG.md)。未删除先前失败数据；`captured`/退出码 0 不代表清晰度 PASS。

运动最新记录分别为 [FIG](fig-foreground-motion-6-quality.json)、[117](117-foreground-motion-6-quality.json)、[拓扑控件](sketch-foreground-motion-6-quality.json)。停止发送到细化完成为 1625/742/506 ms，最大纹理放大 9.70/26.91/20.40 倍。不能宣称全程无模糊；三个渲染实验仍默认关闭。GPU 预算与精度保持原规则。
