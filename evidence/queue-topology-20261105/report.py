"""Render the report only after all timing, equivalence, and cold rendering gates have returned."""
from pathlib import Path
import json,statistics,re,sys
w=Path(sys.argv[1]);p=Path(__file__).resolve().parent
rd=lambda n:json.loads((p/n).read_text())
x=rd('comparisons.json');desk=x['shipping'];cpu=x['cpu117'];native=x['native'];gpu=rd('device-summary.json');prof=rd('waits-and-lifetimes.json')
assert all(len(d[a]['samples'])==2 for d in desk.values() for a in 'AG')
px=rd('shipping-pixels.json');assert all(v['different']==0 for v in px)
def f(n):return f'{n:,.2f}'
def seconds(v):return format(v/1000,'.3f' if v<1000 else '.2f')
def join(xs):return '、'.join(seconds(v) for v in xs)
def m(stage,arm):return desk[stage][arm]['ms']
def s(stage,arm):return seconds(m(stage,arm))
def src(stage,arm):
 return '；'.join(' / '.join(str(k[1]) for k in scopes if k[0]>100) or '无新范围' for scopes in desk[stage][arm]['scopeCounts'])
lines=['# 拓扑原件：GPU 等待、阴影临时表面、高倍原生编包和停稳调度','',
 '原件为 **118,272,240 字节** 的《拓扑素材.sketch》，SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。Apple M2 Pro、16 GiB、DPR 2。A 是上一轮已包含 CPU 单帧准备和双相位输出的完整产品，G 是本轮正式构建。均从在盘原件打开，在新 Electron 工作区使用真实滚轮和画布。以下整屏时间从最后一次手势结束算到当前相机清晰。','',
 '| 场景 | A 两次（秒） | G 两次（秒） | 中位数（秒） |','|---|---:|---:|---:|']
for k,name in [('dense-cold-view','进入密集视口'),('dense-more-detail','继续放大'),('dense-zoom-back','缩回总览'),('dense-inflight-return','精修中改向再返回'),('high-100','100%'),('high-3200','3200%'),('high-pan','3200% 横移'),('high-pan-return','横移回访')]:
 a,b=desk[k]['A'],desk[k]['G'];lines.append(f"| {name} | {join(a['samples'])} | {join(b['samples'])} | {s(k,'A')} → {s(k,'G')} |")
lines.insert(2,f"**高倍原件。** 3200% 停稳到整屏清晰 {f(m('high-3200','A'))} → {f(m('high-3200','G'))} ms；横移 {f(m('high-pan','A'))} → {f(m('high-pan','G'))} ms。密集首屏另行补测，见下一段的四次样本。")
lines.insert(3,'')
lines+=['',f"密集首次整屏各轮成功装入的非空范围（素材键个数）：A：{src('dense-cold-view','A')}；G：{src('dense-cold-view','G')}。同一相机可能带入 10 项 / 15,604 节点或 12 项 / 20,106 节点，不能用混合工作量证明固定比例。高倍回访的毫秒数、最后一个真实输入至清晰、每个原生请求的发出时间，以及采样瓦片的纹理峰值见[各轮桌面数据](shipping-desktop.json)和[两次样本及中位数](comparisons.json)。",'',
 '## 等待和驻留来自哪里','',
 '等待按实际阻塞的调用计时，不把后台观察的重叠区间相加。六个密集暖帧，旧版 graph 合计 813.3 ms，其中 checkpoint 为 542.0 ms；177 次高水位对较早提交前缀的实际等待合计 533.8 ms。没有阻塞的资源准入、prefix scratch 或图片表回收。维护同步前段合计约 9.6 ms；这里没有把 graph 减 checkpoint 当成纯 JS CPU 或 shader 耗时。四个高倍屏内瓦片恰好相反：4 次 admission 等待合计 44.7 ms，命中 pool + retired upload（掩码 3），没有硬预算超限；实际 raster-yield 等待约 1.8 ms。回收候选字节不当作释放字节。生产可用 `VITE_DESIGN_QUEUE_WAIT_TIMING=1` 把真正被等待的旧前缀记入现有 raster-yield 桶，不额外提交或创建完成栅栏。[原因与分配生命周期汇总](waits-and-lifetimes.json) · [A 逐批写区、输出和租期](allocation-and-queue-A.json.gz) · [B 记录](allocation-and-queue-B.json.gz)。','',
 '3200% 实际请求没有 dense 载荷，四块的 dense pair 尝试和 clip/drawRegion 回退均为零；实际工作包含普通 source layer、蒙版/合成、滤镜和回写。六个密集包的旧路径则有 1,704 次 batch 配对尝试全部绘出，另有 442 个效果源使用配对。没有扩展到四附件。','',
 '四块高倍输入产生了 18 个零通道阴影场。原先仍分配四相累加、模糊和重建所需表面，单块最多同时借用 46.05 MiB 的最终阴影纹理。新路径在检查原参数、前置效果、组、spread 和设备尺寸后，共享一张 16 字节的透明纹理；每个场仍有自己的世界坐标和租期。若整批没有画笔、所有影子输入均为零且编码操作数有限，着色器原本只返回旧目标，直接保留四个目标。其他情况执行原算法。','',
 '## GPU、编包与桌面分开验收','',
 '| 固定真实帧包 / 每块中位数之和 | 等待完整队列 A → B（ms） | 最终额外排空（ms） | 最重单块纹理账本（MiB） |','|---|---:|---:|---:|']
