# 正式 release 包验收与组件清单

这是发布准备清单。没有在目标系统上打开并跑完正式安装包时，打开、导航、编辑、撤销、自动保存、关闭重开和原生导出都保持 `not_run`。`desktop-dev`、未签名开发包和只算出的哈希不能填这些格子，也不能把 `releaseAcceptance` 写成已关闭。这些缺口不是已确认的运行故障。

性能上的 5% 端到端时间门不适用于本清单。下面的数字是包身份和资源字节对照，不是画布耗时、绘制次数或内存收益。

## 桌面流程

准备清单只哈希和列资源，不启动应用。它把打开、导航、编辑、撤销、自动保存、关闭重开和原生导出保持为 `not_run`：

```bash
node frontend/design-desktop/scripts/release-desktop-flow.mjs
```

可选环境变量：

- `FUTUREOX_RELEASE_PACKAGE`：安装包文件或未签名包目录。
- `FUTUREOX_RELEASE_RUNTIME`：用来对照的运行时目录，例如一次构建的 `dist`。不设置时，资源对照是 `not_run`。
- `FUTUREOX_RELEASE_ORIGINALS`：原设计文件路径，用平台路径分隔符分开。脚本只读打开两次并记录 SHA-256，不写入。这只证明检查器没有改文件，不证明应用会话没有改文件。

要在已经构建并经过 `verify-package` 的 **release profile** 目录包上执行这些步骤，使用安装后的副本，而不是 `desktop-dev`、源码树或 `frontend/design-desktop/dist`：

```bash
node frontend/design-desktop/scripts/release-desktop-session.mjs \
  --package=/absolute/futureox-desgin-$platform-$arch \
  --verification=/absolute/package-verification.json
```

脚本会把目录包复制到独立安装前缀，从那份副本启动打包后的可执行文件，并用 `--core-cpu-only` 与 `FUTUREOX_ACCEPTANCE_PROFILE` 打开只读原设计文件。测量包括：沙箱窗口打开、进入画布、放大、修改文档名称且图层不变、撤销回原名称、等待「已自动保存」、关闭后用同一配置重开，以及通过正式「导出副本」菜单走原生保存。导出对话框是 Electron 的保存边界：第一次指向原文件必须被拒绝，第二次写入独立 `.fd`，再由包内 sidecar 打开核对。原文件在会话前后做 SHA-256，目录名单也必须不变。

`desktop-dev`、`debug`、源码目录和只哈希的 `.dmg`/`.pkg`/`.msi`/`.deb` 不会被启动。即使把测量塞进判定函数，这些包的步骤也不会变成 `passed`。`releaseAcceptance` 只有在全部步骤通过，并且当前主机的 codesign 与公证评估都成功时才是 `closed`。Linux 上签名检查保持 `not_run`，因此这里的 release 目录包最多是 `executed_unsigned_release`。

仍不能在本环境完成、必须保持未关闭的正式包步骤：

- 签名并公证的 macOS 包，以及 `codesign` / `spctl` 评估。
- Windows Authenticode。
- 挂载或安装 `.dmg`、`.pkg`、`.msi`、`.exe`、`.deb`、`.rpm`。目录复制不是这些安装器。

`.dmg`、`.pkg`、`.msi`、`.exe`、`.deb`、`.rpm`、`.AppImage` 在准备清单里只做文件哈希，不挂载、不启动。目录包会列出 `app.asar` 或未打包 `app/` 里的 JS/WASM、`sidecar/` 与 `bin/` 下的已知原生程序，以及 `design-mcp` 的脚本。每个步骤记录都带 `packageSha256`、`platform` 和 `arch`。准备清单不把这些步骤标成已执行。Linux/Windows 第一次启动时，绝对路径 `.fd` 参数会进入原生打开队列；macOS 仍只接受系统的 `open-file` 事件。验收配置目录不能是默认用户数据目录、家目录、符号链接或全局可写目录。

目录身份按路径、大小和内容 SHA-256 分段哈希。旧实现把路径文本和文件字节直接拼在一起，`a` + `bc` 与 `ab` + `c` 会得到同一个 SHA-256。单个安装包文件仍是内容 SHA-256。清单哈希和包内字节不一致，或和运行时字节不一致时，进程以失败退出；桌面步骤仍是 `not_run`，`confirmedRuntimeFault` 仍是 false。`profile` 为 `desktop-dev` 或 `debug` 时记为开发包。`release` profile 但没有签名检查的包也不是正式签名安装包。签名和公证保持 `not_run`。

