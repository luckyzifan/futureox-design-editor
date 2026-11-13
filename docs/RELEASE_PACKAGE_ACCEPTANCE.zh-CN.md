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

`desktop-dev`、`debug`、源码目录和只哈希的 `.dmg`/`.pkg`/`.msi`/`.deb` 不会被启动。即使把测量塞进判定函数，这些包的步骤也不会变成 `passed`。`releaseAcceptance` 只有在全部步骤通过，并且当前主机的 codesign 与公证评估都成功时才是 `closed`。Linux 上签名检查保持 `not_run`，因此 release 目录包和未签名 `.deb` 最多是 `executed_unsigned_release`。

已经发布的 linux `.deb` 可以在这台机器上用 `dpkg --root` 装进独立根目录，再从安装出来的可执行文件跑同一套步骤。只算出哈希仍然不会启动。命令是：

```bash
node frontend/design-desktop/scripts/release-desktop-session.mjs \
  --package=/absolute/futureox-design-linux-x64.deb \
  --verification=/absolute/release-verification.json
```

这个包若没有 `--desktop-acceptance-profile`，脚本会把 `HOME` 和 `XDG_CONFIG_HOME` 指到验收目录，并先写入「打开原默认工作区」会留下的选择记录，再从「打开设计文件」进入。有验收配置钩子的包仍走原来的配置目录，不用这份私有家目录。`.dmg`、`.pkg`、`.msi`、`.exe`、`.rpm` 仍然不挂载。

仍不能在本环境完成、必须保持未关闭的正式包步骤：

- 签名并公证的 macOS 包，以及 `codesign` / `spctl` 评估。
- Windows Authenticode。
- 挂载或安装 `.dmg`、`.pkg`、`.msi`、`.exe`、`.rpm`。目录复制不是这些安装器。linux `.deb` 用 `dpkg --root` 安装并启动后，安装器记录是 `linux_deb_installed`，不是全部安装器通过。

`.dmg`、`.pkg`、`.msi`、`.exe`、`.deb`、`.rpm`、`.AppImage` 在准备清单里只做文件哈希，不挂载、不启动。linux `.deb` 的安装和启动属于上面的会话脚本，不属于准备清单。目录包会列出 `app.asar` 或未打包 `app/` 里的 JS/WASM、`sidecar/` 与 `bin/` 下的已知原生程序，以及 `design-mcp` 的脚本。每个步骤记录都带 `packageSha256`、`platform` 和 `arch`。准备清单不把这些步骤标成已执行。Linux/Windows 第一次启动时，绝对路径 `.fd` 参数会进入原生打开队列；macOS 仍只接受系统的 `open-file` 事件。验收配置目录不能是默认用户数据目录、家目录、符号链接或全局可写目录。

目录身份按路径、大小和内容 SHA-256 分段哈希。旧实现把路径文本和文件字节直接拼在一起，`a` + `bc` 与 `ab` + `c` 会得到同一个 SHA-256。单个安装包文件仍是内容 SHA-256。清单哈希和包内字节不一致，或和运行时字节不一致时，进程以失败退出；桌面步骤仍是 `not_run`，`confirmedRuntimeFault` 仍是 false。`profile` 为 `desktop-dev` 或 `debug` 时记为开发包。`release` profile 但没有签名检查的包也不是正式签名安装包。签名和公证保持 `not_run`。

## 组件清单

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs
```

没有签名安装包时，脚本仍按打包输入生成对照清单，`releaseAcceptance` 保持 `not_closed`。桌面流程脚本的行为不变：没有冻结安装包时，打开、编辑和导出步骤仍是 `not_run`。

把 Electron packager 打出的目录传进去时，分发清单改从该目录的文件字节生成，而不是从 `Cargo.lock` 的 `name` 条数生成：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --release-dir=frontend/design-desktop/release/futureox-desgin-linux-x64 \
  --require-package \
  --write-report=/tmp/futureox-release-inventory.json
```

`--require-package` 会重新哈希包内文件和 `app.asar` 条目。哈希对不上、或者 Electron/Chromium、JS、Rust notice、native、WASM、字体、图标、Linux FFmpeg 任一缺失时，进程失败。`Cargo.lock` 和 npm devDependencies 只用来给已经出现在包里的文件或已链接进包内二进制的 crate 补版本、来源和许可证；没进这个包的 lock 名和 Vite、Playwright、`@electron/packager` 留在 `notDistribution`。签名、公证和其他操作系统安装包保持 `not_run` / `not_built`，`releaseAcceptance` 仍是 `not_closed`。

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

