# Issue #58：迟到缩出回执的相机交接

本轮从 GitHub 读取了 33 个独立开放问题及索引 #91。优先检查 [#58](https://github.com/luckyzifan/futureoxDesgin/issues/58) 的连续缩放交接。本文只记录其中一个可重复缺陷的源码修复，不关闭 #58，也不表示 #59、#60 或其余问题已解决。

## 冻结范围和原因

- 基线：`3cb3cb3a008e5851981b581d19e31a6fb70d8487`，开始时工作树干净。
- 原 `camera-reprojection.ts` SHA-256：`be18c3a82f4c57392d216e361d0056b60017d333c24fad88d82bc6e75751fa85`。
- 环境：本地 macOS / Darwin arm64，Bun 1.4.2、Vitest 5.0.1、jsdom；CPU isolated，GUI no。没有启动浏览器。
- 冻结断言：显示倍率 2，目标倍率 1，覆盖冷启动；依次收到 1.75、1.5、1.25 的位图时，只要它完整覆盖已显示视口，相机必须保持 2。倍率 1 的目标位图到达时正常切换。不能覆盖当前显示区域的位图不得沿用该相机。

生产 `CameraReprojection.update` 在无法覆盖目标缩出视口时保留画面。但换入迟到位图后，旧实现将显示相机直接设为该位图的捕获相机，导致每个中间回执都改变显示位置。新实现记录上一次实际发布的相机；相同窗口尺寸且 `NavigationBacking.coversPage` 证明新位图与历史覆盖足够时，继续使用该相机。覆盖不足时保留原回退。销毁时清除记录。

这不引入额外像素缓存、队列或预算，不改变源相机、采样、效果、持久化或导出。相机与已接收位图仍在同一次同步调用中发布。取消/版本身份仍由调用者既有边界控制；本轮没有增加其验收声明。

## 本轮执行结果

在 `frontend/design-client` 运行：

```sh
bun install --frozen-lockfile
bun run test --config camera-handoff.vitest.config.ts
git diff --check
```

依赖安装首次因镜像 502 失败；重试成功，锁文件未修改。

同一组测试替换为 Git 基线实现后，40 项中 39 通过、1 失败，失败明确为预期相机 2、实际相机 1.75。恢复候选后 4 个测试文件、40 项全部通过，无跳过。包括相机重投影、素材范围交接、原生导航身份/迟到回执、局部素材覆盖。`git diff --check` 通过。

初次尝试一并运行 `navigation-backing.test.ts` 时，该文件依赖的生成 WASM 绑定缺失，套件未能加载；其他 39 项通过。最终专用配置仅选择不依赖生成内核的四个套件，不把未加载套件计为通过。完整测试、类型检查、应用构建及真实素材 GPU/GUI 回放未执行。

候选 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `frontend/design-client/src/kernel/camera-reprojection.ts` | `4792a0bb8c41dba98cd81216ee5d651fb7a84d6afca94e842880f71e93518dcb` |
| `frontend/design-client/src/kernel/camera-reprojection.test.ts` | `5d607bf3978eb03dfd11683c929f9bff310233b5db6b4ff68cf44f5bb1bb621d` |
| `frontend/design-client/camera-handoff.vitest.config.ts` | `b81de4c51cfd668ab1bef1e9a45c79dbc54922f5a245210faf92049bcaa562be` |

## 尚缺的验收

G6 的定向旧失败/新通过已执行；只证明 DOM 相机交接条件。G2 真实连续滚轮、快速反向、停手再输入，G3 最终像素/撤销/保存，G4 硬件与端到端延迟，以及完整 G5/G7 均 NOT_RUN。必须使用拓扑完整源、模板二、主框架03及 FIG/test/117 回归后才能判断 #58 是否可关闭；33/100ms 目标未验收。

本增量通过独立分支和 PR 交付，不自动关闭远端 Issue。回滚仅撤销上述相机实现与新增测试/config；不涉及数据迁移。撤销前核对候选 hash，保留后续用户修改。
