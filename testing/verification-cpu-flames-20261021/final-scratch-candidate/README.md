# 历史 final-default：scratch候选采样

原始目录名为`final-default-117/fig`，但该检查点仍启用了scratch候选，**不代表随后恢复严格opt-in后的安全默认构建**。原有资源优化与最后默认验收决定见[运动记录](../../verification-sharp-sequential-20261021/README.md)。

在dist被后续构建覆盖前，将42份实际JS/map/其它资产逐项验证SHA并存档到被忽略的`../final-scratch-candidate-runtime/`，共52,839,026字节。[四份wheel火焰图](flamegraphs.html)及[数值/SHA](summary.json)只包含通过严格非负timeDeltas校验的117/FIG continuous-wheel、main renderer和实际render-worker。它们带CPU profiler，不能作为干净延迟基准。

FIG property-X renderer原始profile有一个`timeDeltas[99]=-1`微秒（node135、runtime`get`）异常，严格解析器拒绝把它当作有效定量采样；原始文件与SHA保留在忽略目录。**没有裁剪、归零或变换该profile的时间来发布图或耗时**，本目录不包含其属性定量图。异常身份见[记录](invalid-property/summary.json)。采样节点中没有观察到`resolve_components`，这只陈述观测缺失，不能推出真实调用次数为零；实际Editor入口零解析证明仍来自完整FIG的77项CPU/WASM oracle测试。

仅复查有效wheel段：`node testing/verification-cpu-flames-20261021/analyze.mjs --run-prefix final-default --stages extended-continuous-wheel --assets-root testing/verification-cpu-flames-20261021/final-scratch-candidate-runtime --out-dir testing/verification-cpu-flames-20261021/final-scratch-candidate`。默认完整jobs遇到该property原始异常仍会严格报错。
