# 2026-10-25 继续实现与真实验证

工作区：`/Users/Apple/.codex/worktrees/render-owner-20261025/design-kernel`，冻结基础 39ff10b。参考资料逐项分析见 [REFERENCE_REVIEW.md](REFERENCE_REVIEW.md)。本记录不是全部验收完成声明。

## 继续保留的实现

1. 原生同请求在完整编译前短路；ACK 不参与编译键。变化相机、文档、字体、mip、失败和未知 owner 不能借用旧帧。变化 root 编译能力仍未恢复。
2. 取消 FGSC 帧资源与 JS FrameResources 的固定 32 MiB 保留限额，改用可信启动内存 allowance；原生资源与缓存帧共同计费，JS 继续计入在途退休资源。GPU 预算、样本数、HDR/导出精度未变。真实 Electron 已记录 36,608,256 B 和 48,221,264 B 的 JS 帧资源保留。
3. 不变成员集复用不可变 ACK cohort；解码以 overlay 查询旧字典；WeakRef 命中不再先分配 paint 数组；几何独立存储和分段精确 witness，避免长寿命场景保留整包资源体及无 cache 命中时的 eager 证明复制。
4. 修复 copies=2 时 reclaim 把已计入可复用数量的池项销毁的风险；旧失败 / 新通过及取消、不确定 fence、已有 pin 均有证据。
5. 真实拓扑高倍线性渐变原本只需 3046×1、48,736 B 的轴字段，却被未分配的 3046×2373 二维面积挡住。轴字段现在按实际分配尺寸过原 guard；原矩形仍用于坐标证明，dense/nonseparable 的 64 MiB guard 不变。原生六项通过。
6. 已 ACK 的原生画面在同密度、同整设备像素相位平移时，直接使用原生瓦片计划补缺口，省去整视口捕获后再重复铺瓦片。冷启动、预览基底、换内容/设备、缩放、分数相位不借此证书。
7. 表面池维护私有释放顺序和字节索引，省去重复排序、Set 构造及池字节汇总。未知 Map 写入、无效年龄、重复所有权撤销索引，走原枚举；pin、完成 fence、8 次延迟额度、每批资源上限、LRU 顺序及预算决策保持。不是预算放宽。
8. 当前密度与当前相位均匹配的同内容缓存优先于更高密度但需重采样的历史；当前原生细化仍优先于缓存。相位判断未加容差。
9. 文件菜单导出入口沿用主界面 busy 状态。此前保存进行中仍可点击，源适配器的 run 遇 busy 会直接返回，导出意图被丢弃；这个真实操作竞态已定位并修正。

## 真实测量

所有数字按各自范围解读。带 profiler / screencast 的 wall 时间不能当物理 FPS，也不能与未采样运行直接相加或归因。

| 范围 | 之前 | 候选 | 边界 |
| --- | ---: | ---: | --- |
| 首组大素材、同实验配置、平移后细化 | 11,847 ms | 3,950 ms | 单次带 profiler，先只改平移路径；未达到流畅目标 |
| 默认渲染配置、同输入/采样/截图、平移后细化 | 3,471 ms | 1,956 ms | 当前 Rust/资源/池索引相同，Surface 为单变量；不是整体 G2 通过 |
| 首组同实验配置，对象拖动后细化 | 24,065 ms | 17,732 ms | 表面池索引；窗口和等待差异都保留 |
| 该对象窗口 Worker 活跃 V8 采样 | 11,964 ms | 5,378 ms | 活跃采样总和，不是 GPU 工作时间 |
| reclaimScratch 累计 inclusive 采样 | 6,798 ms | 1,068 ms | 同线程窗口内，不能与子调用另行相加 |
| 合成 10,000 池项 CPU smoke P50 | 2.833 ms | 0.265 ms | 31 样本 / 5 预热，顺序、字节、overlap oracle 相同；不是 GUI |

GUI 和火焰图：

- `../verification-drag-response-20261024/topology-1-5-drag-native-pan-1/`
- `../verification-drag-response-20261024/topology-drag-pool-render-pool-1/object-profile/flames.html`
- `../verification-drag-response-20261024/default-base-pan-render-pool-1/`
- `../verification-drag-response-20261024/default-candidate-pan-render-pool-1/`

## 硬件与功能门