for k,n in [('dense','六个密集包（B 显式启用实验合批）'),('visible3200','3200% 四个屏内块（默认阴影优化）'),('edge3200','3200% 两个边缘预取块')]:
 a,b=gpu[k]['A'],gpu[k]['B'];lines.append(f"| {n} | {f(a['complete'])} → {f(b['complete'])} | {f(a['tail'])} → {f(b['tail'])} | {a['peak']/2**20:.1f} → {b['peak']/2**20:.1f} |")
lines+=['','分别预热两个 Metal/WebGPU owner，ABBA BAAB 交替，计时前后等待实际队列完成，计时不读回。以上是瓦片串行回放，附加排空已包括在总时长中，纹理账本不等于进程 RSS。GPU-only B 组合里密集合批减少约 29% 附件像素，但自由手势整屏收益不稳定；该功能只在 `VITE_DESIGN_DENSE_SPARSE_BATCH=1` 开启，**不计入 G 的默认收益**。回写局部纹理、改变队列切片等实验也未采用。没有提高预算或把必要等待移到帧尾。[逐次读数及像素哈希](metal-samples.json.gz) · [未采用的对照](discarded-controls.json) · [仅 GPU 的桌面结果](gpu-only-desktop.json)。','',
 f"从高倍原件抓取的相同快照和六个请求，每臂三次启动独立原生准备进程。首次编包中位数 **{f(native['A'][0])} → {f(native['B'][0])} ms**，同相机接下来三块为 A {' / '.join(f(v) for v in native['A'][1:4])}、G {' / '.join(f(v) for v in native['B'][1:4])} ms。旧版活动请求采样 539 次，有 390 次在 `prepare_node_geometry_indexed` 下，递归栈落到 `flatten_cubic_guarded` 和 `hypot`。保留原投影、点顺序、深度、误差容限与预算；仅在平方距离远离阈值时判定，临界、超出适用容差或不确定数值执行原 `hypot`。六块跨版本完整解码场景、几何字节和资源载荷一致。线包只有进程私有 resourceScope 不同，A/A 也有同样差异。[原生栈](preparation-stack.txt.gz) · [编包交替样本](shipping-native.json) · [元数据与字节核对](shipping-native-equivalence.json)。",'',
 '首次集成时，原生提速使 16 倍设备密度的中间预览能在停稳后进入 GPU；两次 3200% 分别用了 1,200、1,175 ms，原生最终请求虽已加快，发出时间却延后到手势后 719–730 ms。[未修调度的桌面数据](integrated-no-priority-desktop.json)。最终版只在停稳后、已有当前 DPR 实际确认的无缺口画面完全覆盖新视口、且过时工作每轴至少低四倍时优先请求最终瓦片。运动中、无覆盖或不同 DPR 保留原有补画；取消不释放物理 slot，已接受纹理仍可显示，精确像素收齐才报告 ready。可用 `VITE_DESIGN_SETTLED_SOURCE_PRIORITY=0` 单独回退；用 `VITE_DESIGN_SPARSE_SOURCE_WORK=0` 单独回退零场优化。','',
 '覆盖调度单独解决了高倍中间瓦片，也暴露了另一条密集改向路径：两轮窗口已返回同一相机，主进程却接到新的 10/11 键范围，成功发布会撤销旧 token。清晰时间分别回退到 8.81、11.64 秒。现在，已经显示至少六项的完整范围在视口驱动、要求仅增加一两项且有重叠时，发布前至多复核一个既有的 120 ms 采样周期，并以最新相机重新计算材料需求。快速连续变更不会每次重新开启这个周期；显式页操作、首次进入、远区和不重叠的请求不等待。既有 host 令牌与权限未改变。[加范围复核之前的全部原件样本](before-scope-review-desktop.json)。','',
 '## 117.sketch 与像素','',
 '| CPU 块数，50% 全页 | 准备 A → G（ms） | 整帧 A → G（ms） | 进程峰值 RSS A → G（MiB） |','|---:|---:|---:|---:|']
