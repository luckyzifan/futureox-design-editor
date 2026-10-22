# Sample-only area coverage 候选（默认关闭，独立实际 GPU 已通过）

本候选不把覆盖运算改为近似 f32，不改变路径、CPU 扫描线、四个相关采样位置或0/1分类。显示档 `figmaSubpixel` 已使用 header3/4 的二值采样路径；共享 shader 中35词 private数组和软 binary64 面积归约主要服务 header0/1。假设仅为：独立编译样本分类路径、排除不可达的 analytic ALU/private数组，可能减少 shader 资源压力。未测得寄存器数量或独占 shader 时间；后续独立 actual mask ABBA 已观察到较低的编码加队列完成时间，见下文，但没有整机收益结论，不能声称单价降低几十倍。

## 严格准入与真实上传

新 build flag `VITE_DESIGN_SAMPLE_ONLY_COVERAGE` 仅精确字符串 `1` 启用。默认关闭时仍准备/使用原 area。当前接线使用 `Driver.prepareScene(scene, displayOnly=false)`：GpuRenderer只从已有render调用的 `!readback && present` 转发可信显示意图。driver还要求已知managed=true/false的SDR存储、coherent四相场景，拒绝HDR/software、resolve/presentation、grid/checker；不同真实目标格式的路由见文末后续byte接线。没有新增scene/文档/请求授权字段，也不依赖radius候选。历史独立GPU proof的624版本曾额外要求captureDisplay，后续修法与限制见文末。

`prepareScene` 总是先准备旧area，再通过私有 `prepareSampleOnlyCoverage()` 准备新RGBA32F/RGBA8/R32F三个格式。全部完成并通过编译信息/validation scope才发布；失败等待全部任务收尾，保留原路。每个create的validation scope在任何await之前同步push/pop配对，再等待全部create和validation任务；候选不能吞并行filter/image准备错误。CPU记录设备本身不执行WGSL；后续独立实际GPU已完成原/新真实pipeline编译和像素对照，见下文。

`begin` 只对ResidentPrograms计划成功后真实私有arena words及已执行上传/原有驻留内容建立证明，绑定originalFirst→residentFirst、count、GPUBuffer和resourceEpoch。完整header3/4、尺寸、row表/所有引用span范围、单调整数边界、0/1 upper、有限binary64端点16位词均检查；总span访问上限262144。格式证明随现有append-only私有arena ArrayBuffer/byteOffset保存，最多8192条；该arena既有条目不覆写，reset/grow换buffer并使缓存失效。不引用caller source、文档、像素或历史GPUBuffer。无resident映射、foreign header、未知/不完整表均退回原area。

每次begin/prepare/abort清空本帧binding。仅 `mask/maskRegion` 中sampleCount4及phase0..3、匹配的原header尺寸/映射、物理target尺寸可暂存私有target+uniform引用witness；直接 `pass(mode31)` 没有授权。buffer/epoch/target所有权或格式不符一律原路。同步pass即使抛错也清理witness。四phase保留 `sampleBits/compare64/firstSpan/sampleCoverage` 原函数字节、原像素坐标与边界处理，不触碰滤镜、颜色、合成或export数学。

## 独立实际 GPU 对照入口

父任务使用已有 `scripts/check-sample-coverage.ts` 的真实上传/R32逐位思路，不新增重叠proof脚本。候选构建必须设flag=1；显示准入与真实program resident映射准备后，私有 `sampleOnlyCoveragePasses/sampleOnlyCoveragePixels` 必须实际draw后大于0。它们同时由既有driver.stats提供纯数值遥测，没有新worker权限或请求字段。它们在begin归零，是encode计数，不是GPU完成或速度证书。

同一冻结编译/同一driver中先 `prepareScene(scene,true)`（当前接口显式声明test-only显示意图；原+新实际pipeline都ready）及 `begin`。test-only以any访问，把私有readonly `sampleOnlyCoverageEnabled=false` 强制reference原area；其它scene、program、buffer、uniform均不动。当前候选路径依赖实际render-call显示意图和四相准入，直接raw mask proof需在第二参数显式传true，不能靠伪造captureDisplay；生产没有公开请求控制字段。真实GPU读取四phase R32原始位，full和region对照；未知/analytic/header2、错误remap/epoch/格式及phase缺失必须回退。之后再独立做mask-only GPU测量和复杂整机画面/延迟验收。

