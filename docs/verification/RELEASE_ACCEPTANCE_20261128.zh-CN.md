# 2026-11-28 已发布 0.0.0.1 桌面包验收复核

本记录覆盖 #84、#85、#86、#88。所有命令都在隔离 worktree `/tmp/fx-fixall-20261128/release`（分支 `codex/fixall-release-20261128`，基线 `128b29743`）中执行。主工作树只作为已发布 `0.0.0.1` 安装包的只读来源；没有在主树构建、写入或运行测试。

本轮受并发 GUI 性能测量限制，没有启动 Electron 窗口，也没有启动任何外部 AI 客户端会话。GUI 项按 `NOT_RUN` / `BLOCKED` 记录，并给出可复跑命令和门槛。这里没有把开发目录、`tools/list`、只算哈希或模拟故障当成正式安装包验收。

## 结论

| Issue | 验收范围 | 状态 | 证据 |
| --- | --- | --- | --- |
| #84 | 打包后的 stdio/HTTP 适配器路径 | **partial**：同目标未签名包 `PASS`；实际 0.0.0.1 包的外部客户端会话 `NOT_RUN` | `REL84-PKG-STDIO`、`REL84-PKG-FIGMA`、`REL84-CLIENT-MATRIX` |
| #85 | 正式 release 包的完整桌面流程 | **partial / blocked**：包身份与资源已记录；Linux x64 deb 有 2026-11-23 的实际包 GUI 记录（本轮未重跑）；macOS arm64 DMG GUI `NOT_RUN`；签名/公证未闭合 | `REL85-PKG-ID`、`REL85-PREP`、`REL85-GUI` |
| #86 | 保存中退出、写入失败、重开恢复、升级迁移 | **verified（headless）**：20/20 模拟故障通过；实际 0.0.0.1 包内 sidecar 的 SIGKILL 保存中退出 `PASS`；GUI 故障注入 `NOT_RUN` | `REL86-SIM`、`REL86-PKG-CRASH`、`REL86-GUI` |
| #88 | 按实际 release 包生成组件与 notice 清单 | **partial / FAIL（当前 0.0.0.1 包）**：清单已按包内字节生成；两个实际包都有阻断性许可/归属缺口；当前源码输入已补齐，但没有新构建的包可验 | `REL88-DMG-AUDIT`、`REL88-DEB-AUDIT`、`REL88-SRC-INPUTS` |

`releaseAcceptance` 在所有报告中保持 `not_closed`。这不是已确认运行时故障：`confirmedRuntimeFault` 均为 `false`。

## 身份与来源

| 项 | 值 |
| --- | --- |
| 主机 | macOS arm64（Darwin 25.3.0），Node v24.12.0，rustc 1.99.1，Electron 44.7.0 |
| 复核源码 | `128b29743`（本 worktree，仅有本轮证据文档改动） |
| 已发布版本 | `0.0.0.1`，发布源提交 `58f0d7542fb7e7bfcc4ab48fecf82b96727b7ea0`，Git tree `a2af8a70e5d79725a77318b8f6266846498c93e1` |
| macOS 包 | `futureox-design-0.0.0.1-macos-arm64.dmg`，254,910,636 字节，SHA-256 `730207741e9edcfa73716d1a04c327423414d37afffeaf06001864fa0ecb5aec` |
| Linux 包 | `futureox-design-0.0.0.1-linux-x64.deb`，208,568,564 字节，SHA-256 `092798551707d6c4016127afcded7404a37ada975a06262ae3b93a0877ff300c` |
| macOS 包目录身份 | `76227d1ead2b50368f5356bd76371d2c4dd17ab9a101a08583e5c57d711c8b72`，747 个普通文件 |
| Linux 包目录身份 | `7482de5c607a93ee6d92953b15421ae71ae608035615a309ee86444f4c1867d5`，568 个普通文件 |
| 发布记录 | `frontend/design-desktop/release/0.0.0.1/release-verification.json`，SHA-256 `fd7194488d35c53e7cc9911904b3ea2395dedc486e2041ba7bc0c7e572127c3e` |
| macOS 签名 | 发布记录为 `ad_hoc_validated`，`notarization: not_run`。本轮复核脚本没有重新验证签名，记为 `not_run` |
| Windows 包 | 发布记录列出 `futureox-design-0.0.0.1-windows-x64.zip`，但本机 release 目录没有该文件，记为 `not_built` / 缺环境 |

