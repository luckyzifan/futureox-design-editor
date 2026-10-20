# 2026-10-20 本机 Electron 与 GPU 渲染复测

新包已按精确 SHA 合入 `23c96df` 并推送。随后使用该源码完整重建
release Electron、WASM、原生 backend/render/prepare；构建包含 TypeScript
检查。用户此次明确要求本地测试，替代此前暂停测试的要求。

**渲染性能仍未达标。** 本次额外实现的长行并行扫描通过实际 GPU 精确性
对照，但未通过交互性能验收，已经从生产源码撤回，保留为
[候选补丁](parallel-prefix-candidate.patch) 和 [精确身份清单](candidate-manifest.json)。
补丁只包含三个生产文件和两个对应测试文件；扩充的 GPU 检查工具另行保留。
最终重新构建的是 `23c96df` 的原有渲染路径。未合入文字布局第二版。

## 相同文件与实际操作

- 117 Sketch SHA-256：
  `d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70`。
- FIG SHA-256：
  `3b2f071aebe931a1cfee60f04d5a1b49ea438dc9134ea628d584cce38949716c`。
- 可见的原生 Electron，1440×960 CSS 像素、DPR 2、Apple Metal GPU。
  保留 sandbox、contextIsolation、原生 SQLite 与实际 renderer。
  临时用户目录与实际工作区隔离。
- 从首页通过真实“继续编辑”进入画布，使用文件输入控件导入。
  117 锚点为“组合 51”；FIG 锚点为实际文字区域。
  依次执行 100%、往返平移、3200%、高倍平移、返回 100%、重复 3200%，
  再做连续滚轮、对象拖动（117）或 X 属性修改（FIG）、撤销。
- 所有阶段均等待最终 presentation/detail ready，记录 rAF 和 longtask。
  扩展编辑阶段单独开启 CPU 采样；常规计时阶段默认关闭 CPU 采样及详细诊断。
  固定运行顺序：当前 117 → 当前 FIG → 当前 117 采样 →
  并行候选 117 A → 当前 117 B → 并行候选 117 B。

原版与候选使用相同输入动作与视图；较早的两次运行没有显式保存 anchor-fit
返回值，后续脚本增加了该状态记录及失败拒绝，未改变操作序列。
这是少量交替本机实测，不是随机化多设备统计或物理输入到光子的延迟测量。
用户的 Figma、StorageManagement 等进程仍在运行，未停止用户进程；
背景负载与队列时序会影响绝对耗时和尾部间隔。

## 完整应用结果

| 117 场景 | 当前版本 A / B | 并行候选 A / B |
| --- | --- | --- |
| 首次 3200% 到 ready | 8.755 / 8.697 s | 8.294 / 8.332 s |
| 对象拖动阶段到最终 ready | 6.919 / 7.050 s | 6.861 / 6.861 s |
| 高倍平移最大 rAF 间隔 | 208.4 / 9.4 ms | 283.3 / 283.4 ms |

候选首次清晰化平均只缩短约 4.7%，拖动阶段约 1.8%；没有达到低延迟目标。
平移尾部间隔变化明显，候选两轮均有约 283 ms 长间隔，不能作为流畅度改善
发布。rAF 间隔并不等于实际不同画面帧率；没有据此宣称 90/120 FPS。

当前 FIG 导入至 ready 为 7.553 s，首次文字区域 3200% 为 0.539 s；
X 属性编辑至 ready 为 3.414 s，期间最大 rAF 间隔约 1.426 s，
仍存在明显主线程停顿。没有测试或合入文字布局第二版，也没有把该一次
FIG 结果与历史不同顺序测量换算为普遍加速比。

全部完整运行的导航均保持文档不变；编辑实际改变目标位置、节点数量不变，
撤销恢复完整持久化 JSON，源文件字节保持不变。两轮候选的 16 张最终
画布截图与当前版本逐像素对照，**共 48,591,360 个像素，零差异**。
这覆盖本次画面，不能外推为所有材料和外部格式的等价性。
见 [运行摘要](summary.json) 与 [像素对照](pixel-comparison.json)。

