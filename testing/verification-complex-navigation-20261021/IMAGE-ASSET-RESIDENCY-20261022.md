# 同 owner GPU 图像资产驻留候选，2026-10-22

此改动只延长已上传的不可变 GPU image texture 在同一可信 owner 的区域切换间的寿命。它不改变像素、image adjustments、采样、滤镜、导出或编辑/撤销模型，也不增加 working budget 或 GUI 缓存预算。候选要求严格 `VITE_DESIGN_EXACT_CLAMP_PREFIX === '1'`、WebGPU 及私有 hydration 能力；未知/custom loader 和缺省路径继续原区域 prune。

## 已证实的旧入口与独立预算

原 `loadImages(scene)` 用当前区域 scene 的 image subset 作资产生命周期：一块已上传的图像只要不在下一块区域的 `needed` 中就从 map 删除并销毁，即使 GPU working budget 尚足。回到原区域时 `imageFor` miss 后重新 upload；`uploadLinear` 对这个新物理纹理重新执行原 `certifyExactImageRange`。原 decoded image cache 命中可避免 decode，却不能省去该次 GPU upload/range 扫描。

真实 deep2 worker 火焰图记录 `certifyExactImageRange` self **609.914 ms**，其中 **597.651 ms** 位于 `imageFor → uploadImage → uploadLinear`，**12.263 ms** 位于 gradient 字段上传。该采样窗口只有一个 driver 创建；它没有逐个资产 eviction reason，所以不能把 597.651 ms 全部归为 working-budget 淘汰，或当作本候选已经减少的时间。

GUI resident history、presenter payload 和 GPU working ledger 是独立预算。855×888、DPR2 的 deep2 与 working4096 的 deep3，GUI active steady 实测都为 **134,217,728 B**，balanced inactive-page 合计 surface ceiling 为 **234,881,024 B**。GUI GPU captures 是 RGBA/BGRA8（4 B/px），普通 managed working planes 是 RGBA32F（16 B/px）；presenter 另有 512 MiB nominal payload ledger。CORE working4096 不会自动扩大 GUI history。本改动没有修改这些上限，也没有把 GUI cache misses 与资产重传次数混为同一指标。

## 私有 owner 与请求授权分别验证

`managedSceneImageLoader` 私有 WeakMap 为实际 loader 注册不透明 owner。可信输入来自 worker 的 `sceneImageHydration`：private decoded-image owner、完整 color settings、实际 kernel 与独立 `ownerCurrent` 闭包。该闭包检查 lane、document/resource generation、engine promise、decoded owner 和完整 settings；同 ID 重新打开不是同 owner。scene、请求或文档字段不能授予该能力，公开函数属性和 typed-array identity 也不能伪造它。

每次读取仍检查当前请求的 `current`。请求过期立即抛 `PREVIEW_CANCELLED`，并封存该旧 ImageContext，不能把它切回 true 来恢复旧请求权限。但请求取消不撤回仍有效的文档资产 owner；下一合法新请求可继续复用同一 GPU 资产。独立 `ownerCurrent` 撤回才永久 revoke owner；kernel、scope、完整 settings、loader 或场景颜色/driver policy 不同也更换 owner。取消与跨 owner 的两类负例分别覆盖，避免连续 camera 替换请求每次清空资源而抵消缓存。

每个 asset hit 在使用前重查能力。scope 失效立即 detach 全部旧 lookup、尺寸和 atlas origins；新 owner 即使使用同 URI 也不能借旧纹理或证书。每个新的物理 upload 仍走原 driver 验证，不新增按 mutable typed-array 身份缓存的 range 证明。调整沿用原完整 variant key：不同 adjust 必须新 upload，源 decoded buffer 不被修改；undo 可借仍驻留的原 variant，旧 variant 仍在共同预算中按 LRU 释放。

## 资源与预算