DMG 的源提交核对方法：`git cat-file -t 58f0d7542` 存在，`git rev-parse 58f0d7542^{tree}` 等于 `a2af8a70e5d79725a77318b8f6266846498c93e1`；再用 `git clone --shared --no-checkout` 取同一提交的干净检出作为清单的 `--source-root`。没有改动主工作树。

```bash
git clone --shared --no-checkout /tmp/fx-fixall-20261128/release /tmp/fx-fixall-20261128/release-src-0.0.0.1
git -C /tmp/fx-fixall-20261128/release-src-0.0.0.1 checkout --detach 58f0d7542fb7e7bfcc4ab48fecf82b96727b7ea0
```

macOS 包以只读方式挂载。挂载点目录名必须以 `darwin-arm64` 结尾，组件清单用目录名推导 host triple：

```bash
mkdir -p /tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64
hdiutil attach -readonly -nobrowse -noautoopen \
  -mountpoint /tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64 \
  /Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-macos-arm64.dmg
```

Linux deb 用 `ar` + `tar` 解到独立目录，不做系统安装，也不启动 GUI：

```bash
mkdir -p /tmp/fx-fixall-20261128/release-deb-0.0.0.1/linux-pkg/futureox-desgin-linux-x64
cd /tmp/fx-fixall-20261128/release-deb-0.0.0.1/linux-pkg/futureox-desgin-linux-x64
ar p /Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-linux-x64.deb data.tar.xz \
  | tar -xJ --strip-components=3 -f - './opt/futureox-desgin'
```

## REL84：打包 MCP 路径与外部客户端

### REL84-PKG-STDIO / REL84-PKG-FIGMA：PASS（同目标未签名包）

命令与结果：

```bash
cd frontend/design-desktop
node --test test/packaged-mcp-path.test.mjs
# exit 0；1 pass，0 fail，0 skip；19.9 s

node scripts/verify-packaged-mcp-path.mjs
# exit 0；报告 12 个步骤全部 passed
```

报告要点：

- `electron` 44.7.0，`sameTarget: true`，`bundleKind: unsigned_packager_output`，`platform: darwin` / `arm64`。
- `launchedThroughSymlink: true`、`envReplaced: true`、`devDirectoryCli: false`、`toolsListAlone: false`。启动的是包内的 Electron 可执行文件和包内 `resources/design-mcp/src/cli.mjs`、`figma-cli.mjs`，不是开发目录的 `node`。
- `cli.mjs`：handshake、read、edit、screenshot、undo、`revoke_rejects_old_resource` 全部 `passed`。
- `figma-cli.mjs`：handshake、read、edit、screenshot、`revoke_rejects_old_resource` 全部 `passed`；它没有 `history.undo` 工具，撤销由同一桥接里的 `cli.mjs` 完成，报告把该步记为 `cli.mjs-after-figma-edit`。
- `cliSha256` 为 `3eecb2294be89a776000de6cbed0cde2045644cacc9eddf38c059d365e41f7d3`，与当前源码相同。
- 这份报告明确 `externalClientAcceptance: false`、`editorGui: not_run`、`signedInstaller: not_run`。它是同目标打包路径的探针，不是外部 AI 客户端实机，也不是正式安装包。

### REL84-CLIENT-MATRIX：未执行外部客户端

`node scripts/mcp-client-acceptance.mjs` 退出 0。把 `FUTUREOX_RELEASE_EXECUTABLE` 指向 DMG 内可执行文件后再跑一次，脚本只记录 `path_supplied_not_launched`，不启动安装器或客户端：

```bash
FUTUREOX_RELEASE_EXECUTABLE=/tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64/futureox-desgin.app/Contents/MacOS/futureox-desgin \
  node frontend/design-desktop/scripts/mcp-client-acceptance.mjs
# exit 0
```

| 客户端 | 探测状态 | 安装包上的六步会话 |
| --- | --- | --- |
| Claude Code | `present_not_exercised` | `NOT_RUN` |
| Codex | `missing_environment`（不在 PATH） | `NOT_RUN` |
| Kimi Code CLI | `present_not_exercised` | `NOT_RUN` |
| Kimi CLI 1.x | `present_not_exercised` | `NOT_RUN` |
| DeepSeek Harness | `missing_environment`（不在 PATH） | `NOT_RUN` |

