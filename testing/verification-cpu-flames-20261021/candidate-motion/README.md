# candidate-motion：真实连续缩放采样与回退路径

[打开四份实际火焰图](flamegraphs.html)，或查看 [CPU数值、原始profile/target/asset SHA及精确帧位置](summary.json)。先将两次运行的42份构建资产逐项校验并复制到被忽略的 `../candidate-runtime/`，共52,856,125字节；随后使用该存档生成图，没有混用后续源码。两份实际TargetInfo都确认采到了main page和 `render-worker-DSIXWZ9r.js`。WASM继续只保留原始索引。

| 文档 / 实际线程 | 加权样本 ms | 活动 CPU ms | idle ms | program未归因 ms |
| --- | ---: | ---: | ---: | ---: |
| 117 / renderer | 6315.225 | 1250.807 | 4366.834 | 697.584 |
| 117 / render-worker | 6315.248 | 1346.871 | 4932.770 | 35.607 |
| FIG / renderer | 4655.928 | 1469.117 | 2048.120 | 1138.691 |
| FIG / render-worker | 4655.943 | 1019.286 | 3627.888 | 8.769 |

Worker分别约78.1% / 77.9%样本处于idle，不能解释成整段CPU计算满载，也不能直接归为GPU等待。117的主要Worker self为 `sanitizeFields`201.987ms、`certifyExactImageRange`140.048ms、native `decode`71.260ms、`resident-programs.plan`61.723ms、`writeBuffer`53.989ms和`writeTexture`46.457ms。`certifyExactImageRange`中94.950ms实际父栈为 `drawList → drawNode → paintOver → paint → imageFor → uploadImage → uploadLinear`，另33.767ms来自sequentialViewport内两种imageFor调用。不能凭这些样本就认定相同图片重复扫描，仍需图片身份及上传生命周期证据。

FIG Worker self为 `sanitizeFields`319.322ms、`writeBuffer`112.005ms、`resident-programs.plan`103.692ms、GC96.511ms；`renderAttempt → begin` inclusive210.633ms。`sequentialViewport`本身self11.591ms、inclusive24.012ms。其拒绝分支也付出了之前准备、上传和诊断的成本；这些inclusive与子帧相互包含，不能相加。全部相关实际父栈保留在summary的focusedStacks。

主线程也有明显测量开销：117的 `toDataURL` self146.714ms、`state.capture` self131.679ms；FIG分别76.624 / 128.883ms。两次报告均启用了profile和visual-audit，`latencyTimingComparable=false`。因此这份采样用于定位真实调用，不作为干净产品延迟基准。

## 与既有请求日志关联后的明确回退原因

[独立日志摘要](diagnostics/summary.json)只把已记录的 `host-stdout.log` render-diag展开，并按原生输入trace的epoch边界筛选；保留输入SHA。它不是生成火焰图的数据。`read-motion-diagnostics.mjs candidate-motion` 可复查。

- **117**：trace内50个请求，27次 `SEQUENTIAL_DISPLAY_UNSUPPORTED`、2次真正 `PREVIEW_CANCELLED`、21次正常结果。全部27条skip602的state14表示materialCount，实际候选数量为2–5（19次为2、2次为4、6次为5），超过该窄计划仅允许一个material的边界。原tileViewport回退只有3个请求：运动中两个分别观察到1 / 0块后被取消；最后输入后175.2ms发出的第三个请求完成16块。
- **FIG**：85个请求，83次 `SEQUENTIAL_DISPLAY_UNSUPPORTED`、1次真正取消、最后1次正常结果。其中62条skip602的state1表示scenePolicy；另外21次unsupported没有对应skip子原因记录，不能由记录缺失推定具体入口。现有遥测没有记录scenePolicy内部哪个boolean拒绝，不能猜具体子条件。原tileViewport回退只有2个请求，都在最后输入后发出（52.9 / 155.9ms）；前者输出1块后取消，后者完成25块。运动阶段持续发生sequential拒绝，而没有完成相应native瓦片更新，这与旧纹理放大续显相符。

两文档所有queue-start的已记录waitMs均为0，没有“串行队列已积压而Worker CPU一直算满”的证据。FIG的83次reason8 fence全部关联unsupported请求，它们是该图失败后的cancel清理边界，不代表83次输入取消。117的27次reason8同理。日志观测的fence wait sum分别为：117 admission2074.9ms / periodic439.1ms / cancel122.8ms；FIG periodic234.4ms / cancel74.0ms。它们是CPU等待队列完成的独立记录，不是硬件GPU耗时，也不与采样idle作一一划分。

另只读同次owned SQLite revision1的文档策略：117为`rasterProfile=figma`并有srgb colorManagement；FIG为`rasterProfile=analytic`且无colorManagement。原生`fidelity::coherent_samples`对analytic返回false，而sequential scenePolicy要求coherentSamples===true；ProgressiveSurface默认沿用文档profile。这是FIG重复请求既有不支持采样管线的具体静态线索。实际后续512MiB原生display预算也与renderer的`captureDisplay && !scene.coherentSamples`选择一致。不过skip遥测本身未记录全部scene flags，不能由此宣布已逐次排除了scenePolicy其它子条件；更不能为通过候选而擅改既有采样/画质语义。

trace内native缩放质量门仍失败：117最高放大旧像素19.3315倍，FIG32倍，最小sharp coverage均为0。四份取样画面对照均未发现所定义的大块白/透明缺失，但报告明确 `allIntermediateFramesVerified=false`。没有白块抽样异常不代表运动清晰度达标，更不代表所有中间帧均已检查。当前证据优先支持修复重复不支持捕获与native回退进度策略；不支持把全部问题归成昂贵精确光栅CPU或取消次数过多。

复查命令：`node testing/verification-cpu-flames-20261021/analyze.mjs --run-prefix candidate-motion --stages continuous-wheel --assets-root testing/verification-cpu-flames-20261021/candidate-runtime --out-dir testing/verification-cpu-flames-20261021/candidate-motion`。该命令只读取已有profile/构建资产；本次分析没有启动测试、应用、浏览器、GPU或构建。