同 owner 的区域 A→B→A 不再仅因区域 `needed` 不同而删资产。全部物理字节仍计入原 `this.bytes`，原 allocation gate 与 pressure-driven LRU 不变；不能借保留资产突破 hard working budget。正在 table/sequential/static-filter 使用的源仍按原 pin 排除。

scope 撤回先撤 lookup，已提交/被借用纹理留在独立 retired 集合并继续计账；只有退休之后的真实 checkpoint/abort 成功覆盖当时已归还所有 source pins 的退休 snapshot，后才销毁。旧 completedEpoch 恰等于当前 epoch 不能单独充当此证明；反过来，粗粒度 completedEpoch 停在 e−1 也不能否决已经实际完成的私有退休 cohort。必要的 scope 切换等待真实 checkpoint，不用提交 ACK 充当完成；失败等待保留旧账本和退休资源，不能重新公开旧 lookup。atlas 多个 slots 的共享物理页只计账、退休和销毁一次。device/renderer dispose 由既有 driver teardown 统一释放。

私有累计计数器区分 image hits、uploads、scope retirements、旧区域 prune、pressure evictions；不增加公开协议，不记录 URI、图层 ID、pixels 或 words，实际 proof wrapper 可直接读取这些计数。

## 首版 CPU 验证与历史来源

小型 CPU/mock 定向 **3 套、98 项通过**，其中新增资产驻留 **19 项**，其余为既有 hydration 与 reclaim 约束。覆盖同 owner A→B→A 零第三次 upload、不同 owner 同 URI 不同 pixels、settings/kernel/loader/scene policy、resource generation、request cancel→新请求继续命中、旧请求 ABA 拒绝、owner ABA 撤回、adjust/undo、硬预算/已 pin 源拒绝、真实完成 promise 前后账本、失败 fence 与 atlas aliases。`tsc --noEmit` 和 `git diff --check` 通过。mock device 不建立 GPU 像素或实机延迟结论；既有 WASM hydration 检查也不是新 GPU 驻留门。

首版资产增量（尚未补充下述 covered-cohort 收紧）冻结时，renderer SHA 为 `8ee544b4058ba3db55b115b114bc594f41adebe27929934b2110c814945c7591`，hydration 为 `9f54a2ae7cbe6484133012c86732cbfe4c612dbf08779c2b2a4f24e9585e7b04`，worker 为 `b0459f402b549815fb0e7a9e131e15cc9e3e550ad873369b52f478b0221def9b`，新增测试为 `0722daa6739ea8ead816704415b88dc3dc43f9513e6d756889e7f221c728a932`。对应 renderer 包含前一阶段的独立 wide-background 候选；两者数学与实际命中门必须分开记录。

实际设备门应使用相同文档/设置/loader owner/device：A（含图像）→B（image-free）→A→idle→A，对照旧 prune 与生产私有能力路径，检查实际 upload/retirement 计数和 A 的原始 GPU 像素 hash。自定义 raw loader 因不具能力仍走旧 prune，不能拿它的旧行为替代生产 worker 验收。完整实机复杂缩放平移、GUI history 回访、编辑、撤销和导出仍独立验收，不能由本项资产复用推断已经全部修好。

## 256 MiB 实际回访 v1：缓存验收失败，保留画面结果

使用相同设备、真实 117 文档和 native 请求实际执行 A（2 个图像依赖）→B（无图像依赖）→A→idle5s→A。旧 prune 与私有 capability 两路径的 A 三次各 16,384 个实际呈现字节 hash 均为 `9a24cab1ac7ac90de6fc0c46b6740dac81b2fdf80965c2844cce6f947b777550`，已记录比较差异为 0。**这次候选缓存门失败**：两路径 uploads 均为 2→4→6，pressureEvictions 同为 2→4→6，每次 A 后 residentImageTextures 为 0、legacyPrunes 为 0。