六步为 handshake、read、edit、screenshot、undo、停用后旧资源被拒绝；`mcp-client-acceptance.mjs` 对每项都写 `not_run`、`scope: external_client`。仓库探针不能给出 `passed` 客户端状态。

实际 0.0.0.1 包的适配器字节与当前源码不同：包内 `design-mcp/src/cli.mjs` SHA-256 为 `d5fe76c5d5fe4105eee04f316b09e06a0a9522ce9bbcb7a4afcc17f1b6c7a75e`，`figma-cli.mjs` 为 `0c628d3d553dd740604b5f878162bc9c82b3f695cbf3379a7b01cd6424a3aa77`；当前源码分别为 `3eecb229...` 和 `c9f98e56...`。包内 `figma-mcp-host.mjs` 的 `desktopMcpClientConfig(connection, cli, executable)` 参数形态也与当前 `desktopMcpClientConfig(connection, { resourcesPath, executable, format })` 不同。因此当前探针不能直接套到这份旧包上；外部客户端验收必须在安装后的包上按包内自带配置重做，或先用当前源码重建正式包。

契约测试：

```bash
node --test frontend/design-desktop/test/autosave-recovery-acceptance.test.mjs \
  frontend/design-desktop/test/release-acceptance.test.mjs \
  frontend/design-desktop/test/external-mcp-live.test.mjs
# exit 0；35 pass，1 skip（跳过项只在提供解压后的 Electron 发行目录时才哈希 Chromium）
```

### REL84-CLIENT-LIVE：BLOCKED

`test/packaged-local-mcp.mjs` 需要启动打包后的 Electron 窗口，并从原生菜单启用 MCP、读取用户数据目录、运行 Claude Code/Kimi CLI 的实机传输。本轮另一个 campaign 正在做真实 GUI perf 测量，并发 GUI 会互相污染，因此没有运行。可复跑命令：

```bash
node frontend/design-desktop/test/packaged-local-mcp.mjs \
  /absolute/installed/futureox-desgin.app/Contents/MacOS/futureox-desgin \
  --live-clients --clients
```

门槛：每个客户端必须在安装后的包上完成六步；`claude mcp get` 只能证明握手，不能代替 read/edit/screenshot/undo。命令会打开可见窗口，必须在没有并发 GUI 测量的机器上执行。`packaged-local-mcp.mjs` 自己仍写 `externalClientAcceptance: false`。

## REL85：正式包桌面流程

### REL85-PKG-ID / REL85-PREP：记录完成，GUI 未运行

DMG 只做哈希和身份记录，不挂载、不安装：

```bash
FUTUREOX_RELEASE_PACKAGE=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-macos-arm64.dmg \
  node frontend/design-desktop/scripts/release-desktop-flow.mjs
# exit 0；package.status=hashed_not_installed；sha256=730207741e9edc...；12 个步骤全部 not_run
```

已挂载目录再做一次资源清单和原件双读：

```bash
FUTUREOX_RELEASE_PACKAGE=/tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64 \
FUTUREOX_RELEASE_ORIGINALS=/tmp/fx-fixall-20261128/release/docs/branding/futureox-desgin.fd \
  node frontend/design-desktop/scripts/release-desktop-flow.mjs
# exit 1；resources 列出 747 个文件；js=101，wasm=6，native=4
```

这次退出 1 的原因不是资源哈希损坏，而是声明资源表与当前审计器的预期不一致：`bin/futureox-sketch-font-outlines` 在发布记录和包内都不存在，但当前 `expectedNativeInstallPaths('darwin')` 把它列为 darwin 必需。它是 2026-11-12 之后新增的 native 组件，0.0.0.1 包早于它。报告把 `failed` 记为 true，`releaseAcceptance` 仍为 `not_closed`。

`docs/branding/futureox-desgin.fd` 的 SHA-256 在脚本前后都是 `19c5306e4eb304e20288eb13d6caba11be4e63dc6e24f0d084da93d82bdbf66d`，大小 2063 字节不变。`originals.status: script_readonly`，`appSession: not_run`：这只证明检查器没有写文件，不证明应用会话没有写文件。