## 组件清单

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs
```

脚本现在按打包输入生成组件清单，而不是把 `Cargo.lock` 的 `name` 条数当成随包清单。没有签名安装包时，`releaseAcceptance` 保持 `not_closed`。桌面流程脚本的行为不变：没有冻结安装包时，打开、编辑和导出步骤仍是 `not_run`。

清单区分这些东西：

- 四个会装进包里的 Rust 二进制的 `cargo tree --locked --edges normal`，以及 wasm32 的 kernel 图。`futureox-design-server`、`utoipa`、`sqlx-postgres` 和 dev-dependency `tiny-skia` 不在这个图里。
- 生产 JS 导入图和它的 lockfile 依赖。Vite、Lightning CSS、Playwright、`@electron/packager` 标成开发依赖。`electron` 这个 npm 包只是下载器。
- 会复制进 renderer 的字体和会打进 asar 的图标。
- Linux FFmpeg 可执行文件、notice 和对应源码包。macOS/Windows 目录仍是说明，没有二进制。
- 提供 `--electron-dist` 时，解压后的 Electron 发行目录里的每个文件。没有这个目录时，Chromium 二进制记为未哈希。

## 2026-11-13 Linux 目录包

这台 linux x64 云端机器不能签名或公证 macOS 包，也没有 Windows Authenticode。正式签名安装器仍是 `blocked` / `not_run`，`releaseAcceptance` 保持 `not_closed`。

同一提交上的 `package:local` 产出了 release profile 的 Electron 目录包，并通过 `verify-package --local`。验收脚本把该目录复制到独立安装前缀后启动，不是 `desktop-dev`，也不是源码树：

- 包 SHA-256：`255051480ce6f08410ee530f1ed4e499324070137e9e64e4ced814adbaad6766`（568 个文件；安装副本在会话前后哈希相同）
- 平台：linux / x64，profile `release`，`formalRelease` false，签名 `not_run`
- 运行时：Electron 44.7.0，Chromium 152.0.7977.130，打包进程 `isPackaged`，sandbox / contextIsolation / webSecurity 为真，nodeIntegration 为假
- 只读原件：仓库 `docs/branding/futureox-desgin.fd` 的副本，SHA-256 `19c5306e4eb304e20288eb13d6caba11be4e63dc6e24f0d084da93d82bdbf66d`，会话前后不变，目录名单不变
- 打开后的文档名是 `Futureox / original F-D brand icon`，3 个图层。画布缩放从 1 到 1.25。文档名改为带 `acceptance` 后缀后撤销回原名，图层键不变
- 自动保存状态为「已自动保存到工作副本」。关闭后用同一个验收配置重开，名称和图层键相同
- 原生导出先拒绝原件路径，再写出独立 `.fd`。包内 sidecar 打开该文件，魔数 `FXDK`，内容 SHA-256 与只读原件相同（撤销后的文档），路径不同
- `desktop-dev`、源码目录和未打开的安装器不能把这些步骤记成 `passed`。macOS 签名公证与 Windows Authenticode 仍是 `blocked`，磁盘镜像/系统安装器是 `not_run`

## 云端结果

2026-11-09，linux x64。当时的脚本没有枚举 release 文件。10 条 UI notice 与 `inventory.json` 一致。Electron 44.7.0 的 Chromium 二进制没有被哈希。`Cargo.lock` 有 381 条 `name` 记录，被标成构建输入。

2026-11-10，同一台 linux x64 云端，没有签名安装包，没有构建 native sidecar，也没有 Mac/Electron GUI 或 Metal。当前清单：

| 测量 | 2026-11-09 脚本 | 2026-11-10 清单 |
| --- | --- | --- |
| 能追到版本、来源、哈希和许可文本的第三方组件 | 10 条 UI notice，加上 1 个 Linux FFmpeg 二进制 | 286 |
| 其中 Rust 第三方 crate / 有许可文本 | 未按随包图拆开；381 条 lock 记录被排除在随包清单之外 | 263 / 253 |
| 不在四个打包二进制 normal 依赖图里的 lock 包 | 未计算 | 114 |
| 生产 JS 依赖有 notice | 上表的 UI notice，不含 quickjs-emscripten | 16 / 16 |
| 开发依赖，不计入随包 | 未单列 | 177 |
| 字体文件哈希与 notice 一致 | 未列入组件 | 16 |
| 图标文件追到仓库 MIT `LICENSE` | 未列入组件 | 16 |
| 解压后的 Electron 44.7.0 linux-x64 文件 | 0 | 72 |

Electron zip SHA-256 `3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a`，与 `electron` 44.7.0 npm 包里的 `checksums.json` 一致。`electron` 二进制 SHA-256 `10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564`。`LICENSE` SHA-256 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`。`LICENSES.chromium.html` SHA-256 `3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`。发行目录里的 `libffmpeg.so` SHA-256 `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`，与仓库里的 GPL FFmpeg `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317` 不是同一个文件。

这组哈希来自官方 Electron zip 的解压目录，不是 Futureox 签名安装包。macOS 和 Windows 的 Electron zip 没有下载。十个 crate 的发布包里没有许可文本：`profiling` 1.0.18、`spirv` 0.4.0+sdk-1.4.341.0，以及 macOS 的 `objc2` / `block2` 系列。`public/color-fixtures/` 的三张图没有来源记录。正式签名包、公证和 native GUI 仍然是 `not_run`。

## 随包资源标识（#264）

打包入口在 staging 内写入 `resource-list.json`，`verify-package.mjs` 核对包内实际字节。组件清单的 `packageResources` 同时记录 JS/WASM/native 的路径和hash。`formalRelease` 仍为 false，签名仍为 `not_run`；目录哈希、资源列表和已安装应用会话属于不同的证据。