## 本轮 CPU 验证与限制

两个focused suites **38/38通过**（1.87s）。纯helper覆盖原shader函数字节、header3/4、完整表、端点、错buffer/epoch/remap、foreign字节偏移、caller数组变更不影响已上传私有副本、重复row工作上限。实际driver begin/私有arena upload/原址重映射/mask/pass在记录设备上检查三格式四phase、强制旧路时uniform/buffer不变、strict flag和质量排除、direct mode31/缺phase/foreign target/新prepare回退、候选编译失败全任务收尾、并行准备期间没有悬挂validation scope及抛错witness清理；不执行任何WGSL。

首轮记录设备fixture遗漏OffscreenCanvas替身导致18项环境失败，补齐替身后全37项通过；收紧scope隔离并加入独立负例后38项通过；没有降低数学或所有权断言。另一次误从仓库根调用bunx触发其工具缓存依赖解析，已中断；未改变项目package/lock，实际测试随后使用项目固定node_modules/vitest与Node24运行。未跑GPU/build/重型suite；Bun只做五个TS文件语法解析，没有导入或编译WGSL。独立实际GPU后续结果见下文；合并typecheck/全套与实际Electron画面、编辑、撤销和导出门仍由父任务分别记录。

独立GPU数值proof的冻结身份（旧prepareScene接线；保留历史SHA，不套用后续源）：

| 文件 | SHA-256 |
| --- | --- |
| `frontend/design-client/src/kernel/gpu/webgpu.ts` | `624eeec3ceca23a147c6f73f3568cb87416d45d60fd6943c6dca059b9077404e` |
| `frontend/design-client/src/kernel/gpu/sample-only-area-shader.ts` | `1b4011b451d444eded65b5af169446fcb7ad032bca243ebdaf6ed246bf34160c` |
| `frontend/design-client/src/kernel/gpu/sample-only-area-programs.ts` | `b723950215a29e866f223f1bdb04fd958d30aa1debb46e19d2d9ea74b7ccf3f2` |
| `frontend/design-client/src/kernel/gpu/sample-only-area-programs.test.ts` | `fd8b4acb46a273a3d67c50390c57a54784dea922cb781d792ea4918cbdab221f` |
| `frontend/design-client/src/kernel/gpu/sample-only-area-dispatch.test.ts` | `f2e729971f0ede8979a5a4386a8e89aabfdb4cb07322cad2a4e0197c5fa9c77d` |


## 独立实际 GPU：v1 全域 R32 与局部 ABBA

结果来自同一实际 owned WebGpuDriver、同一真实上传/驻留program和uniform；只切换私有enable位选择原area或新pipeline。测试显式开启driver显示策略，**没有ResidentPresenter或Electron附着**。v1只报告适配器字符串`metal-3`，当时未显式断言`isFallbackAdapter=false`，因此不能追认该断言已经执行。

| v1 | 真实路径数 | 四phase full+corner比较的raw R32词 | 不同词 | 实际candidate pipeline hits |
| --- | ---: | ---: | ---: | ---: |
| 117 | 3 | 60,500,520 | 0 | 36 |
| FIG | 2 | 40,312,056 | 0 | 24 |

Node WASM对绑定文档/request/font生成fresh native scene，browser核对WASM字节；本脚本**没有browser重新compile scene**，不能写browser freshcompile matched。v1/v2共同WASM为`20b6c2b8388ccf91641e8c363375b3b4439b87f98d5e9cb60314a31fbb94aebb`。每次run的1,162个输入hash前后保持一致；匿名source/input/result hash见 [数值摘要](sample-only-coverage-summary.json)，原scene/pixels/用户路径不公开。

预热后做3组ABBA，每trial 8 draws，每路6个trial/48 draws；每批实际queue完成后计时。median：

| v1 | 原area CPU编码+队列完成，ms | sample-only，ms | 两路CPU编码median，ms |
| --- | ---: | ---: | ---: |
| 117 | 23.10 | 9.25 | 0.10 / 0.10 |
| FIG | 25.20 | 10.55 | 0.10 / 0.10 |

