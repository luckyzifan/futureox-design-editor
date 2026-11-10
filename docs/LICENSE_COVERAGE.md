# License coverage

The root [LICENSE](../LICENSE) is the MIT License, copyright
`Copyright (c) 2026 Cookieboty and contributors`. That text was already on
`main` before this checklist. This document only says what the repository
files themselves show.

## Covered by that MIT text

- `design-studio/Cargo.toml` sets `license = "MIT"` for the workspace.
- These crates inherit it with `license.workspace = true` and do not set a second license:
  - `crates/design-server`
  - `crates/design-kernel`
  - `crates/design-gpu`
  - `crates/design-desktop-backend`
  - `crates/design-agent`
- `frontend/design-client`, `frontend/design-desktop`, and `frontend/design-mcp` set `"license": "MIT"`.

## Not covered by that MIT text

These keep the license written in their own files:

| Path | License field in that file |
| --- | --- |
| `vendor/moxcms/Cargo.toml` | `BSD-3-Clause OR Apache-2.0` |
| `vendor/flo_curves/Cargo.toml` | `Apache-2.0` |

Fonts, the Linux FFmpeg executable, fidelity references, and fixture images are
outside this MIT metadata. Their notices stay in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and
[PUBLICATION_ASSET_INVENTORY.md](PUBLICATION_ASSET_INVENTORY.md). This checklist
does not apply the project license to them. The three synthetic I/O images
named by [explicit-grants.json](publication/explicit-grants.json) are a
separate publication record. This coverage script does not scan those images.

Contributor assignments beyond the copyright line already present in `LICENSE`
are not additionally evidenced here. Repository visibility is unchanged.

```bash
node scripts/check-license-coverage.mjs
node --test scripts/opensource-prep.test.mjs
```

2026-11-09 云端运行这两条命令：许可检查 `problems` 为空；`opensource-prep` 4 通过。没有改仓库可见性。