图像在单次 A 的真实 working pressure 中已被驱逐，B 没有剩余图像可区域 prune，因此本次没有建立预期的 old-prune/candidate-hit 正对照，不能说缓存已经修好。候选的峰值纹理计数为 267,702,164 B / 268,009,236 B，仍守原 256 MiB 账本；不能扩大预算后把它改记为产品缓存通过。后续较大诊断预算只能隔离区域 scope 机制，不能替代这个真实 256 MiB 失败。

此 v1 绑定首版 renderer `8ee544b4…c7591`，1158 项输入前后稳定，WASM 为 `40748786…fe1f`。GPU 结果 SHA 为 `ccb9a939490f495b5d2f71ef19a10198a5f6c456b5ea5cfccd82510ddbc4b658`，failure 记录 SHA 为 `c8a8e0235c167c8e6db4df93c7766da038613c3e123e7cc90c42dd321a9102db`；不公开 pixel bytes、节点身份或私人路径。该运行不覆盖后述 scope 回收路径，也不是整 GUI 缓存或 clean latency 验收。

## 同 epoch 的后续读取：收紧退休证明

复审发现 per-begin resource epoch 在 checkpoint 后仍可继续编码同 epoch 的新读取，所以 `completedEpoch == retiredEpoch` 本身不证明这些后续读取已完成。当前退休条目一律先设 `covered=false`，只由退休之后实际成功的 checkpoint/abort 为其已捕获 cohort 赋完成见证。部分录制、提交 ACK、旧 epoch、失败 wait 都不能赋证；等待期间新加入的退休对象不获得旧 cohort 的完成信用。

活跃 table/sequential/static borrows 可在之后继续编码，所以源在 snapshot 时仍有 pin 就不加入该 cohort。pin 归还后必须再经过新的真实完成边界，不能仅在 unpin 时销毁。有退休资产时，maintenance 的 prior-pool-epoch 省等待捷径也禁止。这些资源继续纳入原字节账本和硬 budget；没有异步 timer 偷改账本。

当前小型定向 **3 套103项通过，其中资产24项**，新增 same-epoch later-read、合法旧 pool 证书仍须新 wait、等待中后加退休对象、abort 成功/拒绝、pin 结束后仍须新 boundary 等控制。第一次后加 cohort 测试用深相等把两张同 shape 的不同 texture 当成同对象，修成 `===` 资源身份断言后通过；没有改生产算法满足该误断言。`tsc --noEmit` 与 diff 检查通过。

该收紧后的 renderer SHA 为 `b4f0b584168fb305ae53f5d58673ec4b991a8642bbaccd2384939235d6f585e7`，资产测试为 `330b71d5f6014d9833eb4a3b1ad4289450fa419bd22ac3e2daeb8f582cf13371`；hydration/worker 身份与首版相同。新的实际 GPU、真实 owner 切换回收和完整 Electron 回访门须另行记录；不能用首版 same-owner 输出 hash 替代此生命周期收紧的实际执行。

## checkpoint 的 e−1 记账：后续准入修正

真实 WebGPU `checkpoint(e)` 在完成其当前提交前缀后，仍只把全局 `completedResourceEpoch` 推到 `e−1`，因为同一帧 e 还可能继续编码新命令。`loadImages` 位于下一次 `begin` 之前，所以即使它已经真实等待旧资产退休 cohort 完成，条目所记的旧 epoch e 仍可能大于这个粗粒度计数。

初版 covered-cohort 实现额外要求 `entry.epoch <= completedEpoch`，会让已安全退休的旧资产继续占账本。例如旧200 MiB 与小目标能在256 MiB内，切换 owner 后真实等待已完成却仍扣着旧200 MiB，下一张200 MiB同步上传准入因此误报不足。首批 mock 把 checkpoint 后 completed 直接设为 e，掩盖了这个差别；没有将这种 mock 当作实际设备寿命证据。

