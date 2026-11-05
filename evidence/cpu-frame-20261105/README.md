# CPU 分块单帧准备 · 2026-11-05

一次 `Engine::render_linear` 调用中的多个块共享页面分析和可证明相同的设备几何。该入口用于带色彩管理的 CPU 画布、线性浮点输出和 HDR PNG。单块沿用逐块路径。每次渲染独立创建并释放计划，动画采样、重新布局、换页或相机变化后会重新准备。[渲染入口](../../design-studio/crates/design-kernel/src/renderer.rs) · [帧计划](../../design-studio/crates/design-kernel/src/cpu_frame_plan.rs)

场景 halo、相同玻璃覆盖关系、按绘制顺序排列的 backdrop 路径边界以及 zoom blur 的设备空间边界可以在帧内复用。每块单独筛选 backdrop、累加原始 f64 支撑并求径向采样区域。第一次渲染若尚待布局，首块的 padding 仍使用原入口在解析布局前读取的文档，之后才保留已解析的页面分析。

几何表按当前块的 guard 填充。以前被裁掉的节点需对新 guard 再做求交，可进入新块的图元会重新准备。直线轮廓可复用完整几何，多项式曲线只有在前后两个 guard 都包含完整支撑时才复用；其它曲线继续走原裁剪。命中仍计入当前块的路径段额度。可选几何保留量至多 2 MiB，径向边界至多 4 MiB，均再受会话额度约束。backdrop 候选最多 4,096 条，容不下时后续块改用原遍历。工作线程的独立瓦片相机、WebGPU 和无色彩管理的 PNG 分块另有入口。[几何准备](../../design-studio/crates/design-kernel/src/geometry_snapshot.rs) · [径向支撑](../../design-studio/crates/design-kernel/src/zoom_support.rs)

## 原生 CPU A/B

Apple M2 Pro，16 GiB。每格两组 ABBA，每臂 4 个独立进程、每进程一次冷帧和两次暖帧。表中时间为 8 个暖样本中位数，RSS 是 4 个进程各自生命周期峰值的中位数，含载入文档、字体、输出缓冲和临时分配。合成峰值另列。单块为无帧计划的控制组。[原始样本、冷帧和二进制哈希](measurements.json) · [试验阶段原始样本](earlier-runs.json.gz)

| 输入 | 块数 | 准备 ms，A → B | 整帧 ms，A → B | 峰值 RSS MiB，A → B | 合成峰值 MiB，A → B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 117.sketch，50% | 1 | 20.76 → 21.26 | 1432.18 → 1448.53 | 338.5 → 328.5 | 136.95 → 136.95 |
| 117.sketch，50% | 4 | 64.14 → 57.77 | 3918.65 → 3781.31 | 355.9 → 376.1 | 136.95 → 136.95 |
| 117.sketch，50% | 16 | 87.57 → 75.68 | 4308.73 → 4166.01 | 412.0 → 422.0 | 136.95 → 136.95 |
| 稀疏矢量页 | 1 | 3.55 → 3.44 | 13.13 → 11.93 | 50.0 → 49.5 | 16.05 → 16.05 |
| 稀疏矢量页 | 4 | 10.66 → 6.20 | 41.80 → 36.35 | 62.3 → 62.5 | 16.05 → 16.05 |
| 稀疏矢量页 | 16 | 43.52 → 20.19 | 166.39 → 143.82 | 111.3 → 112.7 | 16.05 → 16.05 |

稀疏页 4、16 块分别复用 8,964、44,808 次已准备的几何或裁除结果。117 对应为 1,088、6,043 次。每个多块暖帧只构建一次页面分析。这份真实文件的 16 块基线准备约占整帧的 2%，其余时间主要在本次计时的准备区段之外。整帧变化包括光栅、效果、拷贝与系统负载。开发机部分时段有其它编译活动，两臂逐进程数据保留在原始样本中。

117 的 4 块视图触及预设内存观察线。主矩阵进程峰值 RSS 中位数增加 20.2 MiB（5.7%）。另用相同二进制、输入、字体与默认预算运行 BAAB、ABBA，RSS 峰值中位数为 345.3 → 382.9 MiB（+10.9%），四个进程中的最大值为 370.8 → 401.7 MiB。macOS 的 peak memory footprint 中位数为 398.0 → 410.8 MiB（+3.2%）。该场景合成账本两臂均为 136.95 MiB。RSS 增长已复现，进程内其它常驻分配和分配器驻留对差额的贡献仍待拆分。不能把几何表的记账上限当作进程峰值的增量上限。[逐进程 RSS 与物理 footprint](rss-check.json)