## 2026-11-13 未签名 Linux release 目录

云端 linux x64 跑了仓库自己的 `node scripts/build.mjs`（profile `release`）和 `node scripts/package.mjs`。产物是 packager 目录 `frontend/design-desktop/release/futureox-desgin-linux-x64`，不是签名安装包，没有公证，也没有打开 GUI。目录身份 SHA-256 `6cbd9d5b9ccc2aac8a07b0e066c1f2dd3ff1668ad745199ed1abe081670ca5bf`。

随后执行：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --release-dir=frontend/design-desktop/release/futureox-desgin-linux-x64 \
  --require-package
```

`--require-package` 退出码 0。它把清单里的 787 条包内文件和 `app.asar` 条目重新哈希，并和清单记录对照。对照失败会让进程失败。这次没有失败。`releaseAcceptance` 仍是 `not_closed`，`formalSignedPackage` 是 `not_supplied`，`signature` 是 `not_run`。

| 测量 | 这个未签名目录 |
| --- | --- |
| 包内普通文件 / 含 asar 条目 | 569 / 787 |
| Electron 44.7.0 运行时文件 | 71，含主程序、`LICENSE`、`LICENSES.chromium.html`、`libffmpeg.so` |
| 生产 JS 包 / 包内 notice 对上 | 16 / 16 |
| JS 开发依赖，包内没有对应文件 | 204，泄漏 0。含 Vite、Lightning CSS、Playwright、`@electron/packager` |
| 本包 linux 与 wasm 图里的第三方 Rust crate / 包内 notice | 223 / 221 |
| 只在编译期的 proc-macro，notice 在包里 | 13 |
| 不在本包二进制图里的 lock 名 | 106。含 Windows 的 `same-file` 1.0.6 和 dev-dependency `tiny-skia` 0.12.0 |
| native ELF | 4：sidecar、`design-render`、`design-prepare`、`futureox-design-agent`，均 0.1.0 |
| WASM | 6，其中设计内核两份字节相同 |
| 字体 / 图标 | 23 / 23 可追溯，16 / 16 图标指向包内 `resources/project-license/LICENSE` |
| Linux FFmpeg 7.0.2 | 可追溯，GPL-3.0-or-later |

主程序 SHA-256 `10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564`，`LICENSE` `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`，`LICENSES.chromium.html` `3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`，Chromium `libffmpeg.so` `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`。这些和上一节解压 zip 的对应文件一致，但是这次哈希的是 packager 目录里的文件。仓库 GPL FFmpeg 仍是 `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317`，和 Chromium 的 `libffmpeg.so` 不是同一个文件。

上面这一节是补齐许可文本之前的目录。当时仍未关闭的是：

- `profiling` 1.0.18 和 `spirv` 0.4.0+sdk-1.4.341.0 在包内二进制的依赖图里，crate 只有 SPDX 标识，没有许可文件。
- 包里仍有两份验证页和三张 `color-fixtures` 图，没有许可文本。
- macOS arm64、Windows x64 没有构建。签名、公证、安装包和桌面 GUI 步骤是 `not_run`。
- 那个目录不能当成正式发布验收。

## 2026-11-13 许可文本

`profiling` 1.0.18 的 crate 压缩包 SHA-256 是 lockfile 里的 `3d595e54a326bc53c1c197b32d295e14b169e3cfeaa8dc82b529f947fba6bcf5`，包内没有许可证文件。许可文本取自发布提交 `8271551172eb6fa4cba47369aedd93790c623df9` 的 `LICENSE-MIT` 与 `LICENSE-APACHE`。`spirv` 0.4.0+sdk-1.4.341.0 的压缩包 SHA-256 是 `d9571ea910ebd84c86af4b3ed27f9dbdc6ad06f17c5f96146b2b671e2976744f`，同样没有许可证文件。文本取自 trusted-publishing 提交 `8afc3d0ac8e158128cd1410bb2e4b4c26ab11bb4` 的 `LICENSE`。两份 `source.json` 记下 URL、修订和 sha256。清单生成器没有改写成另一套名单；包里的这些文件哈希对上，crate 才可追溯。

三张 `color-fixtures` 图由 `design-studio/crates/design-kernel/examples/color_assets.rs` 写出。`PROVENANCE.json` 记录每张图的 sha256。高光图对应仓库 MIT `LICENSE`。`p3-red-icc.png` 里的 ICC 配置由 moxcms 0.9.1 生成，包内还要有它的 BSD-3-Clause 和 Apache-2.0 文本。哈希不一致就仍然是缺口。

`canvas-chrome-verify.html` 和 `sdf-shadow-verify.html` 含有 Figma 着色器转写，仓库没有再分发许可。它们继续留在源码树，生产拷贝和打包入口把它们排除在包外，和已经排除的 `figma-blur-verify.html` 一样。如果包里仍然出现 `*-verify.html`，清单保持不可追溯。

macOS 的 `objc2` / `block2` 系列仍然只有 SPDX、没有许可文件。这次没有构建 macOS 包，也没有用一份未核对的文本代替。`releaseAcceptance` 仍然是 `not_closed`。签名、公证、Windows Authenticode 和安装器没有做。

另外五个已经进 Linux 依赖图、但 notice 目录里原先没有文本的 crate，许可文件就在 crates.io 压缩包里：`color_quant` 1.1.0、`fax` 0.2.7、`gif` 0.14.2、`tiff` 0.11.3、`weezl` 0.1.12。`--write-notices` 按现有复制规则把这些文件抄进 `third-party-notices/cargo/`。它们不是上游补录。

## 2026-11-13 补齐后的未签名 Linux 目录

云端 linux x64 在当前 `main` 上跑了 `node scripts/build.mjs`（默认 profile `release`）和 `node scripts/package.mjs`。产物是 `frontend/design-desktop/release/futureox-desgin-linux-x64`。没有签名，没有公证，没有打开 GUI，没有做 macOS 或 Windows 包。

随后执行：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --release-dir=frontend/design-desktop/release/futureox-desgin-linux-x64 \
  --require-package
```

