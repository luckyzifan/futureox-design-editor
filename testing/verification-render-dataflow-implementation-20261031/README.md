# 渲染数据流优化实施与验证

2026-10-31。基于 [深度审计](../../docs/RENDER_DATAFLOW_DEEP_AUDIT_20261031.zh-CN.md) 的工作区实现。前置源码与先前未提交修改见 `baseline.json`、`before/`；本轮只修改当前工作区，未提交、打包或部署 Electron 安装包。

## 实现

1. **数据布局与共享**：Node 的十个可选冷字段改为 Box，Network 改为 Arc 并在写入处使用 `Arc::make_mut`。保留字段顺序和 serde 表示；组件、插值、导入、布局及测试调用方同步适配。填充、描边、效果 Vec 在原生记录读入和 Engine 接管时收紧容量，未采用加载后重建整张 BTreeMap。图片缓存键改为 Arc 字符串，解码器分叉共享 URI 内容；字符串内容哈希仍存在。
2. **无变化的 resize**：正且有限、位模式完全相同的宽高直接返回，避免共享几何分离和顶点遍历；实际缩放、零尺寸和有符号零仍走原语义。
3. **PNG 与色彩**：每个分条解码器准备一次 ICC 变换并复用行暂存区。单次上传使用同一个 decoder 读取尺寸和像素，完成、取消、预算拒绝及异常都会释放；独立尺寸查询立即释放。色域优先级、浮点计算、16 位 PNG 大端读取及最终预乘顺序不变。
4. **Grid**：只读轨道查询在完整校验后仅复制目标 frame 和直接孩子。Canvas 按文档、选中 Grid 和已发布场景缓存查询结果，相机与悬停更新不重复求解；文档或场景更新仍失效。
5. **CPU 场景交接**：GPU worker 接收已物化的场景和精确分段 witness。同一编译的多个消费者只需各自拥有几何缓冲，不再为它们复制完整资源包；跨线程可转移字节 API 保持原状。版本、取消、消费一次和资源租约边界保留。
6. **模糊准备**：默认 RGBA 路径成功时只准备其 RGBA、alpha 和 scalar 变体；三条 RGB 通道后备管线仅在显式退出或 RGBA 失败时创建。继续使用相同 shader、核、半径和采样。此修改降低准备工作，不能据此声称热帧更快。

## 验证状态

原生 release、portable WASM 和生产前端均已重建。对同一 124,447 节点快照，实际结果如下（原始数据见 `measurements.json`）：

| 指标 | 前置 | 本轮 |
| --- | ---: | ---: |
| Native Node 本体 | 2,040 B | 888 B |
| WASM32 Node 本体 | 1,360 B | 608 B |
| 读入后 Rust 存活请求量 | 915.12 MiB | 507.14 MiB |
| 读入过程 Rust 请求峰值 | 915.14 MiB | 507.17 MiB |
| 完整文档 clone 新增请求量 | 645.49 MiB | 290.21 MiB |
| 独立 clone 暖态中位数 | 250.91 ms | 80.14 ms |

两版读入后重写的完整 300,408,797 字节快照与 Descriptor/Merkle 回执完全一致。相同原生整板 CPU PNG 四轮一致。独立 clone 是微基准，不能当作编辑器帧延迟。native worker 装载首组有 3,060 ms 的候选样本；补充组基线 2,302/2,032 ms、候选 1,531/1,694 ms。保留两组，不据此宣称整个启动已稳定提速。

构建与回归的命令、退出码和耗时分别保存于 `build-results.json`、`verification-results.json`。最后的测试类型修正另见 `typecheck-delivery-final.log` 与 `handoff-delivery-final.log`。

- 原生完整 suite：1,866 通过、1 失败、25 ignored、1 明确过滤，详见 `native-test-summary.json`。失败的导出倍率 0 断言通过修改前 release rlib 和同一冻结测试独立复现于同一行（`baseline-export-test.log`）。FIG 渐变矩阵断言是此前已记录的失败，本轮最初完整 lib 运行也保留在 `kernel-tests.log`，扩展 suite 明确过滤。两者均不计为通过，未为了测试改变业务数学。
- 前端定向回归 188 项通过，mounted Canvas 10 项通过。两项历史图片 hydration 对照缺失 `verification-image-hydration-20261019/baseline-image-cache.txt`，已明确排除而不计通过；原失败日志保留。最初新增测试用了零几何缓冲的矩形，已改为有实际程序数据的椭圆；最后 18 项交接测试及类型检查再次通过。
- Grid 前像负向对照在 10 次相机更新后查询计数 2→12，当前源码保持不变并在文档修改时重算。
- 真实 Apple Metal GPU：25 项对照、298,268 个浮点 word、零差异；滤镜创建数 11→8（另有共同的九条合成管线）。首轮脚本把共同管线计入绝对数，校正统计范围后复测，原记录保留于 `hardware-parity/`，有效结果在 `hardware-parity-2/`，source drift 为空。
- 真实编辑器 GPU 呈现、属性编辑、缩放、Grid、撤销、保存重载与相机菜单 7 组通过，见 `editor-functional/`。原脚本的旧窗口几何、重载直入画布和 backend 标签假设已在独立测试副本适配当前 UI，未改生产 UI；失败记录均保留。
- 测试所用的旧库 SHA-256 通过先前审计 manifest 再确认后冻结；内存探针不调用有序重建或事后收紧，直接比较生产读入结果。

## 范围与复现

Rust 1.96.1、ARM64 macOS、最多两个 cargo 作业，原生测试最多两个线程。性能测量与构建分开执行。`environment.json`、`rust-build-sources.json` 记录环境与源码，最终清单另存 `manifest.json`。

```sh
python3 testing/verification-render-dataflow-implementation-20261031/run-builds.py
python3 testing/verification-render-dataflow-implementation-20261031/run-verification.py
/Users/Apple/.nvm/versions/node/v24.12.0/bin/node testing/verification-render-dataflow-implementation-20261031/run-hardware.ts /absolute/new-output hardware
```

内存探针中的字节是 Rust 请求的存活分配量及请求峰值，不是 RSS、WASM committed memory 或 GPU 内存。克隆微基准、原生源装载和 GPU 冷准备分别报告，不混为整帧或输入到呈现延迟。没有降低分辨率、放宽内存额度或移除覆盖/所有权检查。

后续用户报告的子层拖动及缩小导航已单独复现，见 [深度排查](../investigation-fig-pan-drag-20261031/README.md)；本轮内存改善不代表这些运动问题已关闭。

完整源惰性物化、统一渲染请求所有者、GPU 分桶和新的模糊采样策略属于后续架构工作。本轮保留完整权威文档；没有重新采用已证明会产生 Missing node 的 metadata-only Engine。父目录 Sketch 逆向缩放表的核对结果没有直接写入渲染器。全应用持续交互、完整 G2/G5、全设备及全部 HDR/导出组合不由这些局部结果自动成立。

回滚必须对照本轮 `before/` 和最终 hash 按文件/hunk 恢复，保留更早的 source-work-reuse 改动及其他任务修改；不使用整库 reset。
