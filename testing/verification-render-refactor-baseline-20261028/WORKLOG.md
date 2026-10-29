# 执行与工具问题记录

- 从最新脏工作树冻结源代码到`/tmp/futureox-render-refactor-baseline-20261028-r1/source`，原件SHA核对无误。仅新增本测试目录；产品修改来自已存在/并行工作。
- 初次构建显式指定了不存在的`.local/design-tools/bin/wasm-bindgen`，在编译前失败；改为已安装的`/Users/Apple/.cargo/bin/wasm-bindgen`，保存初次日志与空products目录为`products-failed-toolchain`，重建成功。
- 报告测试初稿少一个函数闭括号，语法检查失败后修正；14项报告/产物/宿主接口测试通过，随后新增缺失统计负对照，总计15项通过。
- v1硬件运行的图片名`pose-N-ready/quiet`不在宿主白名单中，像素证据保存失败。只终止该任务Electron主进程PID21861；原件及用户窗口未操作。该轮不作为性能或画质通过证据。
- 修正为既有`pose-N-live/fresh`协议，新增通过真实`renderCheckHandler`的接口测试。v2使用完全相同的冻结产品源码/native，仅更新测试入口，完成九例。v1失败日志仍在临时目录和checks记录。
- 首次汇总曾把初始化请求的0耗时纳入全览统计，使未完成批次显示0。已新增负对照并只统计完成的raster请求；`results/`保留旧汇总，`results-final/`是同一v2原始运行的修正汇总，**不是另一次GPU测量**。原始报告未改。
- 冻结回归保留89通过/1失败，最新五文件变化单列并补跑61项定向测试、类型检查；未覆盖为新的硬件性能结果。
- 完成日期跨越到2026-10-29（Asia/Shanghai）。目录名保持测试启动日期，避免重命名破坏已有引用。