包内 `app.asar` SHA-256 `14e71949269184e4ae92422062e2301bd66f06523ffa6773da3b2bd7ae8b4555` 和 kernel WASM `4b4535f0b382f9fe9d35ceb51cf34be94511b32008e6f0a3e89cc51842b6d371` 与发布记录一致；sidecar `730a40595465b144d581405a0df06a57259d9699c99c7d928bcd407e22450ee0`、`bin/design-render` `d50cf08d...`、`bin/design-prepare` `aac22a70...`、`bin/futureox-design-agent` `3cd7d575...` 也一致。

### REL85-GUI：BLOCKED（macOS DMG）

同一台机器无法在不启动 GUI 的情况下记录打开、导航、编辑、撤销、自动保存、关闭重开和原生导出。`release-desktop-session.mjs` 会复制 DMG、启动打包后的应用并通过原生菜单导出，本轮没有运行。可复跑命令：

```bash
node frontend/design-desktop/scripts/release-desktop-session.mjs \
  --package=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-macos-arm64.dmg \
  --verification=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/release-verification.json \
  --output=/absolute/empty-directory
```

门槛：打开、导航、编辑、撤销、自动保存、关闭重开、原生导出、原件 SHA 不变、安装前后包身份、开发包/正式包区分全部通过；并且 `codesign` 与公证评估都成功，`releaseAcceptance` 才是 `closed`。这份包 `appSigning` 是 `ad_hoc_validated`、`notarization` 是 `not_run`，即使 GUI 全过也只能到 `executed_unsigned_release` 一类结果，不能写成正式签名包已验收。窗口必须加 `--core-cpu-only`，硬件 GPU 项保持 `NOT_RUN`。

### Linux x64 deb 的既有 GUI 记录

仓库 2026-11-23 的记录已经用同一份 `0.0.0.1` linux deb（SHA-256 `09279855...`）跑过完整桌面流程：`executed_unsigned_release`，打开、缩放、改名、撤销、自动保存、关闭重开、原生导出和原件不变均通过，签名与公证是 `blocked`。本轮没有重跑该 GUI 会话，只把它作为 Linux 平台的既有证据引用；它不能代替 macOS DMG，也不能把 `releaseAcceptance` 写成 `closed`。详见 [正式 release 包验收与组件清单](../RELEASE_PACKAGE_ACCEPTANCE.zh-CN.md) 的「已发布的 v0.0.0.1 linux deb」一节。

## REL86：自动保存异常退出与存储失败

### REL86-SIM：PASS（模拟后端）

```bash
cd frontend/design-desktop
CARGO_TARGET_DIR=/tmp/fx-fixall-20261128/target-release \
  node scripts/accept-autosave-recovery.mjs \
  --packaged-sidecar=/tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64/futureox-desgin.app/Contents/Resources/sidecar/futureox-design-desktop-backend \
  --installer=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-macos-arm64.dmg \
  --verification=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/release-verification.json
# exit 0
```

报告字段：`cargo.status: 0`，`missingTests: []`，`EXPECTED_RECOVERY_TESTS` 的 20 项全部执行。`Rust` 先在隔离 target 目录首次编译 24m47s，随后测试运行约 2m20s。

| 故障组 | 状态 | 覆盖的断言 |
| --- | --- | --- |
| `exit_during_save` | passed | 未提交退出、journal 中断、synced journal 下一版本、SIGKILL、同毫秒 temp、未发布崩溃副本 |
| `storage_full_or_write_failure` | passed | 存储满、SQLite 存储满、SQLite 只读、只读目录、源文件写入被拒、checkpoint 刷新失败、只读 + 残留 temp |
| `reopen_last_consistent_version` | passed | 拒绝保存后的 recovery_read、事务中断和 SIGKILL 后重开、synced temp、过期 temp 不回滚已发布版本、第二次副本分配失败 |
| `upgrade_migration` | passed | 升级失败保留旧 schema 后重试、无 sequence 的 legacy record 升级并恢复、legacy synced temp 仍按时间戳接收 |
| `original_import_unchanged` | passed | 只读保存、synced recovery temp、recovery_write 都不改导入字节 |

CAS/原子性/失败提示由 `autosave_recovery_conflict_is_not_reported_saved`、`autosave_recovery_stale_temp_with_newer_clock_does_not_roll_back_published`、`autosave_recovery_unpublished_crash_copy_is_discarded`、`autosave_recovery_interrupted_journal_next_is_not_saved` 等用例覆盖。`node --test test/autosave-recovery-acceptance.test.mjs` 另跑 9 项契约测试，全部通过（exit 0）。

