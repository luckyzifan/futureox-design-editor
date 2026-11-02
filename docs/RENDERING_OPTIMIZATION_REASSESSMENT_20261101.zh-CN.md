# 三项复用复测之后：渲染优化优先级复核

2026-11-01，HEAD `9d91e55` 加当前工作区修改。输入为用户粘贴的重复计算清单、三份 recheck 报告和当前源码。本轮没有修改运行时，也没有新增性能 A/B；来源 hash 见 [sources.json](../testing/analysis-render-priorities-20261101/sources.json)。

## 判断

仍有优化空间，但下一轮应优先减少**不必产生的画面、绘制范围与全量准备**。三个小复用没有达到推广标准，不能证明其它阶段没有瓶颈，也不能从减少24次 draw 推导 GPU 算术不重要。

需分别衡量三条链：

1. 输入/布局/派生/编译/传输 → 新画面的首块与精修。
2. 已有场景 → GPU 覆盖、绘制、滤波、合成。
3. 已有瓦片 → 屏幕呈现及选框/参考线等 overlay。

之前的 A/B 主要经过第二条，计时还包含 renderer 的 CPU 编码/物化及 GPU 完成等待，不能称为纯 shader 执行时间。它没有覆盖完整原生源编译、React 辅助视图及实际 resident presenter 的完整交互入口。

另外，复测表的平均值包含没有实际命中的控制场景：描边在 Gaussian/背景视口的命中为0，只有运动视口省了24次 draw且该轮变慢0.45%；程序身份在运动视口计数为0，其+0.85%不能算该算法收益。三个场景的汇总与“命中集合的收益”应分开，未命中例只用于观察非退化和噪声。

## 优先级一：扩大经过证明的局部绘制范围

仓库已经有较强的实测依据：[局部滤镜拖动](../testing/verification-local-drag-revisit-20261101/README.md)在指定117拖动中，把捕获从4,663,440降到280,370像素，密度保持2；冻结构建的暖GPU graph wall从约287–302ms降到8.2–8.35ms。候选还与重新加载移动后文档的独立静态画面做过像素对照。

这个结果只属于那个对象/操作与构建，不能外推成整份拓扑或当前所有交互的倍数；但它清楚说明减少工作范围值得优先于继续微调缓存。