退出码 0。它重新哈希清单里的 805 条包内文件和 `app.asar` 条目，并和清单记录对照。`profiling` 与 `spirv` 的包内许可文件还要和包内 `source.json` 的 sha256 一致。对照失败会让进程失败。这次没有失败。`releaseAcceptance` 仍是 `not_closed`，`formalSignedPackage` 是 `not_supplied`，`signature` 是 `not_run`。目录身份 SHA-256 `f2e6f44d0250bd8f5ce7ddeea75c8e47b27eb4549bcd5774dd7f78e8f3b832cd`。`resource-list.json` 里的 profile 是 `release`，`formalRelease` 是 false。

| 测量 | 这个未签名目录 |
| --- | --- |
| 包内普通文件 / 含 asar 条目 | 581 / 805 |
| Electron 44.7.0 运行时文件 | 71，含主程序、`LICENSE`、`LICENSES.chromium.html`、`libffmpeg.so` |
| 生产 JS 包 / 包内 notice 对上 | 16 / 16 |
| JS 开发依赖，包内没有对应文件 | 204，泄漏 0 |
| 本包 linux 与 wasm 图里的第三方 Rust crate / 包内 notice | 228 / 228 |
| 只在编译期的 proc-macro，notice 在包里 | 13 |
| 不在本包二进制图里的 lock 名 | 105 |
| native ELF | 4 |
| WASM | 6 |
| 字体 / 图标 | 23 / 23，16 / 16 |
| color-fixtures | 3 / 3，外加包内 `PROVENANCE.json` |
| 验证页 | 0。两份 Figma 着色器验证页不在包里 |
| Linux FFmpeg 7.0.2 | 可追溯，GPL-3.0-or-later |
| 许可或分类缺口 | 0 |
| 签名 / 其他平台 | `not_run`，darwin-arm64 与 win32-x64 是 `not_built` |

主程序 SHA-256 仍是 `10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564`，Electron `LICENSE` `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`，`LICENSES.chromium.html` `3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`，Chromium `libffmpeg.so` `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`。仓库 GPL FFmpeg 仍是 `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317`。

