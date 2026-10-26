# 本轮记录

- 基线构建输入 2232 项与主目录桌面 manifest 一致，连同未提交源码复制到本轮 managed worktree。原有两个 worktree 和用户窗口未操作。
- baseline-a1 误用脚本默认工作集 3:0；baseline-a2/a3 的数值输入缩放没有稳定落到目标相机，分别触发 512px 滤波限制和选中对象丢失。三次均排除性能配对，保留原报告。脚本改为点击实际 100% preset 并断言 requested zoom=1，显式 SOURCE_CASE=1:5。
- baseline-a4 正确复现：相机 (-6782.5,-5112,1)、DPR 2、最终 20 瓦片，pointerup→精修 7860.7ms，批次 wall 7179.9ms。编译累计 2041.2ms（暴露等待只有 208.9ms）；绘制图 5845.1ms，内含 checkpoint 3429.1ms；finish 184.5ms。总和不可当流水线 wall。材质参数构造 176.4ms、上传 77,810,368 字节，82,103 draw calls。Alpha/coverage 原门通过，但不能证明运动姿态及时。
- 实际 native 元数据发现 32 次准备：24 次成功、8 次拒绝。4 个 514×514 瓦片各重复拒绝两次，再生成两个半宽子块。失败后的 program hits/builds 从原累计值回到零；fragmentHits 始终零。源码确认 Compiler 中途失败绕过了 mem::take 缓存归还，Worker 的重复编译失败又走了 GPU retirement。
- 候选：失败前已完成的不可变区间/子树条目归还原 32MiB 共享缓存，失败场景仍不发布；预编译确认的本裁片几何超限直接进入原有精确分割；只有明确 GPU 工作开始前的已分类几何拒绝才不清退 GPU，device loss、未知错误和 GPU 阶段错误保持旧路径。
- native-old-failure.log 在冻结旧源码上命中“failed crop discarded completed shared preparation”，新候选 native-cache-test-2.log 通过，包含修改一个节点后与全新引擎精确 JSON/程序比对及未修改节点 Arc 留存。
- Worker 测试首次夹具缺完整 authored 字段，第二次误读 outer previewTiles 而非子块次数；均已修正并保留失败日志。worker-tests-4.log 使用实际 WASM admission、模拟 GPU 传输穿过生产 Worker，确认整块只编译一次、两个精确子块、GPU 不重建；这不是 GPU 像素证据。typecheck-1.log 通过。
- 修补几何拒绝的作用范围：几何复杂度取决于位置，准备拒绝只影响本区域递归，不应因为保留 GPU 而让宽泛尺寸缓存扩散到相邻简单瓦片；工作集/分配压力的共享策略不变。

尚在工作：最终候选默认构建、真实 GUI 交替 A/B、独立 float readback、完整受影响回归及是否保留。

## 完成

- 候选2默认数学构建完成；65项前端组合、58项native GPU（1个原有benchmark忽略）、typecheck通过。旧Worker负对照在整块重复编译次数断言失败；候选源已恢复至已测hash。
- 硬件测试最初的 extensionless /@fs 入口未加载；补全扩展名并在同一自有窗口重新加载后，实际 Metal-3 三例 1,585,176 float word 零差异。原入口错误保留在 hardware.log。
- 初版候选GUI在准备阶段偏离目标缩放，未进入计时；后续独立验证窗口隔离OS鼠标输入，禁止本脚本未请求的wheel，并记录额外wheel。全部有效A/B为空。
- A1/B1、A2/B2、A3/B3：7529.5/7283.6、9491.1/7540.0、7447.5/7315.6ms。中位数7529.5→7315.6，2.84%低于预先5%门槛，明确不采纳。原生调用32→28、清缓存4→0并没有实质减少约8.2万draw及77,810,368字节字段上传。
- 原第2对截图2566通道差异（max 4）保留，全部位于实际DOM导入提示/工具栏与阴影范围。补充隐藏这些叠层的pixels-a1/b1验证8,905,680 RGB通道零差异；不使用这两轮的耗时。
- rejected-candidate.patch为本轮8文件相对冻结主目录的完整差异，git apply --check通过，仅供审阅，未应用。主目录默认完整重建完成；2232构建输入、三native及WASM hash均与开始一致。原三个下载文件hash不变。
- 仅清理本轮4个已退出、未产出导出文件的失败/错误配置临时profile，日志/截图/原件/冻结host全部保留。未清理用户目录或其他任务数据。

- 最终补充像素对照通过；本轮worktree已归档。又清理9个已退出的有效回放临时profile（均无导出文件），保留所有记录/截图、源文件和冻结host；完整名单见cleanup.json。
