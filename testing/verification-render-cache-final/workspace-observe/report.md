# workspace.observe：保持 schema 5 的目录编码/散列复用

日期：2026-10-19 UTC。工作树：`${REPO}`。

## 结论

实现并验证了比原审计的持久 generation 更窄的改动：每次观察仍执行原来的完整、有序、最多 10,000 条目录头 SELECT；只有查询所得的全部 `Entry` 与上次成功编码的目录逐项相等时，复用原内容 SHA-256。未增加表、trigger、迁移、依赖或 schema 版本，仍为 **5**。原有轮询频率、presence、revision、viewHash 格式及错误边界不变。旧 writer 指本次优化前仍支持 schema 5 的交付代码；没有额外宣称更老二进制的兼容性。

这减少稳定目录上的 JSON Value 构造、canonical JSON 序列化及散列工作，**没有去掉 SQL 扫描、结果解码或完整 Entry 比较**。跨进程、旧写入方与回滚不需要新的失效协议。更进一步的持久 generation 方案仍属未来独立设计。

## 代码与一致性

改动文件：

- `design-studio/crates/design-desktop-backend/src/workspace.rs`
- 新增 `design-studio/crates/design-desktop-backend/src/workspace_observe_tests.rs`

`Entry` 的派生 `PartialEq/Eq` 包含实际序列化的全部六个字段：`id`、`name`、`revision`、`hash`、`updated_at`、`deleted`。比较还包含列表顺序与长度。数据库查询仍是原查询，排序仍为 `updated_at DESC, id`，过滤与 10,000 条上限未改。

每次目录查询成功后才调用缓存路径。命中条件是本次完整查询结果精确相等，不能仅靠文档 ID、时间戳、版本最大值、连接 `data_version` 或进程内 generation 命中。缓存只持有不可变的 `Arc<{entries, hash}>`。锁仅用于克隆/交换 Arc；列表比较、SQL、JSON 构造、hash 和旧值释放均不持锁。

miss 时使用原 `json!({"documents": entries})` Value 表示，再执行相同 32 MiB `bounded_json` 和 SHA-256。不能直接序列化 Entry struct 替代该 Value，因为字段顺序会不同。成功后才发布完整 entries/hash 对。迟到的旧查询可以覆盖较新的缓存而降低命中率，但下一次查询必须重新精确比较，所以不会为不同目录返回缓存 hash。缓存 poisoned 时退回原计算路径；SQL/解码/字节预算失败不会被缓存掩盖。

相同传入 hash 仍返回 `changed=false, documents=null`；空或陈旧 hash 仍返回完整当前目录。presence 更新、TTL 清理、peer 解码和顺序、64 窗口限制、离开会话等工作仍每次执行。

## 内存边界

只保留一份 store-local 目录快照，按 Vec 容量、每个字符串容量、snapshot 结构和 Arc 引用计数头估算，最多 4 MiB；超预算时跳过缓存，保持原成功/错误语义。没有保留 snapshot BLOB、字体或图片。

这不是全进程或峰值内存上限：当前 SQL rows、当前 Entry 向量、canonical JSON、响应编码、并发重建以及短暂被另一调用借用的旧 Arc 另占内存，分配器的元数据也不在容量记账中。10,000 条测试目录的已计费缓存为 2,742,992 字节。

## 验证

所有测试使用真实 SQLite。生产方法内的计数仅在 `cfg(test)` 编译，非 mock cache 实现。

- 新增 7 个测试覆盖 1 / 1,000 / 10,000 目录、全部六个字段变化、排序、旧 writer、history-only 更新、presence churn/expiry/64 窗口限制、rollback、失败 transaction、幂等 retry、未知结果后重开、trash/restore、根隔离、迟到发布、失败 SELECT、10,000 条截断、4 MiB cache fallback、32 MiB 原 JSON 限制、连接池更换物理连接、并发 commits/observe 以及 poisoned cache。
- 独立未修改 baseline 与 candidate 二进制通过真实 stdio 管道运行，**34 个完整响应/原 hash oracle 检查通过**。同时启动旧 baseline writer、baseline observer、candidate observer，共用同一 SQLite；包含 schema 1→5、丢弃成功提交回执并杀死 writer 后重试、进程重启、外部原位 metadata 更新及失效 SELECT。比较完整 observe result；另外用 canonical 未缓存 list 的 SHA-256 校验。
- 最终完整 backend suite：`verification-20261019T1716/backend-suite-frozen.log` 确认 **90 passed，0 failed，1 ignored**；ignored 是既有显式 CJK 字体大小/时间基准。
- 独立只读 reviewer 另用 baseline/candidate stdio 完成 **196 项黑盒检查**：96 个随机逐字段 metadata transaction、rollback、ABA、stale/warm hash、查询失败/表恢复及 restart，未发现未解决的一致性问题；该次对应相同 workspace.rs 与候选二进制 SHA，证据位于并列 `independent-review/`。
- Backend 范围 `cargo clippy --all-targets --no-deps -- -D warnings` 通过。包含依赖的严格检查被既有 `design-kernel` 的 31 个 lint 错误阻止，原始失败日志保留；未修改这些无关代码，也不声称整个 workspace lint 清洁。
- 所有 Cargo 从仓库外运行，显式 manifest、`--locked --offline`；使用本任务独立 target。未重建或替换 root 的共享 runtime。没有 OS socket、GUI、GPU、网络请求或 repository fetch。

