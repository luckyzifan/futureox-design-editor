# 正式 release 包验收与组件清单

这是发布准备清单。没有在目标系统上打开并跑完正式安装包时，打开、导航、编辑、撤销、自动保存、关闭重开和原生导出都保持 `not_run`。`desktop-dev`、未签名开发包和只算出的哈希不能填这些格子，也不能把 `releaseAcceptance` 写成已关闭。这些缺口不是已确认的运行故障。

性能上的 5% 端到端时间门不适用于本清单。下面的数字是包身份和资源字节对照，不是画布耗时、绘制次数或内存收益。

## 桌面流程

```bash
node frontend/design-desktop/scripts/release-desktop-flow.mjs
```

可选环境变量：

- `FUTUREOX_RELEASE_PACKAGE`：安装包文件或未签名包目录。
- `FUTUREOX_RELEASE_RUNTIME`：用来对照的运行时目录，例如一次构建的 `dist`。不设置时，资源对照是 `not_run`。
- `FUTUREOX_RELEASE_ORIGINALS`：原设计文件路径，用平台路径分隔符分开。脚本只读打开两次并记录 SHA-256，不写入。这只证明检查器没有改文件，不证明应用会话没有改文件。

`.dmg`、`.pkg`、`.msi`、`.exe`、`.deb`、`.rpm`、`.AppImage` 只做文件哈希，不挂载、不启动。目录包会列出 `app.asar` 或未打包 `app/` 里的 JS/WASM、`sidecar/` 与 `bin/` 下的已知原生程序，以及 `design-mcp` 的脚本。每个步骤记录都带 `packageSha256`、`platform` 和 `arch`，但本脚本不把这些步骤标成已执行。

目录身份按路径、大小和内容 SHA-256 分段哈希。旧实现把路径文本和文件字节直接拼在一起，`a` + `bc` 与 `ab` + `c` 会得到同一个 SHA-256。单个安装包文件仍是内容 SHA-256。清单哈希和包内字节不一致，或和运行时字节不一致时，进程以失败退出；桌面步骤仍是 `not_run`，`confirmedRuntimeFault` 仍是 false。`profile` 为 `desktop-dev` 或 `debug` 时记为开发包。`release` profile 但没有签名检查的包也不是正式签名安装包。签名和公证保持 `not_run`。

## 组件清单

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs
```

脚本核对 `frontend/design-client/public/licenses/` 与 `inventory.json` 的哈希，列出 `design-mcp` 源文件和 Linux FFmpeg 的 SHA-256。`Cargo.lock` 里的 `name` 条目和 `package.json` 里的 Electron 版本只标成构建输入。没有 release 目录时，范围是 `packaging_inputs_not_a_release_bundle`。有目录时列出 JS/WASM/native 的安装路径和哈希，范围仍是 `release_directory_present_but_not_a_closed_sbom`，不是闭合的随包物料清单。

## 打包入口

`frontend/design-desktop/scripts/package.mjs` 在调用 packager 之前把 `resource-list.json` 写入 staging，因此它进入 `app.asar`。这份清单的 `formalRelease` 固定为 false，`signature` 固定为 `not_run`。`verify-package.mjs` 用包内字节复核清单。复核通过只说明这份未签名开发包的清单和字节一致，不是正式安装包的桌面流程验收。本云端环境没有运行完整的 Electron 打包器。

## 云端结果

2026-11-09，linux x64。本机没有 `frontend/design-desktop/release` 正式包，也没有启动 Electron 安装器。当时的桌面流程 12 步都是 `not_run`。组件清单里 10 条 UI notice 的哈希与 `inventory.json` 一致。Electron 版本记录为 44.7.0，Chromium 二进制没有被哈希。`Cargo.lock` 当时有 381 条 `name` 记录，脚本把它标成构建输入，不是随包清单。

2026-11-10，linux x64 云端虚拟机，源码基线 `ccaa2ea1a4a62aeff162fe4912e3920f99e529a2`。没有签名的 macOS 安装包，没有 Electron GUI，没有 Metal，没有挂载或启动安装器。5% 端到端性能门未使用。合成夹具只用于哈希和路径，不是用户设计文件，也不是截图像素。

同一对目录在旧哈希上碰撞，在新哈希上分开：

| 检查 | 基线 main | 本分支 |
| --- | --- | --- |
| `a`/`bc` 与 `ab`/`c` | 同一个 SHA-256 `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` | `d795c06922fdbd43cafe94a784dabde59ffa0b9da62f1937671f9d0b06732a71` 与 `88824a1d6ea685c2df1989ca1766e4abcefb18828d8240943e40542f8ca1b040` |
| `Futureox.dmg` 内容 `not-a-real-installer` | `024492aa19c1fc4afb8a39140f49117b491e7b8490fae0252754a4894ca3ca5e`，状态 `hashed_not_installed` | 同一 SHA-256，证据类 `unopened_installer`，资源 `not_inspected` |
| 5 个文件的 `desktop-dev` 目录 | 旧目录哈希 `72bca3fb3d059765289744381448f494d2b1fe3bd27f0b5679ae33e33a790107`，JS/WASM/native 条数为 0 | 目录哈希 `32b8851870b21ebd449509866494904bc72a95929584ca03f839d20911722d52`；JS 1、WASM 1、native 2 |
| 安装路径 | 无 | `app/src/main.mjs`、`app/renderer/kernel.wasm`、`bin/design-render`、`sidecar/futureox-design-desktop-backend` |
| 与运行时字节对照 | 无对照 | 4 条 `byte_match`；把 WASM 最后一字节从 `0x00` 改成 `0x01` 后为 1 条 `byte_mismatch`（包 `93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476`，运行时 `3f499bf4c9e7483e804244d5e485b3537b2135690a7ce7b3fd7cb2544217d729`） |
| 12 个桌面步骤 | 12 个 `not_run`，0 个带 `packageSha256` | 12 个仍是 `not_run`，12 个都带包 SHA-256 和 `linux/x64` |
| 原文件 `synthetic-readonly-bytes` | 报告不记录 SHA | 24 字节，SHA-256 `853b26a5146c2c4743746eb6e3b34ce05fdac295efeacaae32f7adcf350f8455`，两次读取相同；应用会话 `not_run` |
| 正式验收 | `not_closed` | `not_closed`，`formalRelease` false，签名 `not_run`，`confirmedRuntimeFault` false |

未设置包路径时，`node frontend/design-desktop/scripts/release-desktop-flow.mjs` 退出码 0：12 步都是 `not_run`，每步 `packageSha256` 为 null，`releaseAcceptance` 为 `not_closed`。`node frontend/design-desktop/scripts/release-component-inventory.mjs` 退出码 0：10/10 条 notice 与清单一致，Electron 44.7.0，Chromium 二进制未哈希，`Cargo.lock` 381 条 `name` 仍是构建输入，`design-mcp` 源文件 11 个，`packageResources` 为 `not_run`。正式安装后的打开、导航、编辑、撤销、自动保存、关闭重开和原生导出仍未执行。
