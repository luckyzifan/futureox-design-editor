# 大源页面载入修复 — 2026-10-26

本轮修复源页面入口、macOS 原生预算探测和页面转换调度。保留普通归档的 16/64 MiB 准入、共享 Document 的 16× 内存预留、WASM 地址上限、GPU 预算与源文件保存契约。

## 最终行为

- macOS 无继承预算时，固定调用 `/usr/bin/vm_stat`，按报告页大小读取 free + inactive 页；不经 shell、不由文档指定命令、不重复扣除压缩内存。失败或格式异常保留既有未知环境回退。预算仍在进程内固定，继承/显式配置优先。
- 初次打开进入一个画板后保留全部源页面列表。“载入页面”对过大页面返回连续的明确范围；界面提供上一部分/下一部分并说明完整导出含未加载内容。单个对象本身超限仍明确拒绝，不截断节点。
- 同次不可变源版本复用公共元数据及最多 4 MiB 的组件位置缓存。工作内存至少 2 GiB、累计模型尚未达到半个额度、两个根的源字节合计不超过 64 MiB 时，最多两个窗口并行转换。结果按源顺序合并；失败/取消前等待作用域线程退出。
- 切换失败恢复原来的页面 **和 offset**，保留原画布保存能力；
  同一页切到下一部分时，先保存属性修改，再使用原生返回的新页面 key 继续，不要求第二次点击；新范围不改源文件版本，属性写回、CAS、撤销及完整流式导出沿用现有通路。

## 真实拓扑文件