这是局部mask编码和真实队列完成的组合时间，包括driver/提交开销，**不是exclusive GPU时间、FPS或输入到画面延迟**。candidate各计时run实际命中48次，原路为0次；不能把较小shader或这一批计时直接当作整机缩放达标。

## 独立实际 GPU：v2 三真实格式与四phase边界

v2以`DESIGN_COVERAGE_FORMAT_PROBE_ONLY=1`运行，显式断言并验证actual非fallback适配器。每条真实路径、四个phase测试两个17×7区域：左上原点外移(-2,-2)，覆盖原program外透明边界；以及中心区域。每条路径要求确实同时读取到0和1样本。它不是另一次完整区域或计时回归，不能把region结果写成三格式全域验证。

| v2 | r32float组件/hits | rgba8unorm组件/hits | rgba32float组件/hits | 总比较组件 | 不同组件 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 117 | 2,856 / 24 | 11,424 / 24 | 11,424 / 24 | 25,704 | 0 |
| FIG | 1,904 / 16 | 7,616 / 16 | 7,616 / 16 | 17,136 | 0 |

R32读取原始单通道32位词，RGBA32F读取原始四通道组件词；RGBA8为真实byte texture，经原有readSurface转为f32组件，再与原pipeline和同位置R32比较，且只允许byte 0/255对应的0/1结果。计数单位是比较组件，不把RGBA8转换后的词数当原始byte数。每个case都验证actual candidate hit=1、reference hit=0。

v2有更强的适配器/三格式证据，不能覆盖或修改v1当时的验证范围。Deep4独立host虽已构建，117/FIG复杂实机与held edit/undo/export仍在后续验收；本候选保持默认关闭，不能据此宣布无模糊、无白块或低延迟已完成。


## 后续显示意图接线：覆盖 bitmap assembly（CPU已过，待新实际GPU/Electron）

Deep4最后一帧的sample-only计数为0不能证明整个手势没有执行：原计数在每次begin归零。不过源码中存在可确定的传输排除：renderTiledPreview的bitmapAssembly显示叶先prepareDisplay(false)，再调用 `gpu.render(scene,!bitmapAssembly,bitmapAssembly)`。该显示分支真实readback=false/present=true，但captureDisplay=false，旧门必然拒绝；direct whole-present分支则可能满足。没有证据把全部零计数归为resolve/presentation或缓存。

现在仅将已有render-call合同传入Driver.prepareScene第二参数，默认false；GpuRenderer传 `!readback && present`，不伪造captureDisplay。WebGL忽略该可选参数。对象字段、worker请求和文档不能给自己声明显示意图。bitmap显示叶与resident显示可进入同一精确sample-only准入；explicit readback、present=false、HDR/software、resolve/presentation和非四相仍保留原area。原四phase/shader/program/precision没有改变，改的是可信调用上下文。原624版本GPU数值证明保留，不能据此声称此后Electron接线已经实测通过。

保留per-frame计数并新增driver-lifetime数值：sampleOnlyCoverageLifetimePasses/Pixels只在实际draw后增加，begin不清零；sampleOnlyCoverageEligibleScenes仅累计通过显示合同且三pipeline已ready的prepare次数，它本身不是mask hit或GPU完成证据。缓存末帧可能per-frame=0而lifetime>0；分析真实压力区间仍须绑定同worker/device生命周期及正确的前后观测，不凭flag或eligibleScenes宣称加速。

三套focused **43/43通过**（2.93s）：新增真实renderAttempt四种readback/present组合、captureDisplay=false的bitmap显示正例、默认false精确回退、HDR/resolve/非四相负例以及cached帧后lifetime计数保持。记录driver不执行WGSL，没有新GPU/构建。合并typecheck与diff检查通过；首轮typecheck只发现新测试替身写只读resourceEpoch，已用local epoch+getter修正，产品接口没有放宽。此部分和独立资产pre-begin boundary合并后共同冻结：