当前实现只由严格的私有 cohort witness 授权释放：旧 lookup 已撤、snapshot 时没有未来合法 reader/pin、且退休后真实成功 boundary 覆盖该 snapshot。条目的 epoch 仅保留诊断用途，不作为额外必要门；也绝不提前推进全局 completed，否则会给其他资源错误的完成权限。失败 boundary、后来追加的退休、活跃 borrower 和同 epoch 的旧完成仍都不获证。

默认 mock 与手动完成负例已改为真实 `max(previous,e−1)` 语义，新增200 MiB旧资产→200 MiB新准入、全局仍停e−1的回归（仅 GPU 资源元数据，不分配200 MiB CPU数组）。**3套104项通过，其中资产25项**；typecheck/diff 检查通过。此前103项历史保留，不能相加计数。

此准入修正冻结的 renderer SHA 为 `5be85fe1dfc35410cd6f3d15534a332b7b0c0fbde427bbeb6910d3e5f075f8e2`，测试为 `1a84e28d3a9bc679e06437915fe85a0e7cd02544a948c87ea947631251a0b533`。hydration/worker 未改变。新的实际 GPU、owner 切换和256 MiB真实回访必须绑定此版单列；先前同 owner 的输出 hash 不能追认为新退休/准入路径已经实机通过。

## 1 GiB 诊断 v2：同 owner 区域驻留机制通过

新的 v2 使用最终 `5be85fe…f8e2` renderer 与 P5 WASM `20b6c2b8…aebb`，在同一 GPU 设备上分别执行旧 prune（不持私有 loader 能力）和生产私有 owner 路径。显式 working budget 为 **1024 MiB**，序列仍是 A（2 个图像依赖）→B（image-free）→A→idle5s→A。此预算用于隔离 scope 机制，不能代替前述真实256 MiB缓存失败。

| 观测点 | 旧路径累计 uploads / hits / region prunes | 候选累计 uploads / hits / region prunes |
| --- | --- | --- |
| 首次 A | 2 / 0 / 0 | 2 / 0 / 0 |
| B（没有图像依赖） | 2 / 0 / 2 | 2 / 0 / 0 |
| 返回 A | 4 / 0 / 2 | 2 / 2 / 0 |
| idle5s 后 A | 4 / 2 / 2 | 2 / 4 / 0 |

两路 pressureEvictions 均为0。候选四个观测点都保持2张真实 GPU image texture；旧路径在 B 后为0并在回到 A 时重新上传。这次有实际旧区域 prune 与候选资产命中的正对照，不能只凭“没有新上传”而省略控制。两路三次 A 的实际呈现字节 hash 全同，仍为 `9a24cab1ac7ac90de6fc0c46b6740dac81b2fdf80965c2844cce6f947b777550`，记录的差异为0。所有输出从真实 GPU 呈现捕获，不以 CPU 图片代替。

两路峰值纹理计数均为 **420,496,644 B**。1162项输入前后完全相同，浏览器错误0；GPU结果 SHA为 `c5f2066ee5bc72c810579eb0a7b745d2a51fb6bc943ef6c04feb3d7089ee8282`，结果包装 SHA为 `c6f8c55c4b5d2ce787d87109dad9d7d36f5d0bae047748f278199c16e84c3a18`。完整匿名计数、源/输入/结果哈希及历史256 MiB失败见[驻留摘要](image-asset-residency-summary.json)，不含图像URI、原始文档或私人路径。

**已建立的是显式1 GiB诊断预算下的同owner源资产驻留，不是256 MiB产品缓存、整机GUI tile/result cache、无模糊或低延迟通过。** v2没有切换 owner，`scopeRetiredTextures`均为0，所以真实 owner-change retirement 仍未由这个GPU门覆盖。单轮顺序 cold/warm 诊断时长也不能建立延迟改善。v1与v2的renderer/script/WASM来源不同，不能把两轮耗时相减作为预算优化A/B；v1的压力失效原样保留，后续最终构建的复杂实机验收仍需单列。

## Deep4 复杂参考失败：禁止二次 finish 已结束 encoder