输入 SHA-256：`b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。
执行路径为实际 native source `large.scene`，CPU production / wall，GUI no。
显式固定 2 GiB working memory，即原有 **128 MiB 文档额度**。

| 页面 | 连续范围（1-based） | 结果 |
| --- | --- | --- |
| 控件 | 1–42 | 42/42 |
| 深色 | 1–52、53–55 | 55/55 |
| 浅色 | 1–4、5–104、105–113、114–209 | 209/209 |

306 个顶层源对象全部到达，未重复或遗漏；每份 DTO 均在额度内。
最终每段载入分别为控件 0.168 s、深色 5.972/0.201 s、浅色
7.785/15.652/6.478/7.378 s。整条测试含源复制/索引和清理约 59 s。
这些是 CPU 工作集载入时间，不是画布真实像素呈现时间。
最大 RSS 2,503,901,184 bytes；工作预算是既有表示预留启发式，**不是进程 RSS 上限**。

真实控件页属性修改 → 完整 64-member Sketch 导出 → 重开再次通过，
保留 773 个场景节点、42 个源根，实例宽度及名称修改可重读。
原始用户文件没有被改写。

## 基线、性能与模型 oracle

起点是 `39ff10b` 的已有大量未提交修改，见 [baseline.json](baseline.json)。
会话进行中，共享工作区被另一次操作提交为 `2954a77`，包含本轮当时已写入的部分文件；
此记录按实际文件/二进制 hash 绑定，不把 Git HEAD 当成干净独立基线。
该清理还删除了三个仍被 TS 源码导入的 JSON fixtures，收尾 typecheck 因此失败；
已从原始 39ff10b 恢复 arithmetic-vectors、certified-filter-vectors、precision-corpus，
只恢复构建必需的约 9.1 MiB 数据，最终 typecheck 再次通过。

优化构建的原始控件纯转换为 0.216/0.221 s，原始完整测试链约 41 s。
用户提供的 288 s 不能当作此优化构建的纯转换基线。
在相同 4 GiB working memory / 256 MiB 文档额度下，深色基线为
6.172/6.088 s，最终为 5.763/5.702 s；最终控件为 0.153/0.148 s。
控件与深色的输出模型都与优化前 **逐字节一致**，见 [model-oracle.json](model-oracle.json)。

浅色的严格整页构造在 256 MiB 下仍应拒绝：基线约 22.5 s，最终诊断约
24.5–25.9 s。此拒绝路径没有证明加速，整体性能不能称作全面改善。
生产 `large.scene` 已改为显式分段；不会以整个巨型页面的拒收作为普通页面导航结果。
这些少量顺序样本没有完整交替 A/B 和物理显示测量，只支持以上范围内的观察。

## 检查与构建

- 后端 lib：84 passed，8 ignored。新增分段覆盖/顺序、非法 offset、取消保持旧状态、后段编辑保留冷根及完整导出重开回归通过。
- 内存策略：4 passed；无环境变量覆盖的 macOS 实测 available=3,699,965,952，working=1,849,982,976，document=115,623,936 bytes（启动快照，非固定新额度）。
- 原生 `document_admission`：3 passed，包含原先在 macOS 回退策略下失败的 33 MiB 用例，无预算覆盖。
- 前端 3 个定向 suite：51 passed，涵盖真实 WASM 准入、分段前后切换及失败恢复原 offset。
- Desktop Node：15 passed，涵盖 offset/范围回执与分块 hash/owner/revision。
- TypeScript typecheck、portable WASM、native backend / design-prepare / design-render 和 Vite 构建通过。保留已有 dead-code/dynamic-import 警告。

构建/测试命令（在仓库根，前端命令另标目录）：

```sh
cargo test --manifest-path design-studio/Cargo.toml --locked -p futureox-design-desktop-backend --profile desktop-dev --lib
cargo test --manifest-path design-studio/Cargo.toml --locked -p futureox-design-kernel --profile desktop-dev --lib capacity::tests -- --nocapture
cargo test --manifest-path design-studio/Cargo.toml --locked -p futureox-design-kernel --profile desktop-dev --test document_admission
cargo build --manifest-path design-studio/Cargo.toml --locked -p futureox-design-desktop-backend -p futureox-design-kernel -p futureox-design-gpu --profile desktop-dev
python3 design-studio/scripts/build-web.py --profile desktop-dev
node --test frontend/design-desktop/test/large-document.test.mjs frontend/design-desktop/test/document-capacity.test.mjs
# frontend/design-client:
bun run typecheck
bun run test src/LargeDocumentWorkspace.test.tsx src/document-admission.test.ts src/desktop-json-admission.test.ts
```

真实文件的 ignored tests 使用 `CORE_LARGE_SKETCH_INPUT` 指向用户文件，
`CORE_DOCUMENT_MEMORY_BYTES=2147483648` 固定资源策略：
`actual_source_page_segments`、`actual_topology_complete_controls_page`。
性能/模型 helper 是 `actual_source_page_load_measurement`；它会打印 ERROR 而继续其他页面，
所以不能把 helper 进程退出 0 当作每个页面成功。

## Electron 检查

[check-page-navigation.mjs](check-page-navigation.mjs) 用新 native 二进制与构建后的 UI、独立 profile，
通过真实原生对话框适配器打开小合成 Sketch。1 MiB 启动预算强制 64 KiB 文档额度，
192 个根被分段。三个页面均可见，1–52 → 53–104 → 1–52 往返通过，
未见 `.kernel-status.error`。见 [报告](gui-report.json)、
[页面列表](gui-all-pages.png)、[第二部分](gui-page-range.png)。

此项是 actual Electron + native / GUI yes 的功能检查，**不是实际拓扑文件全图渲染或性能验收**。
测试实例在 `app.close()` 上仍超时，已仅终止该独立实例，记录 `closeError`；退出流程不算通过。
两次早期脚本失败分别是把元数据行也算为页面，以及混用 innerText/textContent 的空白比较；
原始失败报告保留。第三次导航断言通过。

## 保留的失败和边界

初始直接 FFI 探测候选触发 kernel `forbid(unsafe_code)`，未采用。
中间 `sysinfo` 候选在压缩内存压力下给出零可用量，导致 29 个后端用例失败；
已移除该依赖及其新增传递依赖，改为上面的 OS 查询和纯解析回归。
先前测试编译的 Vec move、一个旧按钮标签断言错误也已修复，失败日志没有覆盖。

G1/G3 的本轮源工作集、模型等价与实际磁盘导出链已测；G7 只覆盖记录的源操作边界。
G2/G5 全量真实 GPU/GUI 动作矩阵、完整浅色页同时渲染、设备丢失与压力/晚回全矩阵未运行。
不改变或宣称关闭仓库中既有渲染收敛问题。没有制作发布包或修改用户已安装应用。