包内 `profiling` 1.0.18 的 `LICENSE-MIT` 是 `c8167fdeeed46d3f244d3f85c5bf998ce889343691c32be2c61a8bc4b5c08333`，`LICENSE-APACHE` 是 `10d30a673cd5e9349bdc02aeb48f14b3386d27d0da32df8f0a555d4aa16aa551`。`spirv` 的 `LICENSE` 是 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`。

源码侧 cargo 图里仍没有许可文本的是这八个 macOS crate：`block2` 0.6.2、`objc2` 0.6.5、`objc2-core-foundation` 0.3.2、`objc2-core-graphics` 0.3.2、`objc2-encode` 4.1.0、`objc2-foundation` 0.3.2、`objc2-metal` 0.3.2、`objc2-quartz-core` 0.3.2。它们不在这个 Linux 包的二进制图里。这个目录仍然不是正式发布验收。

## 2026-11-13 已发布的 linux x64 deb

当前 GitHub release `v0.0.0.1` 的 linux 包是 `futureox-design-0.0.0.1-linux-x64.deb`。它的源提交是 `58f0d7542fb7e7bfcc4ab48fecf82b96727b7ea0`，不是这次验收脚本所在的工作树。发布记录里的图形界面此前是 `blocked`，原因是当时的容器拒绝了 Chromium 沙箱命名空间。这台 linux x64 机器可以建立用户命名空间，所以同一份包这次被 `dpkg` 安装并启动了。

`dpkg --root` 使用空的软件包数据库，因此加了 `--force-depends`。依赖警告留在安装输出里。宿主机上这些库已经安装，进程链接的是宿主机库，不是 chroot。没有做 macOS 签名公证，也没有做 Windows Authenticode。

```bash
node frontend/design-desktop/scripts/release-desktop-session.mjs \
  --package=/absolute/futureox-design-0.0.0.1-linux-x64.deb \
  --verification=/absolute/release-verification.json
```

退出码 0。`packageFlow` 是 `executed_unsigned_release`，`releaseAcceptance` 仍是 `not_closed`，`signature` 是 `not_run`，`formalRelease` 是 false。

- deb SHA-256：`092798551707d6c4016127afcded7404a37ada975a06262ae3b93a0877ff300c`，与 `SHA256SUMS.txt` 和 `release-verification.json` 的 linux-x64 记录一致
- 安装后的目录身份 SHA-256：`7482de5c607a93ee6d92953b15421ae71ae608035615a309ee86444f4c1867d5`（568 个文件）。会话前后相同，且不等于 deb 哈希
- 安装位置：`dpkg --root` 下的 `opt/futureox-desgin/futureox-desgin`。启动的是这个文件，不是 `usr/bin` 符号链接，也不是目录复制
- 平台：linux / x64，profile `release`。`app.asar` SHA-256 `0a4f07f291ebe64c61ab3d52d65eb62f181c760cd285573683580ce7242f8164`。sidecar SHA-256 `050c3484cb33731bfa92ef14734e5bf3c259c6ffb2125c0a8ea978120defec9b`。两者都对上发布校验
- 运行时：Electron 44.7.0，Chromium 152.0.7977.130。进程参数没有 `--no-sandbox`。渲染进程 sandbox、contextIsolation、webSecurity 为真，nodeIntegration 为假。用户数据在验收用的私有 `HOME` 里，不在真实家目录
- 这个包没有验收配置钩子，也不读取首次启动的 `.fd` 参数。打开走的是「打开设计文件」和原生打开对话框。当前工作树里的包如果带这些钩子，仍必须使用验收配置目录
- 只读原件副本 SHA-256 `19c5306e4eb304e20288eb13d6caba11be4e63dc6e24f0d084da93d82bdbf66d`。仓库原件和副本在会话前后都不变
- 打开后的文档名是 `Futureox / original F-D brand icon`，3 个图层。缩放从 1 到 1.25。名称加上 `acceptance` 后撤销回原名。状态为「已自动保存到工作副本」。关闭后用同一个私有家目录重开，名称和图层键相同
- 原生导出先拒绝原件路径，再写出独立 `.fd`。包内 sidecar 打开该文件，魔数 `FXDK`，内容哈希与只读原件相同，路径不同
- 启动参数含 `--core-cpu-only`。这不是硬件 GPU 验收
- macOS 签名公证与 Windows Authenticode 仍是 `blocked`。`.dmg`、`.pkg`、`.msi`、`.exe`、`.rpm` 仍是未挂载。安装器记录因此是 `linux_deb_installed`，不是全部通过

## 2026-11-13 当前 main 的未签名 Linux 目录

同一台 linux x64 先在补许可文件之前，用当前 `main` 跑了 `node scripts/build.mjs`（默认 profile `release`）和 `node scripts/package.mjs`。产物仍是 `frontend/design-desktop/release/futureox-desgin-linux-x64`。没有签名，没有公证，没有打开 GUI，没有做 macOS 或 Windows 包。

当时的 `--require-package` 退出码 0。它重新哈希 811 条包内文件和 `app.asar` 条目。目录身份 SHA-256 `0ed77bdf7b93b7140181c4bce604270dcb2a76c563b43de21346dc59b6fb5f39`。包内普通文件 585。linux 与 wasm 图里的第三方 Rust crate 是 231/231，其中包含后来加入的 `freetype` 0.7.1、`freetype-sys` 0.19.0 和 `splash-glyph` 0.1.0。`splash-glyph` 指向包内项目 MIT `LICENSE`。`freetype` 当时只有 crate 压缩包里的 `LICENSE-MIT` 和 `LICENSE-APACHE`，没有同包的 `COPYRIGHT`。color-fixtures 3/3，验证页 0，FFmpeg 可追溯。清单缺口只有签名 `not_run`，以及 darwin-arm64 与 win32-x64 的 `not_built`。`releaseAcceptance` 是 `not_closed`。源码侧 cargo 图仍有上面那八个 macOS crate 没有许可文件。`dispatch2` 0.3.1 和 `objc2-io-surface` 0.3.2 在 lockfile 里，但不在这四个二进制的 normal 依赖图里，所以没有给它们补文本。

随后把 `freetype` 0.7.1 的 `COPYRIGHT` 从 crate 压缩包抄进 notice 目录。八个 macOS crate 的压缩包 SHA-256 与 lockfile 一致，包内没有许可证文件。每个 crate 的 `.cargo_vcs_info.json` 记下发布提交。那些提交里唯一的许可文件是仓库根目录的 `LICENSE.md`。它写明 SPDX，并链接 MIT、Zlib 和 Apache-2.0 的文本，但没有把授权正文放进文件。notice 目录复制的就是这份 `LICENSE.md`，`source.json` 记下 URL、修订和 sha256。没有用通用许可证正文代替。清单生成器只去掉了 cargo 重复行贴在许可证字段末尾的 ` (*)`，没有改成另一套名单。

补完后重新构建并打包。`node scripts/verify-package.mjs` 退出码 0。然后：

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs \
  --release-dir=frontend/design-desktop/release/futureox-desgin-linux-x64 \
  --require-package
```