### REL86-PKG-CRASH：PASS（实际 0.0.0.1 包内 sidecar）

同一命令里的 `packaged_exit_during_save` 状态是 `passed`。它启动的是 DMG 内真实的 `sidecar/futureox-design-desktop-backend`（SHA-256 `730a40595465b144d581405a0df06a57259d9699c99c7d928bcd407e22450ee0`，与发布记录一致），先用外部 SQLite writer 持有下一笔保存，再向 sidecar 发送 `workspace.commit`，300 ms 后 `SIGKILL`，然后用同一个二进制重开并读取最后一次已提交版本。报告身份为版本 `0.0.0.1`、源提交 `58f0d7542...`、平台 `darwin-arm64`、安装包 SHA-256 `73020774...`。

这是发布包内 sidecar 的进程级证据，不是 Electron GUI 的自动保存按钮、失败提示或真实系统磁盘满。

### REL86-GUI：NOT_RUN

以下场景只有 GUI/系统级注入能覆盖，本轮没有执行：

- 在真实 Electron 会话中点击保存后立刻退出应用，再重开核对状态文字和最后一致版本；
- 把应用数据卷或工作副本所在卷灌满，观察 UI 是否明确显示失败而不是「已保存」；
- 用旧版本应用打开新版本工作区，或反向升级，核对迁移失败保留旧 schema 的提示；
- 核对失败提示不遮挡、不丢失、不把原件写坏。

`release-desktop-session.mjs` 可以覆盖正常自动保存与关闭重开，但不能注入磁盘满或保存中退出；上述场景需要在干净机器上人工或用外部工具注入。GUI 会话命令同 `REL85-GUI`。

## REL88：实际包组件与 notice 清单

### REL88-DMG-AUDIT / REL88-DEB-AUDIT：FAIL（当前 0.0.0.1 包）

命令（macOS）：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --source-root=/tmp/fx-fixall-20261128/release-src-0.0.0.1 \
  --release-dir=/tmp/fx-fixall-20261128/release-mnt/futureox-desgin-darwin-arm64 \
  --release-verification=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/release-verification.json \
  --installer=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-macos-arm64.dmg \
  --require-package \
  --write-report=/tmp/fx-fixall-20261128/release-inventory-0.0.0.1.json
# exit 1；packageProblems: 39 个阻断性缺口 + Electron notice 数为 0
```

命令（Linux deb，先按上面的 `ar` + `tar` 解包）：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --source-root=/tmp/fx-fixall-20261128/release-src-0.0.0.1 \
  --release-dir=/tmp/fx-fixall-20261128/release-deb-0.0.0.1/linux-pkg/futureox-desgin-linux-x64 \
  --release-verification=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/release-verification.json \
  --installer=/Users/Apple/project/design-kernel/frontend/design-desktop/release/0.0.0.1/futureox-design-0.0.0.1-linux-x64.deb \
  --require-package \
  --write-report=/tmp/fx-fixall-20261128/release-inventory-linux-0.0.0.1.json
# exit 1；packageProblems: 29 个阻断性缺口
```

两次 `--require-package` 都成功按包内字节重算并核对了 `app.asar`、kernel WASM、sidecar/native 和安装包 SHA-256；失败来自清单完整性，不是哈希不符。发布记录里的 `packageContents: passed` 只覆盖包内 JS/WASM/native 与声明资源表，不覆盖 Electron 归属文本、项目 LICENSE、图标来源、color fixture 来源或验证页许可。

配套契约测试：

```bash
node --test scripts/opensource-prep.test.mjs
# exit 0；6 pass，0 fail，0 skip
node --test frontend/design-desktop/test/notice-runtime-versions.test.mjs
# exit 0；1 pass，0 fail，0 skip
```