- `surface-pool-hardware-1.json`：五个真实区域，WebGPU/WebGL2，同世界瓦片在两相机下 60 次浮点读回，零 word 差异。
- `topology-large-pool-hardware-1.json`：真实 4022 / 7662 / 7662 节点工作集，两个后端共 36 次读回，零 word 差异；18 次候选记录实际索引有效。
- `phase-priority-hardware-3.json`：实际 Rust 图形、GPU 原生/过密两种捕获及 resident compositor；原生采样 oracle 对旧选择 244 byte 差异，对新选择零差异。采样层是现有 resident 显示字节层，没有改产品格式。
- `native-viewport-parity-3.json`：三个真实文件范围、36 次读回零差异；根限定为实际当前页，并检查非均匀画面。另保留过早/错误配置尝试，不将它们算通过。
- `native-pan-hardware-1.json`：整视口 f32 重绘的整数平移重叠区仍有 24 word 差异，FAIL；它不能证明任意整帧重投影逐位等价。同世界瓦片的独立零差异门另列，不能混称。
- 原生库此前 634 通过、6 ignored，gpu_interaction 5 通过；新渐变边界 6 通过。
- 表面池 / GPU 生命周期定向 66 通过；Node 控制流组 69 通过。Node 26 测试转换器与新 Rust ScenePlan 的接入已迁移，协调器不再偷偷模拟一套 JS planner。显式 256 MiB 压力夹具仍按 256 MiB 运行，产品预算未变。
- 相关五文件回归最近一轮 233 通过 / 5 失败；五项是既有缩放/间隙调度失败。阶段优先级的新增旧断言已改为原生相位 oracle，而非删除覆盖断言。
- 完整前端最后冻结轮仍为 6678 通过 / 62 失败 / 16 skipped / 7 todo / 1 unhandled，后续仅定向复跑；不能说全量已绿。
- `sketch-operations-axis-1.json`：三组名称/属性/撤销重做/保存/完整导出/重开通过，直接在普通 Editor/Canvas。64 个 ZIP 成员中 63 个逐字节未变，剩下一页只有六处预期编辑。
- `render-pool-1.json`：默认构建 FIG/117 功能链通过；两者正反拖动、精确撤销重做、非零拖动状态 FD 保存重开也通过。源文件拖动后立即导出当时失败，不能把该轮总状态改绿。
- `topology-drag-save-phase-export-2/report.json`：修正菜单 busy 后，真实源文件拖动、历史、完整 Sketch 导出、重开位置核对通过。受控测试暂缓实际原生 sceneCommit 成功回执，确认保存期间按钮禁用，释放后真实导出；该注入只在计时外检验竞态，不参与性能结论。约 114 MiB 文件实际生成，正常关闭无强制清理。

## 必须保留的失败与拒绝

- 重新接入所有导航的有界全视口捕获组合没有过关：在同一控件输入中，峰值下降，但旧帧放大到 32.40x、停手约 1060 ms。它与轴 guard 修复同包，不能单因果归为调度；未证明整体改善，已撤回接入，保留 `rejected-bounded-navigation.patch`。
- 原先 tile-first 组合仍撤回，不能因新单测或局部硬件通过又打开。
- 三个大素材组 160 次真实滚轮的 axis-1 运行，maxUpscale 约 72.93 / 83.41 / 83.41，停手约 2402 / 1465 / 1430 ms，运动 FAIL。这是当时实验配置，不冒充最新默认构建结果；最新默认重测另记。
- 首组旧拖动脚本在退出确认中滞留，仅按 PID/父进程/私有路径核对后清理其独立实例。后续脚本先保存私有测试缓存，并有有界的 owned-only 退出处理。没有停止其他任务进程。
- Sketch 仍显示专有属性编辑兼容提示；“能完整保留和导出”不等于全部语义可编辑。完整 Rust 图规划、变化 root 增量编译、语义身份与 LRU/地址分离、全 G2/G5 仍未完成。

## 最新默认构建的 160 事件回放

`candidate-host-phase-export-1` 没有开启前述渲染实验开关，三组均实际收到 160 次可信滚轮，无外来输入。三者 minCoverage=1，但运动仍全部 FAIL：

| 文件 / 范围 | 最大旧纹理放大 | dispatch 停止到 harness 收敛 | 其他失败 |
| --- | ---: | ---: | --- |
| FIG / 01_Dashboard | 29.764x | 2682 ms | 无最终渲染错误 |
| 117 / 原始完整作品 | 29.785x | 4603 ms | 无最终渲染错误 |
| 拓扑 / 首个 4022 节点素材组 | 72.934x | 3689 ms | 两次 code64、一次 code41 |

code64 在本例来自 Rust 场景编译的 16,777,216-pixel 单表面保护，不是已证明的物理 VRAM 耗尽；code41 是“GPU 积分模糊半径超过 512 像素”，不能误称成区域尺寸错误。未抬这两个保护，也未夹断半径或略去效果。下一轮需要解决可见依赖范围及大半径精确算子的支持，而不是继续拧帧资源缓存额度。

`topology-default-pan-phase-1` 的返回平移在相位优先级修正后，nativePhaseCoverage 最小值恢复到 1；正向平移仍记录到 maxUpscale=2，故不能据采样点 sharpCoverage=1 或最后清晰截图宣称完全去模糊。真实合成器 PNG 与对应 rAF/提交数据均保留。
