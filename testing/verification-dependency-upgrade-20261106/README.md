# Rust 全量依赖升级与安全公告清零（2026-11-06）

## 升级清单

| 类别 | 项 | 从 → 到 | 迁移要点 |
|---|---|---|---|
| 工具链 | rustc | 1.96.1 → 1.99.1 | `rust-toolchain.toml` 改锁；重装 wasm32-unknown-unknown |
| **安全 P0** | ruzstd | 0.7 → 0.9.1 | RUSTSEC-2026-0344（解压炸弹）；API 改 `FrameDecoder::decode_all` 有界输出，另加 256 MiB 输出上限（镜像 zlib 路径）双保险 |
| **安全 P0** | zip | 2.2 → 9.4.1 | RUSTSEC-2026-0369 等 4 条（含 critical 9.1）；API 迁移：`name()→Result`/`name_raw()`/`file_names()` 产 Result/`start_file` 字节名；zip 9 原生声明尺寸校验成为第一道防线（我们的预算门退居第二道） |
| **安全 P0** | cargo update | 69 项 | rustls 0.23.46/webpki/ctutils/tokio 1.54.1（AsyncFd unsound）等全部兼容修复 |
| 大版本 | sha2 | 0.10 → 0.11 | `asm` 特性被移除（aarch64 回退可移植路径，摘要不变）；digest 0.11 去 LowerHex——全部 `{:x}` 摘要格式化改为显式 hex |
| 大版本 | miniz_oxide | 0.8 → 0.9.1 | 无 API 变化 |
| 大版本 | moxcms | 0.8 → 0.9 | 行为变化见下 |
| 大版本 | base64 | 0.22 → 0.23 | Engine 接口稳定 |
| 大版本 | lz4_flex | 0.11 → 0.14 | 无 API 变化 |
| 大版本 | utoipa / swagger-ui | 5/9 → 6/10 | 服务端编译通过 |
| 锁定对 | wasm-bindgen/js-sys | =0.2.128/=0.3.105 → =0.2.130/=0.3.107 | CLI 同步升级；WASM 重建 39.86 MB，glue 同步 |
| minor | tokio/serde_json/uuid/flo_curves | 1.54.1/1.0.154/1.29.0/0.8.1 | — |

utoipa-swagger-ui 10 的构建依赖仍拉 zip 2.4.2（隔离在 build-deps，不进产物图）。

## 验证

- **Rust 全量**（cargo test --workspace，含 lib/集成/backend/gpu/server）：**1252 通过 / 0 失败**（881 lib + 全部集成目标）。两处测试适配：①伪造尺寸炸弹用例接受 zip 9 原生拒绝或预算门任一（双保险）；②export_regions 的 `color_output` 默认值从「拒绝 color-managed」变为产出 **sRGB 标记 PNG**（色彩栈升级后的新能力，断言改为验证 sRGB 块存在）。
- **WASM**：`bun run build:kernel` 全量重建成功（1.99.1 + bindgen 0.2.130）。
- **前端**：`tsc --noEmit` 干净；**已知绿集合对照**（plugins 全套 + sketch-import-contract + layer-export，升级前有全绿记录）**81/81 通过**——升级未破坏任何已验证面。
- **前端全量首跑**（本机历史无全量基线）：7397 过 / 132 失败——其中 fontTools 缺失 ×27、缺失冻结文件 ×4 属环境缺件；其余 canvas/overlay 类无升级前基线可对照，按对照证据归为存量，待环境补齐后建基线。
- **cargo audit：16 项公告 → 0 漏洞**（剩 7 个失维警告：im/bitmaps/sized-chunks/ttf-parser/rustybuzz，列 P3 战略替换）。
- **转换链冒烟**（新依赖下）：fig rewrite v106 树/文档双一致；有料素材 9k 节点 `--bake` 全链 1.88 MB 通过（zip 9 压缩参数差异致体积微增 1.74→1.88 MB，内容一致）。
- 途中处置：磁盘 97% 满（旧工具链指纹死重 103.5 GB）`cargo clean` 后重建。

## 遗留

- aarch64 sha2 硬件加速待 sha2-asm 发布 0.11 兼容版后恢复。
- 失维 crates 替换选型（im→imbl 系、ttf-parser/rustybuzz）为 P3。
- 前端全量基线建立（需先 `pip install fontTools==4.61.1` 并核对缺失冻结文件的收录策略）。