| 测量 | macOS arm64 DMG | Linux x64 deb |
| --- | --- | --- |
| 包内普通文件 / 含 asar 条目 | 747 / 965 | 568 / 786 |
| 可追溯第三方组件 | 291 | 291 |
| 组件行（含项目自有） | 297 | 293 |
| Electron 44.7.0 运行时文件 / 归属 notice | 263 / **0** | 71 / 2 |
| 生产 JS 包 / 有 notice | 16 / 16 | 16 / 16 |
| JS 开发依赖（不入包） | 204，泄漏 0 | 204，泄漏 0 |
| 分发 Rust crate / 有包内 notice | 227 / 218 | 223 / 221 |
| 仅编译期 crate（notice 在包内） | 13 | 13 |
| 不在本包图里的 lock 名 | 102 | 106 |
| 字体 / 图标可追溯 | 23 / 23，**0 / 17** | 23 / 23，**0 / 16** |
| color-fixtures 可追溯 | **0 / 3** | **0 / 3** |
| native / WASM | 4 / 6 | 4 / 6 |
| 阻断性缺口 / 全部缺口 | **39 / 42** | **29 / 32** |

实际缺口（两个包共同的根因是 2026-11-12 的发布源早于 11-13～11-14 的 notice/打包修复）：

- macOS：没有 `Contents/Resources/electron-runtime-notices/{LICENSE,LICENSES.chromium.html,version}`，Electron 归属文本为 0；缺少项目 `project-license/LICENSE`，4 个 native、17 个图标和 2 个 WASM 无法追溯项目许可；9 个 Rust crate 在包内没有许可文本：`block2@0.6.2`、`objc2@0.6.5`、`objc2-core-foundation@0.3.2`、`objc2-core-graphics@0.3.2`、`objc2-encode@4.1.0`、`objc2-foundation@0.3.2`、`objc2-metal@0.3.2`、`objc2-quartz-core@0.3.2`、`profiling@1.0.18`；3 个 color fixture 没有来源记录；`canvas-chrome-verify.html` 与 `sdf-shadow-verify.html` 两个验证页仍在包内且没有许可；`Applications` 符号链接被审计器记为未分类项。
- Linux：Electron 的 `LICENSE` 和 `LICENSES.chromium.html` 在包内，FFmpeg 7.0.2 可追溯；但同样缺少项目 LICENSE，4 个 native、16 个图标、2 个 WASM 无法追溯；`profiling@1.0.18`、`spirv@0.4.0+sdk-1.4.341.0` 没有许可文本；3 个 color fixture 和 2 个验证页同上。

### REL88-SRC-INPUTS：当前源码输入已补齐