| 文件 | 新接线SHA-256 |
| --- | --- |
| `frontend/design-client/src/kernel/gpu/renderer.ts` | `92434e63e7bb44e32d3a024d3f5c06993e66a2e2f8a5d0886854a6f5c8ea0326` |
| `frontend/design-client/src/kernel/gpu/webgpu.ts` | `350ac25e98ddabd7b5f8743a4e572931b338a20199c7138ae7624f987eddcff7` |
| `frontend/design-client/src/kernel/gpu/types.ts` | `bef4c181665c8637f363be99d78b8fb6a6ffb2c783824d66a6e20779ab30b812` |
| `frontend/design-client/src/kernel/gpu/sample-only-area-dispatch.test.ts` | `01bf9381287ce8cc8ff3f4c903c71cfa799d614b122597eea1591eb95d333cfe` |
| `frontend/design-client/src/kernel/gpu/sample-only-display-intent.test.ts` | `0ab135fd07a72dddd241f1075259c5d7cc3de473dcf7d31aee3f345244a287f7` |

当前owned raw oracle需显式 `prepareScene(scene,true)`，仍应在同一真实上传/驻留binding下切私有enable位做原/新对照；没有ResidentPresenter/Electron的operator proof仍不能冒充附着整机验收。后续需要重绑新source、再做实际117/FIG复杂动作与held edit/undo/export。

## 后续 unmanaged normal RGBA8 接线：CPU范围，待独立实际GPU

Deep5 的实际 FIG 已取得16/16参考，但显示仍存在模糊；该设备运行的 sample-only lifetime passes/eligibleScenes 均为0。源码与文档元数据已定位一个确定的排除：该 FIG 没有 colorManagement，实际 driver.managed=false，前一版显示意图门仍只允许managed。旧operator proof里“FIG三格式”的记录并不等于真实unmanaged normal RGBA8生产路由已经启用；不可用旧格式结果代替本次新路由的实际验收。

当前门仅将存储状态扩为明确的 `managed === true || managed === false`，真实render-call `displayOnly`仍必须为true。normal managed目标仍是RGBA32F，原managed scalar为R32F、binary为RGBA8；新增的unmanaged只接受没有scalar/binary标记的normal RGBA8。它明确选已有 `areaSampleFragment` 的RGBA8 pipeline（私有名称改为sampleOnlyBytePipeline），不绑定RGBA32F颜色pipeline。已知false与未知/缺失managed分开，不用truthiness猜存储格式。

每个候选目标还须匹配createFormat私有创建记录的实际resource、format、width/height与bytes，并保持当前driver所有权；换一个同shape foreign resource也不能继承记录。managed normal不能借RGBA8/R32F/BGRA格式，unmanaged标为scalar/binary或其它format均走原路径。私有已上传header3/4、arena/buffer/epoch、四相索引与uniform witness保持原样，未知header、缺phase、direct mode31仍不获权限。

没有修改WGSL、sample classification、颜色转换、量化或四phase算法。readback/export/present=false、HDR/software、resolve/presentation、非四相、grid/checker等排除仍原样。三种pipeline仍全部validation完成后才发布；失败则保留旧area，不能用半准备的byte pipeline绕过其余原约束。

本轮 **4套112项CPU/mock通过**，包括program/header证明、managed与unmanaged真实render-call意图、normal RGBA32/RGBA8四phase格式路由、header3/4 byte正例、foreign resource/format/尺寸/bytes/标记/unknown managed负例及既有byte-driver生命周期。此数不与历史43项相加。原shader/helper字节检查通过，统一typecheck与diff检查通过；这些记录设备不执行WGSL，未建立新byte格式的GPU像素或整机性能结论。

冻结的WebGPU SHA为 `aab74c8fb2cd6db958044de772a8e5cbf0e8eac3360fd14e13e74886fdf7a494`，dispatch test为 `2709b3273b9418b04c2bca77a3ec536a49c5c471e0dcded0578ac51f5c36f596`，intent test为 `844f8260b18d18b97b7a915a4fea63cf188d0bf0fa4002218570c6cafcbff728`。program helper `b7239502…c3f2`与shader `1b4011b4…160c`未改变。后续必须用实际unmanaged WebGpuDriver、owned normal RGBA8和原四phase raw GPU对照/相同输入benchmark，再检查Electron lifetime实际hits；不能把这次CPU接线当作FIG模糊已解决。