for k in ('1','4','16'):
 a,b=cpu[k]['A'],cpu[k]['B'];lines.append(f"| {k} | {f(a['prepMs'])} → {f(b['prepMs'])} | {f(a['frameMs'])} → {f(b['frameMs'])} | {a['rssMiB']:.1f} → {b['rssMiB']:.1f} |")
lines+=['','CPU 对照两臂均保留原有共享计划。RSS 是操作系统峰值，另保留 compositor 峰值和 physical footprint；不能拿准备加速替代整帧或推断 RSS 普降。[逐进程数据](cpu-117.json)。',
 '',f"Metal 上 {sum(gpu[k]['channels'] for k in gpu):,} 个 RGBA32F 通道逐位相同。CPU 的 1/4/16 块，以及跨块模糊、背景模糊、蒙版、zoom blur 和含大于 1 的 HDR 浮点通道、16 位 Rec.2100 PQ PNG 均通过；重新构建的 WASM 也通过这些像素对照。[CPU](cpu-pixels.json) · [WASM](wasm-pixels.json)。两个独立桌面工作区在密集进入、平移、返回及 3200% 四个固定相机，分别核对原生画布和实际窗口裁区，像素差均为 0。[截图哈希与精确差异](shipping-pixels.json)。",
 '', '复现和审阅：[测量协议](protocol.md) · [校验记录](checks.json) · [实际产品哈希](products.json) · [增量源码](source.patch)。完整真机桌面依然以秒计，本轮结果不外推到其他文件、GPU、所有视口或发布级延迟门槛。']
if 'allDenseCold' in x:
 dc=x['allDenseCold'];a,b=dc['A'],dc['G']
 lines.insert(4,f"**密集首屏的补跑。** 第一组每臂两次，G 出现 18.56 秒慢轮。随后按 AGGA 只重复首次进入，仍从真实文件和新工作区开始。保留两组全部记录：A {'、'.join(seconds(v) for v in a['samples'])} 秒；G {'、'.join(seconds(v) for v in b['samples'])} 秒；各臂四次中位数 **{seconds(a['medianMs'])} → {seconds(b['medianMs'])} 秒**。[补跑的原始整屏与工作量](additional-cold-desktop.json)。下表的首次进入行仅列第一组，与该组的后续手势配对。")
 lines.insert(5,'')
if (p/'dense-native.json').exists():
 rows=rd('dense-native.json');vals={arm:statistics.median(sum(t['wall'] for t in r['samples']) for r in rows if r['arm']==arm) for arm in 'AB'}
 lines.extend(['',f"密集区补充对照：同一份 17,190 节点快照、同一 0.1971 设备相机、六个实际请求，独立 owner 首包及后五包合计中位数 {f(vals['A'])} → {f(vals['B'])} ms。只测原生编包，不能据此推算桌面清晰速度。[逐包读数](dense-native.json)。"])
 if (p/'dense-native-equivalence.json').exists():lines[-1]+=' [包内容核对](dense-native-equivalence.json)。'
(p/'README.md').write_text('\n'.join(lines)+'\n')