对当前 `128b29743` 源码的打包输入（没有 release 目录）再跑一次清单，退出 0：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --write-report=/tmp/fx-fixall-20261128/current-source-inventory.json
# exit 0；producedFrom=packaging_inputs
```

| 测量 | 当前源码输入 |
| --- | --- |
| 分发 Rust crate / 有 notice | 278 / 278 |
| 生产 JS / 有 notice | 16 / 16 |
| 字体 / 图标可追溯 | 21 / 21，16 / 16 |
| 剩余缺口 | 6：4 个 native 未构建、正式签名包未提供、Chromium 二进制不在源码树 |

这说明 `objc2`/`block2`/`profiling`/`spirv` 的 notice、项目 LICENSE 和图标来源已经在源码里补齐；但没有重新构建并验证一个新的正式/未签名 release 包，因此不能把 0.0.0.1 的缺口说成已修复。

### 清单产物

按实际包内字节生成的完整组件行、Electron 运行时文件表和缺口表已提交：

- [release-component-inventory-0.0.0.1-darwin-arm64.json](../publication/release-component-inventory-0.0.0.1-darwin-arm64.json)：297 个组件、263 个 Electron 运行时文件、42 个缺口。
- [release-component-inventory-0.0.0.1-linux-x64.json](../publication/release-component-inventory-0.0.0.1-linux-x64.json)：293 个组件、71 个 Electron 运行时文件、32 个缺口。

每个组件行包含 `kind`、`id`、`version`、`license`、`source`、包内路径、SHA-256、分发类别、是否可追溯、对应 notice 路径与 SHA-256、缺口原因。开发依赖与分发依赖分开：`notDistribution.javascriptDevelopmentOnly` 和 `notDistribution.notInThisPackage` 保留在 JSON 中。完整报告（含每个包内文件的哈希和逐文件 census）不提交，按上面的 `--write-report` 命令重新生成。

### 复跑命令的差异说明

`release-component-inventory.mjs` 的 `--release-dir` 对 macOS 既接受挂载卷根目录（内含唯一 `.app`），也接受 `.app` 本身；但目录名必须含 `darwin-arm64`，否则 host triple 无法绑定发布记录。Linux 解包目录名必须含 `linux-x64`。本轮挂载点/解包目录名按此命名。若在 Linux 上重跑 macOS 清单，`cargo tree` 需要能解析 `aarch64-apple-darwin` 目标；本轮在 macOS 上执行，四个目标都由同一份 `Cargo.lock` 解析。

## 产物、退出码与哈希

| 产物 | 路径 | 退出码 | SHA-256 |
| --- | --- | --- | --- |
| 打包 MCP 探针报告 | `/tmp/fx-fixall-20261128/release-mcp-probe.json` | 0 | `bfa752774c3020496830e93988c89b396b954f90e55acb114687e1aaf1dc32b9` |
| 客户端可用性（含包路径） | `/tmp/fx-fixall-20261128/release-mcp-clients-packaged.json` | 0 | `001049b6bb19bcd7d13b4462fa229d2dc4cbe3b8cfea3f178377187a358accc0` |
| DMG 流程准备 | `/tmp/fx-fixall-20261128/release-desktop-flow.json` | 0 | `7dc5b696d0e79357e403aa99a20ad37cb702f9cfade845ef5476912280e64fcb` |
| 目录包流程准备 | `/tmp/fx-fixall-20261128/release-desktop-flow-dir.json` | 1 | `3edb07ea936142d133594d81ef1a023309fb99d2c5aac427a07965e146748227` |
| 自动保存验收报告 | `/tmp/fx-fixall-20261128/release-autosave-report.json` | 0 | `ac1bde22e6164364192552eb3f630e6b936bbd60247af61109692cff8b59a8c7` |
| macOS 完整组件报告 | `/tmp/fx-fixall-20261128/release-inventory-0.0.0.1.json` | 1 | `c0535fd7a4160f49a33ae471a5ee8b4c0f0526ba453f528724222d623d77ffec` |
| Linux 完整组件报告 | `/tmp/fx-fixall-20261128/release-inventory-linux-0.0.0.1.json` | 1 | `bc11395b98207bf4b980bd5e43c9d751216874cfda8ebe0e1dfd3c469cb96dc7` |
| 当前源码输入清单 | `/tmp/fx-fixall-20261128/current-source-inventory.json` | 0 | `e1e6b2ccb9be74ec5d6395b603afa233c52ddd205e65f0b5878b1bc7ec1f7052` |
| macOS 组件清单（提交） | `docs/publication/release-component-inventory-0.0.0.1-darwin-arm64.json` | — | `9c7eb1ab39bb0658ed269c18d453479716dc9bed861c2446c13bd70325635644` |
| Linux 组件清单（提交） | `docs/publication/release-component-inventory-0.0.0.1-linux-x64.json` | — | `2349c96a42c0a7d671ae1f42c1edaf1ec93b67fdd38b9b23b8ccec3b86288a90` |

## 仍缺的验收

| 项 | 状态 | 原因 / 门槛 |
| --- | --- | --- |
| macOS DMG 打开、导航、编辑、撤销、自动保存、关闭重开、原生导出 | BLOCKED | 并发 GUI perf 测量；见 `REL85-GUI` 命令 |
| macOS DMG 签名与公证 | NOT_RUN | 发布记录 `ad_hoc_validated` / `notarization: not_run`；需要 Developer ID 与公证环境 |
| 外部 AI 客户端（Claude Code、Codex、Kimi Code CLI、Kimi CLI 1.x、DSH）在安装包上的六步 | NOT_RUN / 缺环境 | 需要可见 GUI 和真实客户端；Codex、DSH 本机未安装 |
| 实际 0.0.0.1 包适配器的外部客户端会话 | NOT_RUN | 包内适配器字节早于当前源码；需在安装后的包上重做，或用新构建包 |
| GUI 自动保存保存中退出、磁盘满、失败提示、升级迁移 | NOT_RUN | 需要 GUI 和系统级故障注入；headless 只覆盖后端/SQLite/sidecar |
| Windows 包 | NOT_BUILT | 本机 release 目录没有 `futureox-design-0.0.0.1-windows-x64.zip` |
| 用当前源码重建 release 包并复跑 #88 | NOT_RUN | 本轮没有做重构建；当前源码输入清单显示 notice 已补齐，但必须由新包字节证明 |

这些缺口都不是已确认运行时故障；`confirmedRuntimeFault` 保持 `false`。在对应真实安装包、平台和证据齐备前，`releaseAcceptance` 不能写成 `closed`。