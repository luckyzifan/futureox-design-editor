# 2026-10-20 累积包与本地性能改动合并

基线为已推送的 `22b2dcd`，其中已包含 render lifetime cache 包。此次整合
`futureox-desgin-canvas-ui-performance-cumulative-20261020T1153Z.zip`
（SHA-256 `fc28805350c4c3c2ed99089481b9d1dd10a0afda719645597d97a09040b9da2a`）
与本地未提交改动。压缩包先隔离解压，再按基线比较；没有执行包内脚本。
包与本地同时修改的文件按三方差异合并，包仍为旧版本的路径保留本地修改。

## 保留的改动

- 图像采样轴单轴计算及当前 sample 证明、跨滤波条带复用坐标字段、
  条带与前缀 band 对齐、精确前缀扫描与整数验证的除法快速路径。
  证明失败或容量不足时保留原有 fallback；没有放宽最终数值语义。
- 组件解析借用未变化节点、已发布快照的父级索引复用、
  初次保存与渲染端的私有 JSON 证书复用。
- 平移期间的预览调度、结束后的精确渲染和旧相机任务取消。
- 包中的本地首页、画板预设、选择尺寸标签、颜色预览事务、
  页面驻留及内存档位、设置与视图国际化、原始 JSON 准入、
  MCP/import 来源信息和有界 CPU 系数字节缓存。
- 继续保留基线中可移植的 `terminal-quality.test.ts` 导入方式；
  不回退到包中依赖运行时 TypeScript transform 的旧 harness。

## 合并时修复的边界

- 颜色提交同步通知订阅者后，旧 page/selection intent 必须匹配私有提交凭证、
  原 session、最终文档对象和 revision；新的文档、事务或选择不能被旧意图覆盖。
  颜色编辑事件使用提交前捕获的 owner，避免重入 load 后被记到新 session。
- 导航预览失败清理比较具体 admission 对象身份；旧 A 的延迟失败
  不能清理 A→B→A 中后来的 A。
- 已显示画面的 bitmap 作为存活 owner，直到后继画面提交后才释放；
  页面缓存淘汰和同 key 替换不能提前关闭仍在显示的资源。

未完成的异步文档准备 Worker 实验移至本机合并备份，未纳入提交。
详见 [文档准备合并记录](document-preparation.md)。
`VITE_DESIGN_DYNAMIC_UNIFORMS` 与 `VITE_DESIGN_KERNEL_CACHE` 仍默认关闭。

## 验证边界

用户明确要求不要继续测试。因此本次没有运行测试、typecheck、构建、
Electron、浏览器或 GPU 实测；新增的回归用例仅提交源码。
只核对差异、冲突标记、静态语法和源码引用，并重新生成国际化候选清单。
这些检查不等同编译通过或运行验收。

包中与本地早先的测试记录均是历史结果。尤其最后的精确前缀除法优化只有
合并前独立真实 GPU 数学检查，没有合并后完整 Electron 验收；
Rust/WASM 和应用产物本次没有重建。3200% 首次清晰化、实际快速移动及
90/120 帧尚不能标为达到目标，不能把减少计算或上传量当成体验验收。

历史证据见 [真实 CPU 火焰图](../verification-real-electron-flames-20261020/README.md)、
[候选运行摘要](../verification-lifetime-cache-20261020/candidate-summary.json)、
[独立 GPU 数学结果](../verification-lifetime-cache-20261020/gpu-math-candidate3/results.json)
及 [纹理结果](../verification-lifetime-cache-20261020/gpu-textures-candidate3/results.json)。
截图、用户文档副本、原始 host 状态和临时 app profiles 留在本机。