当前 [interaction-scene-bounds.ts](../frontend/design-client/src/kernel/interaction-scene-bounds.ts#L67)只允许选中根的**单个**普通 blur/Gaussian/shadow/inner-shadow/color-controls；嵌套滤镜、复合效果、蒙版、剪切与后续背景读取仍保守。

下一步先统计真实拓扑操作中这些拒绝原因及其输出/输入/halo像素，再挑一个高频类扩展，例如有限的自身双效果链或已知子树滤镜。实际读取支撑仍由Rust权威逻辑闭合，按效果顺序传播需求；不能只截节点AABB，也不能直接放开旧全局实验开关。

该项应在真实 native Electron 拖动中比较输入→最新内容、首块、停止→精确画面，同时记录捕获面积、各阶段像素、预算拒绝和等待。不要用小算子代替。

## 优先级二：overlay变化复用干净文档底图

当前 [ResidentPresenter.draw](../frontend/design-client/src/kernel/gpu/resident-presenter.ts#L447)会重新形成绘制计划、检查覆盖、清理目标并绘制瓦片；随后在需要时resolve，再复制backbuffer到当前canvas texture，最后画overlay。变换uniform已有 `transformData.changed()`，但不因此跳过文档合成。

可以研究在实际文档内容、采样/颜色、相机、窗口、DPR及所有呈现身份均不变时，复用已经完成的干净文档backbuffer，仅更新overlay。必须绑定实际纹理内容令牌和当前有效document/session/revision/gesture/pose；tile ID相同不够，缺失/替换瓦片和新密度请求不能被错误确认成已呈现。

**第一版应保留必要的canvas复制。** WebGPU当前canvas纹理会过期，不能把它当作持久文档底图；原overlay也需要擦除。[WebGPU规范](https://www.w3.org/TR/webgpu/#dom-gpucanvascontext-getcurrenttexture) 跳过重新画所有瓦片，不等于可以直接删除全屏copy。进一步分离overlay图层属于后续独立同步/性能验证，不能重新引入选框先走、内容滞后的问题。

这需要真实presenter入口。之前只测 `GpuRenderer.render` 的夹具不能证明此项有收益。测试动作应包括只换选择、参考线/测量线、光标/标签变化，以及反例：相机、瓦片内容、颜色/密度、窗口或owner变化。

## 优先级三：消除相机与输入触发的全量准备

以下仍有明确源码依据，且通常比增加GPU小缓存容易限定：

- [CanvasGuides](../frontend/design-client/src/CanvasGuides.tsx#L14)在标尺开启时直接调用worldGuides；[CanvasSmartSelection](../frontend/design-client/src/CanvasSmartSelection.tsx#L20)在多选条件下直接调用smartSelection。两者会触发scene/父关系工作。应复用已有已发布场景借用，并把世界坐标模型与相机投影分开缓存。`editor.entries()` 已有借用入口；不要给处理可变draft的全局allParents加一个不安全的WeakMap缓存。
- [geometry.scene](../frontend/design-client/src/geometry.ts#L286)先复制network顶点和控制点集合，然后才尝试kernelBounds。kernelBounds成功时该集合不再使用。将fallback点集构造延后，是一项额外确认的冗余分配；不改变真正fallback的计算顺序或精度。
- [authored grid](../frontend/design-client/src/grid-overlay.ts#L74)在每个row的循环中重新计算相同的column spans，包括WASM入口。两轴各算一次即可；同时在Canvas中缓存世界坐标网格，摄像机变化只做投影。网格本身的行×列输出数量仍然必要。
- [previewLayoutOrder](../frontend/design-client/src/engine.ts#L1541)已经使用缓存parentMap，但仍新建candidate并单参调用kernelLayout。应先处理“插入位置和有效布局基线未变”的无变化事件，再验证传入正确的previous/resident基线；不能只加一个参数而忽略当前组件派生回执。
- text/utility预览仍有全量布局入口；普通drawingPreview当前只构建预览文档，不能一概说所有铅笔/形状每帧都调用WASM布局。

这些改善主要体现为UI主线程与输入到画面的延迟，不能用之前三场景GPU图计时验证。测试需明确标尺、多选、网格、auto-layout、文本预览各自是否实际启用，以及UI文档到底有多少节点。

## GPU内部：最后使用计划与图块合成仍值得做，但分两步

已有证据中的重复覆盖，部分发生在蒙版被提前退休之后。下一步应先记录每个覆盖程序的后续消费者、实际再生成像素、占用及因此产生的等待，在原预算内比较保留/重算；不要直接提高缓存或删除退休门。

更大的原型可以继续沿 [上一轮分析](RASTER_NEXT_STEPS_20261101.zh-CN.md) 的方向：消费现有Rust区间程序，在小图块内按原绘制顺序完成多项覆盖/填色/source-over，减少中间贴图。保留四个相关样本，blur/backdrop/复杂混合等边界显式物化。先限定一种高频绘制段和一个效果子树，做像素与整图时间对照；不直接重写全引擎。

## 对粘贴清单的关键修正

| 项目 | 当前核查结果 | 对优先级的影响 |
| --- | --- | --- |
| A1 双深克隆 | `doc` 是 `SharedDocument(Arc<Document>)`，clone本身浅复制；后续 `DerefMut → Arc::make_mut` 才可能复制。富文本保留与展开确有再次分离的可能，且Node部分大载荷已共享。 | 测真实COW次数、字节与实际入口；不能直接承诺省2×80ms。 |
| A2 普通patch | Document级clone和全量精确序列化计数仍存在；计数用writer累计，没有再分配一份完整JSON字节数组。一些已证明的平移有独立快路。 | 重要的编辑/精修候选，按是否命中快路分组；保持事务回滚、完整验证和精确容量计费。 |
| A3 每节点两种编码 | 确认存在；canonical语义图像ID与transport ID语义不同，source_key还绑定实际几何字和子节点身份。 | 不能简单删掉一次，也不能在没有版本证明时“命中后再建key”。需要先有可信不可变输入身份；不据此承诺编译减半。 |
| A4 prefix复制 | 存入与emit有复制，emit还要处理帧序号和不同ACK的payload。native源回访缓存已经落地。 | 如仍占比高，研究分段不可变传输；Arc<Vec>本身不能消除最终连续包组装，也不能省掉新frame/ACK语义。 |
| A6 snapshot匹配 | 只在特定旧lane JSON匹配/续证路径调用；不是每次load_document。第二次序列化对第一份字节做流式比较。 | 属条件慢路，先测命中频率。 |
| A7 投影后再完整布局 | 默认 `resolved_source_compiler` 直接装已解析节点，`layout_dirty=false`；feature-gated mapped projection另有load/resolve路径。 | 两条入口不能合为每次视口都完整重排。 |
| A8 viewport两遍plan | 确认：第一次只取visible，再以不同prefix策略plan。 | 可分离可见根选择与依赖闭合，保留验证/取消；收益取决于闭包规模，不一定是主要耗时。 |
| A10 双JSON常驻 | 适用于普通load_document lanes；load_source_snapshot设置source=None。 | 不能直接套到所有大源画布。 |
| A11 全包瞬时2.4倍 | writer逐chunk编码并await写出，不能仅从base64推导全包同时2.4倍。 | 编码成本存在；内存峰值需结合发送队列、完整原包及接收组装实测。 |
| B1 父表重建 | previewLayoutOrder已用parentMap(base)。 | 不重复实现该缓存；关注无变化重排与单参kernelLayout。 |
| B4/B5 | renderedDocument已有useMemo；text/utility有布局，drawingPreview没有该调用。supportsEditPreview已有useMemo与GPU preview短路。 | 文档发布改变身份仍可能重算，但不是没有任何身份缓存。 |
| C1 boxPrefix不受retain保护 | 当前释放条件是 `waitReason && !retainFilterScratch`，保护已覆盖boxPrefix；且retain需要实际captured输出。 | 缺失保护的说法不成立。旧保留候选仍默认关闭，不从4MiB分配量直接推断加速。 |
| C2 capture无池 | 当前每次capture确实创建texture/bindGroup。 | 待测分配占比。池化必须保持完成边界和预算；复用物理texture后还需新的内容写入代次，不能仅按texture对象认定内容未变。 |
| C3/C5 uniform与band绑定 | 仍存在固定uniform上传和逐band构建绑定。 | 次级候选，先看实际次数/CPU耗时；少量元数据工作通常不能解释大量绘制与滤波。 |

其余未逐条复核项保留为线索，不据原清单的行号或频率直接判定严重度。

## 下一轮建议的测试入口

优先做两组相互独立的A/B：

1. **真实presenter的文档未变/overlay变化路径**，连同世界坐标辅助模型缓存；分别测文档合成次数、overlay构建/上传、主线程P95和呈现ACK，保存真实像素反例。
2. **当前局部捕获拒绝最多的一类复杂效果**，测完整读取支撑下的捕获/滤波面积、GPU完成和停止后精修。已有单自身滤镜与相同源回访收益不重复计作新成果。

如仍无法达到目标，再按分段trace决定投入图块合成，还是编辑侧COW/packet编码。原样本540.57→2.53ms的源回访、117的GPU约300→8ms，均只是已有特定构建与用例证据；它们显示值得探索的方向，不是下一项优化的速度承诺。本轮没有新PASS性能结论、没有启用任何候选。