## 像素与资源边界

两臂在稀疏页和 117.sketch 的 1、4、16 块上都逐字节比较整个 RGBA f32 缓冲。另测前景模糊、背景模糊、蒙版、径向缩放模糊和 HDR，合计核对 49,322,276 个浮点通道。单项反向对照在下表的接缝相邻像素上都触发了真实变化。表中计数分别是垂直接缝左／右列、水平接缝上／下行中发生变化的像素。[逐项哈希和计数](qa.json)

| 输入 | A/B 差异通道 | 左／右 | 上／下 |
| --- | ---: | ---: | ---: |
| 前景模糊 | 0 | 29／28 | 28／28 |
| 背景模糊 | 0 | 58／58 | 22／22 |
| 半透明蒙版 | 0 | 46／46 | 45／45 |
| 缩放模糊 | 0 | 40／41 | 39／39 |
| HDR，2 倍采样密度 | 0 | 40／40 | 46／46 |

HDR 线性分量最高为 3.0，实际导出的 16 位 Rec.2100 PQ PNG 文件及其解码通道分别逐字节一致。117 在最初的 100% 相机下，4、16 块的请求均被两臂以相同的 256 MiB 合成预算错误拒绝。表内有效计时另取同一份原稿的 50% 全页视图。[拒绝记录](refusals.json) · [计时前约定与原相机](protocol.md)

Rust 内核库 877 项通过、10 项由套件忽略。首次库测试暴露了绘制夹具借用临时空集合的问题，夹具改为持有该集合后完整重跑通过。另 32 项原生渲染集成测试通过。内核、GPU、桌面后端的全 feature／全 target 编译检查通过。独立 portable WASM 构建通过，五个效果用例的 f32 通道哈希以及实际 HDR PNG 哈希均匹配原生 A/B。[检查结果](checks.json) · [WASM 核对](wasm-qa.json)

## 复现

基线为 `37959392` 加实验开始时已有的工作树修改。两臂从同一内核快照构建，保留相同的字体、工具链、锁文件、默认 features 和 desktop-dev profile。取一份独立源码副本作为 B，在另一份相同副本上反向应用本轮源码补丁得到 A。运行探针前核对相应文件的 SHA-256。补丁也可用于单独回滚本轮源码。[前后文件哈希](sources.json) · [本轮源码及回归用例](source.patch)

```sh
# 在仓库根目录运行。A_SRC 和 B_SRC 是不含 .git 的独立源码副本，WORK 是新的测量目录。
EVIDENCE="$PWD/evidence/cpu-frame-20261105"
mkdir -p "$WORK"
(cd "$A_SRC" && git apply -R "$EVIDENCE/source.patch")
for arm in A B; do
  if [ "$arm" = A ]; then tree="$A_SRC"; else tree="$B_SRC"; fi
  python3 "$EVIDENCE/instrument.py" "$tree"
  cargo build --locked --profile desktop-dev -j 3 --manifest-path "$tree/design-studio/Cargo.toml" \
    -p futureox-design-kernel --example cpu_frame_probe --target-dir "$WORK/target"
  cp "$WORK/target/desktop-dev/examples/cpu_frame_probe" "$WORK/$arm"
done
"$WORK/A" import "$SKETCH_117" "$WORK/117.json"
python3 "$EVIDENCE/fixtures.py" "$WORK"
python3 "$EVIDENCE/compare.py" "$WORK" "$FONT" bounds
python3 "$EVIDENCE/compare.py" "$WORK" "$FONT" qa
python3 "$EVIDENCE/compare.py" "$WORK" "$FONT" timing
# macOS 下复测真实 4 块的进程峰值
python3 "$EVIDENCE/compare.py" "$WORK" "$FONT" rss
```

原生库使用 `cargo test --locked -p futureox-design-kernel --lib`。另运行 color、glass、mask_precision、optics、zoom_blur 集成套件。WASM 用未插入探针的工作树构建，再用同一组跨块输入核对实际绑定返回的浮点内容和 HDR PNG。

```sh
python3 design-studio/scripts/build-web.py --profile desktop-dev --output-dir "$WORK/wasm"
node "$EVIDENCE/check-wasm.mjs" "$WORK"
```