Deep4 实际117操作完整执行90阶段、366次wheel与960次pan输入，取得16次真实内容捕获；sharp门仍有5164项违反。参考只成功9/16，其余7次为 `Invalid CommandBuffer`，不能将缺失参考当作白块/画质通过，也不是旧CPU combined-halo guard。

原始 stderr 的首因是 **`Command encoding already finished`，发生在再次 finishing 同一个 CommandEncoder**；其后才是 Queue.Submit 的 InvalidCommandBuffer。原日志有8对相关底层错误，而最终 unavailable reference 是7项；底层尝试次数与最终参考结果分别记录，不能互相替代。

直接代码链为：独立 reference 每次提交全文 document，同ID也会换 private document owner；新 `loadImages` 在下一次 `driver.begin` 之前退休旧资产并调用旧 in-frame `checkpoint`。上一次 `finish` 已消费旧 encoder，`checkpoint → submitCommands → submitEncoder.finish` 因而二次 finish。原同owner A/B/idle proof没有换 owner，所以没有覆盖这一帧间路径。该根因与权限/缓存scope变化相关，但不是图像像素或范围证书可近似解决的问题。

现在提供可选的正式 `waitForSubmittedWork()`：仅在 driver 明确已结束帧/初始化/abort成功后的帧间状态可用，只等已经提交的队列，不访问/finish/submit旧 encoder，也不推进全局 completed epoch。开始新帧、abort、dispose、revive和device loss均改变状态代标；失败或await期间 owner改变不得给旧 cohort 完成信用，也不能把旧失败的状态写进已替换的新generation。旧 retired-table 与 submitted byte-lease只回收实际 boundary 覆盖的snapshot。

`loadImages` 的资产生命周期权限要求此正式API，只用它等待退休snapshot；普通在帧内的 `reclaimScratch` 仍用原 checkpoint。每次只做一次正式boundary，之后仍有合法pin的源继续计账，不能无限等或放宽预算。新的API也检查旧未捕获错误，不以重置encoder或吞错误掩盖失败。

小型 **6套188项检查通过**，包括资产26项、独立 submitted-boundary13项及既有 hydration/table/byte/reclaim约束。严格mock的旧encoder再次 `.finish()` 必抛：旧checkpoint反例确实抛错；正式API跨5次换owner从不调用finish。失败queue、并发begin/dispose/device loss、新ended-generation、后加table、旧全局epoch、硬256MiB与source pins等控制均通过。统一typecheck通过；首次统一检查只发现并行新增的sample-only mock给readonly resourceEpoch赋值，修为本地epoch+getter，未放宽产品接口。

共同冻结时renderer为 `92434e63e7bb44e32d3a024d3f5c06993e66a2e2f8a5d0886854a6f5c8ea0326`，WebGPU为 `350ac25e98ddabd7b5f8743a4e572931b338a20199c7138ae7624f987eddcff7`，types为 `bef4c181665c8637f363be99d78b8fb6a6ffb2c783824d66a6e20779ab30b812`，资产测试为 `bd5ecd191240a43dc6568a6ded1386e52d64a3d5c9cdbfcaa8a6c89916be013d`，新submitted-boundary测试为 `7674ad627d80919229988844784c8ae7425c6f0e2aaf16c8a642f31062861ce3`。共同源码还含独立sample-only显示意图及预算策略增量，不自动由本项生命周期小测验收。

此为根因定位和CPU生命周期修复，原失败的reference请求序列仍须实际GPU重放；不能把旧1GiB同owner机制通过追认为新owner切换/复杂画质或低延迟通过。原Deep4 stderr SHA为 `48f7b1d1aedabdb4830664ef79d6d1ec0626ab74bfb5d04dfbe94b40a7c70028`，reference-progress SHA为 `1b01118c0d20911f5c4b257b80f765df21adf4402ec3ae2cd367659658f7abcc`。原始私有camera/图层/内容与路径未收入公开记录。