退出码 0。它重新哈希 828 条包内文件和 `app.asar` 条目。对照失败会让进程失败。这次没有失败。`releaseAcceptance` 仍是 `not_closed`，`formalSignedPackage` 是 `not_supplied`，`signature` 是 `not_run`。目录身份 SHA-256 `3ae8744590671e7e5d774c7dddde2c74bb10aa51856ec6a3202b7a04ef8cde84`。`resource-list.json` 里的 profile 是 `release`，`formalRelease` 是 false。

| 测量 | 这个未签名目录 |
| --- | --- |
| 包内普通文件 / 含 asar 条目 | 602 / 828 |
| Electron 44.7.0 运行时文件 | 71 |
| 生产 JS 包 / 包内 notice 对上 | 16 / 16 |
| JS 开发依赖，包内没有对应文件 | 204，泄漏 0 |
| 本包 linux 与 wasm 图里的第三方 Rust crate / 包内 notice | 231 / 231 |
| 只在编译期的 proc-macro，notice 在包里 | 13 |
| 不在本包二进制图里的 lock 名 | 105 |
| 源码侧四个平台加 wasm 的第三方 crate / 有许可文件 | 271 / 271 |
| native ELF | 4 |
| WASM | 6 |
| 字体 / 图标 | 23 / 23，16 / 16 |
| color-fixtures | 3 / 3 |
| 验证页 | 0 |
| Linux FFmpeg 7.0.2 | 可追溯，GPL-3.0-or-later |
| 许可或分类缺口 | 0 |
| 签名 / 其他平台 | `not_run`，darwin-arm64 与 win32-x64 是 `not_built` |

主程序 SHA-256 仍是 `10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564`，Electron `LICENSE` `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`，`LICENSES.chromium.html` `3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`，Chromium `libffmpeg.so` `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`。仓库 GPL FFmpeg 仍是 `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317`。

包内 `freetype` 0.7.1 的 `COPYRIGHT` 是 `ec82b96487e9e778ee610c7ab245162464782cfa1f555c2299333f8dbe5c036a`，与 crate 压缩包里的文件一致。八个 macOS crate 的 `LICENSE.md` 都在包内 notice 目录，SHA-256 是 `7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54`。它们仍没有链进这个 Linux 二进制。这个目录仍然不是正式发布验收。

## 随包资源标识（#264）

打包入口在 staging 内写入 `resource-list.json`，`verify-package.mjs` 核对包内实际字节。组件清单的 `packageResources` 同时记录 JS/WASM/native 的路径和hash。`formalRelease` 仍为 false，签名仍为 `not_run`；目录哈希、资源列表和已安装应用会话属于不同的证据。