### 实际生产路径工作计数

每组 12 次 observe；目录大小分别为 1、1,000、10,000。每组均为 12 次 SELECT，返回/解码 12×N 个 metadata rows（不是 SQLite VM 内部访问次数）。

| 场景 | canonical JSON 序列化 | SHA-256 | cache hit |
|---|---:|---:|---:|
| 从空缓存开始、目录不变 | 1 | 1 | 11 |
| 已热缓存、另一个真实 store 持续更新 presence | 0 | 0 | 12 |
| 另一个真实 store 每次修改当前 head metadata | 12 | 12 | 0 |

旧算法无条件在每次 observe 执行 canonical JSON/hash；上表是候选生产代码实际测到的次数。最终响应 JSON 编码不在 canonical 序列化计数中，仍照常进行。完整原始计数见 `operation-counts-frozen.json` 与 `backend-suite-frozen.log`。

## ABBA CPU / stdio 测量

使用未改 baseline 与 candidate 两个独立、未插入计数器的二进制，Cargo **dev opt-level=0/debug=0**。每种大小/场景按 A-B-B-A 运行，1 / 1,000 / 10,000 heads 的每批轮询数分别为 300 / 100 / 30，另有每批 4 次热身，共 36 批。计时前协调其他任务暂停重负载；这不保证整个宿主机无其他负载。

子进程 CPU 来自 Linux `/proc/<pid>/stat` 的 user+system ticks，时钟粒度 10 ms，按同组两批的总 CPU / 总轮询数计算。以下单位都是 **子进程 CPU ms / observe**：

| heads | 场景 | baseline | candidate | CPU 下降 |
|---:|---|---:|---:|---:|
| 1 | 不变 | 1.667 | 1.350 | 19.0% |
| 1 | 仅 presence | 1.750 | 1.650 | 5.7% |
| 1 | 每次 head 改变 | 1.633 | 1.617 | 1.0% |
| 1,000 | 不变 | 28.250 | 11.300 | 60.0% |
| 1,000 | 仅 presence | 29.350 | 13.000 | 55.7% |
| 1,000 | 每次 head 改变 | 39.600 | 39.200 | 1.0% |
| 10,000 | 不变 | 267.667 | 118.167 | 55.9% |
| 10,000 | 仅 presence | 282.000 | 116.500 | 58.7% |
| 10,000 | 每次 head 改变 | 396.167 | 373.167 | 5.8% |

小目录结果更受固定事务开销与采样噪声影响，不应把百分比泛化。每次变更负对照仍完整编码/散列并返回相同完整目录，没有把必要工作错误跳过。该改动也省去了 miss 响应的一次中间目录 Value 深拷贝，因此变化组不必完全等耗时。

`benchmark-results.json` 保留每一批的子进程 CPU、P50/P95、全部逐次 wall latency、响应 result payload 字节数、变更次数及二进制 SHA。wall latency 包含 stdio 和 Python JSON 解析；子进程 CPU 不包含 harness/外部 SQLite writer。presence 和 metadata change 由另一 SQLite 连接写入，写入位于每次 observe 的 wall 计时外。数据是合成 metadata；observe 本身不解码 document snapshots。

**没有测量 release/desktop-dev 优化后二进制，也没有测量渲染、UI、FPS、GPU 或输入到显示延迟。上述值不能作为这些场景的速度承诺。**

## 证据与复现

根目录：`${EVIDENCE_SOURCE}/workspace-observe`。

- `source-binary-manifest.json`：本次源文件、harness 和 baseline/candidate 二进制的精确 SHA-256/大小
- `workspace-observe.patch`：相对本任务开始时 workspace.rs 的限定 diff
- `baseline/workspace.rs`、`baseline/backend`：未修改 baseline
- `candidate/backend-bench`：实际 ABBA 测量的候选二进制
- `verify_stdio.py`：完整响应与跨进程兼容性 harness
- `benchmark_stdio.py`：36 批 ABBA CPU/stdio harness
- `verification-20261019T1716/`：独立的新日志、计数、原始样本和结果，没有改动早先交付证据或 ZIP

在仓库外 source `${ORIGINAL_TOOLCHAIN_SETUP}/rust-env.sh`，设置独立 `CARGO_TARGET_DIR`，运行：

```sh
cargo test --manifest-path ${REPO}/design-studio/Cargo.toml -p futureox-design-desktop-backend --locked --offline
cargo test --manifest-path ${REPO}/design-studio/Cargo.toml -p futureox-design-desktop-backend --locked --offline --lib observe_tests -- --nocapture
cargo clippy --manifest-path ${REPO}/design-studio/Cargo.toml -p futureox-design-desktop-backend --all-targets --no-deps --locked --offline -- -D warnings
python verify_stdio.py --baseline /absolute/path/baseline/backend --candidate /absolute/path/candidate/backend-bench --output /absolute/path/new-verification
python benchmark_stdio.py --baseline /absolute/path/baseline/backend --candidate /absolute/path/candidate/backend-bench --output /absolute/path/new-verification
```

运行 harness 前创建新的 output 目录，不覆盖本次或先前的验证记录。基准需再次协调独占重负载窗口。取消的自建 Rust AI task core 未恢复，本任务没有新增任何相关表或 API。
