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

仍未关闭：

- `profiling` 1.0.18 和 `spirv` 0.4.0+sdk-1.4.341.0 在包内二进制的依赖图里，crate 只有 SPDX 标识，没有许可文件。
- 包里仍有两份验证页和三张 `color-fixtures` 图，没有许可文本。
- macOS arm64、Windows x64 没有构建。签名、公证、安装包和桌面 GUI 步骤是 `not_run`。
- 这个目录不能当成正式发布验收。

## 随包资源标识（#264）

打包入口在 staging 内写入 `resource-list.json`，`verify-package.mjs` 核对包内实际字节。组件清单的 `packageResources` 同时记录 JS/WASM/native 的路径和hash。`formalRelease` 仍为 false，签名仍为 `not_run`；目录哈希、资源列表和已安装应用会话属于不同的证据。