## 真实 CPU 火焰图及等待

已采集当前版本的主线程与 render Worker CPU profile，按相同构建的
source map 解析 JS。WASM 符号取自同一 release 输入，剥除可选 name section
后与实际 WASM 逐字节一致，恢复 6390 个函数名；见
[身份凭证](wasm-symbol-identity.json)。

- [117 首次 3200% 主线程火焰图](current-117-profile/zoom-3200-0.svg)
- [117 首次 3200% render Worker 火焰图](current-117-profile/zoom-3200-1.svg)
- [CPU 汇总](current-117-profile/cpu-summary.json)

采样运行首次 3200% 为 8.779 s，与关闭采样的运行接近，但仍单独报告。
请求 95 共 20 瓦片：字段构建 100 次，上传 9,584,640 字节，
字段计算约 15.2 ms；34,812 次 draw、约 37.97 亿 pass pixel visits。
168 次队列完成等待累计约 7.898 s。Worker 活动采样约 625 ms、
idle 约 8197 ms；主线程大部分也处于 idle。

这些证据说明此前字段 CPU 重复计算已显著减少，当前这次等待主要落在
GPU 工作与队列完成边界。队列等待是 CPU 侧壁钟等待，**不是各 shader 的
GPU timestamp**，不能据此断言扫描 kernel 占了全部 7.898 s。
并行扫描带来的整机收益很小，进一步定位应覆盖整条滤镜链的大量重复
像素处理、相邻瓦片重复支持区与在途工作对交互合成的影响，不能继续
把主线程布局当成这个 117 场景的唯一瓶颈。

## 精确性与集成检查

- 新包及原有重入/资源生命周期相关前端测试：14 套、175 通过。
- 更新的 Node ownership/admission/settings 合同：79 通过，无跳过。
- 并行候选 CPU 扫描与内存预算检查：2 套、28 通过；
  [计算边界说明](parallel-scan-notes.md)。
- 真实 Apple Metal GPU：19 案例，2,110,840 个 f32 分量逐位零差异，
  包含实际 3484 / radius 1224.3035888671875、16384 长度、纵轴、
  3484×64 多 band、NaN/Infinity/跨度拒绝、最小 subnormal、
  alpha-only 及 247 次 uniform arena rollover。Scratch 为 4,194,304 字节。
  [摘要](gpu-proof-summary.json) / [逐案例结果](gpu-parallel-textures-v2/results.json)。
- 初次 GPU 检查失败：新增 16384 案例超出默认 device 8192 纹理上限。
  Adapter 支持 16384；仅修正检查工具，显式请求硬件支持的上限后重跑通过。
  原失败日志保留本地，未算作通过，也没有降低用例尺寸或放宽输出比较。
- 基线、候选、撤回后的 release 构建均通过；本次没有重跑包中报告的完整
  3597 项测试，也没有完成所有平台、device-loss 或所有设计文件的渲染验收。

## 复现

从仓库根目录先构建 `node frontend/design-desktop/scripts/build.mjs --release`，
然后用新的、尚不存在的输出目录运行：

```sh
DESIGN_CPU_PROFILE=0 DESIGN_EXTENDED=1 \
  node testing/verification-render-local-20261020/run-electron.mjs \
  /absolute/path/117.sketch /absolute/path/new-run-directory
```

将 `DESIGN_CPU_PROFILE` 设为 `1` 可采样。运行 `extract-symbols.py` 校验并提取
当前 WASM 名称，再用 `analyze.mjs <run-directory>` 分析与当前 assets 身份一致
的 profile；源码或构建变更后不得套用旧 source map。
并行候选需在匹配清单的隔离 checkout 中应用补丁并重新构建。
GPU 独立对照在 `frontend/design-client` 中执行：

```sh
DESIGN_TEST_OUTPUT=/absolute/path/new-proof-directory \
  bun scripts/check-exact-prefix-textures.ts
```

原始截图、CPU profiles、host 日志、临时工作区和用户文档副本只保存在本机。
仓库只提交复现工具、精简记录、火焰图及未启用的候选补丁。
