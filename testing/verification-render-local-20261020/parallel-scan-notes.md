# 并行长行 prefix scan：实现与验证边界

最终处置：完整 Electron 对照未通过流畅度验收，候选已从生产源码撤回，
以下源码身份对应保存的补丁。完整结果见 [本轮报告](README.md)。

本候选只修改 `texture-prefix.wgsl`、`texture-prefix.ts`、`prefix-band.ts`
及对应 CPU 扫描/预算测试。文本布局 v2、系数构造、`prefix-int128.wgsl`
除法与最近偶数舍入、动态 uniform/cache 开关均未改变。

## 28/28 CPU 检查

在 `frontend/design-client` 执行：

```sh
node node_modules/vitest/vitest.mjs run \
  src/kernel/gpu/texture-prefix-scan.test.ts \
  src/kernel/gpu/prefix-band.test.ts --maxWorkers=1
```

最后一次输出摘录：

```text
Test Files  2 passed (2)
     Tests  28 passed (28)
  Duration  1.54s (tests 87%, transform 9%, setup 3%)
```

原调用未另存独立 stdout 日志；上面是当时会话输出的摘录，不是补跑。
首次 28/28 通过后，为 metadata 原地覆盖增加了明确 `storageBarrier()`，
随后完整重跑上述两文件，结果仍为 28/28。两次结果重叠，不累加计数。
相关五个源/测试文件的 `git diff --check` 无输出。本子任务没有运行 GPU、
应用、typecheck 或完整构建。

扫描测试执行生产 WGSL 的局部扫描、chunk carry 扫描及 prefix/sample
lookup 语句，仅将标量语法与 barrier 转为 CPU generator。独立 BigInt
标量累计提供期望值；覆盖反向 chunk 顺序、不同 lane 顺序、所有 prefix
与恢复出的单样本，以及 512/513/767/768/769/1024/3484/16384 长度、
尾块补零、跨块边界、符号抵消、大模整数和非零行偏移。
这不是 GPU 调度或内存模型执行证据。

## 计算与数学边界

- 小于 512 的行仍运行原 `prefixScan` 和 solve。
- 长行先由原 `prefixScan` 执行完全相同的整行 exponent/finite/span/
  系数位宽准入，再让每个 `(line, 256-sample chunk)` 独立扫描。
  每块共用整行的最小指数；moment 使用原整行索引 `j`，不能改成块内索引。
- 随后一个 64-lane workgroup 对最多 64 个 chunk totals 作 exclusive
  scan，得到每块前缀 carry。tail chunk 的空 lane 是精确零，因此 lane 255
  也能提供不满块的完整 total。
- 总 prefix `k` 表示样本 `[0, k)`；`k > 0` 所属块必须是
  `(k - 1) / 256`。例如 `k = 256` 仍在前一块；`k = 0` 保持零。
  若直接用 `k / 256`，边界会重复添加一个整块。
- 单样本由相邻块内 prefix 差分恢复；块首的前一局部 prefix 是零。
  这里 carry 精确抵消，不必重复读取/相加 carry。范围 sum/moment 查询才
  加 carry。所有算术仍为同一模 `2^128` 整数操作，原准入保证支持域内的
  有符号累积范围；像素最后仍交给原最近偶数舍入与 exact fallback。
- chunk totals 与 carries 共用 metadata 区，原地覆盖前增加
  `storageBarrier()`；扫描自身继续使用 workgroup-memory barriers。
  准入、chunk scan、carry scan、solve 之间使用独立 GPU dispatch/pass，
  没有增加 CPU completion fence。

长行每个 band 从两个 compute pass 变为四个，resolve pass 不变。
该取舍增加 dispatch 和少量 carry 读取，不能根据并行度直接推导加速比。
3,484 长行的 29-line band 由原先 29 个各循环 14 块的扫描 workgroup，
变成 406 个独立 chunk workgroup。

## 全长度 scratch 边界

实际分配保持原来的 4,194,304 字节：

| 区域 | 字节 |
|---|---:|
| Prefix pairs | 3,275,776 |
| Results | 901,120 |
| Metadata | 16,384 |
| Readback | 1,024 |

对长行令 `chunks = ceil(length / 256)`，每行 metadata 为
`16 + 32 × chunks` 字节；开头另有原来的 16-byte counter header。
`prefixBandSize` 同时取以下上界的最小值：

```text
floor(PREFIX_BYTES / (32 × (length + 1)))
floor(RESULT_BYTES / (8 × length))
floor((METADATA_BYTES - 16) / (16 + 32 × chunks))
maxBandLines
```

短行不存 chunk totals，metadata 每行仍为 16 字节。
CPU 测试逐一覆盖 1–16,384 的所有允许长度，核对三个平面的边界及
不超过 64 的流式 strip；也覆盖 `maxBandLines = 2`。
这没有通过只缩 band 来掩盖原 prefix 索引越界。

实际 3,484 长度仍允许 29 行：metadata 为
`16 + 29 × (16 + 14 × 32) = 13,472` 字节，aligned strip 仍为 58。
513 长度有三个 chunk，metadata 将 band 从原来的 199 限到 146；
所有 header、prefix、result、chunk carry 索引都使用同一个实际 `count`。

## 主流程实际 GPU 门

主代理已串行执行并记录
[19-case Apple Metal 结果](gpu-parallel-textures-v2/results.json)：
零 bit difference、零 protocol failure，scratch 仍为 4 MiB，
247 次 uniform rollover。覆盖 3484/r1224.3035888671875、3484×64、
16384、纵轴和长行 decline fallback。
原始运行日志为 [gpu-parallel-textures-v2.log](gpu-parallel-textures-v2.log)，
前后源身份在该结果目录的 `inputs-before.json` / `inputs-after.json`。

第一次 GPU 尝试的记录保留于 `gpu-parallel-textures` 和
`gpu-parallel-textures.log`：16384 案例未在 harness 的 `requestDevice`
请求对应纹理上限，触发 validation error。主代理只修正 harness 按实际
adapter limit 请求后的第二次运行通过；没有为通过比较改变生产算法。

上述 GPU 门证明这些实际纹理和 fallback 的逐位等价，不证明整个 Electron
交互已达到低延迟。完整 release 与 117 同操作 A/B 由主代理继续记录。
StorageManagement/Figma 等用户后台活动是性能比较限制；本子任务未停止
任何用户进程。

## 冻结身份

路径相对 `frontend/design-client`：

```text
6603763a9d7429e9b7f185f6d604488056152a56a201ea3cab87750dd9b6c423  src/kernel/gpu/texture-prefix.wgsl
0e5ec8d90607a16e4f305c3a22a5802f2aaeb627e7ad6641e37b5217974fb39f  src/kernel/gpu/texture-prefix.ts
ad68af03966f919d3f48836931f5b95db98180058331c765e01d3b48cc588da9  src/kernel/gpu/prefix-band.ts
168626aa8c7d10178f25b53ea7ac9946f7c983f1c1b943a90f195ba344381d9e  src/kernel/gpu/texture-prefix-scan.test.ts
08fcef75ae2f432ddd16bd818d63b279102dda989900ea2599288af57e0d73f5  src/kernel/gpu/prefix-band.test.ts
```
