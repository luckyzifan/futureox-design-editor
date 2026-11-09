# Publication asset inventory

`scripts/inventory-publication-assets.mjs` walks two trees and writes a
per-file record. It does not grant a license.

- `frontend/design-client/public/fidelity/`: every file.
- `testing/fixtures/`: files whose extension is png, jpg, jpeg, gif, webp, fig,
  sketch, svg, tif, tiff, pdf, zip, or fd.

A `provenance.json` in the same directory, a manifest entry, or a `LICENSE`
inside the fixture tree is recorded as a path. `nearestLicenseApplied` stays
false. The proposed public set from this scan is empty: every scanned file is
`withhold`.

This is an inventory and a proposed publication decision. It does not change
Git tracking, repository visibility, package inputs, or access to files that
are already published.

Git LFS pointers are not hashed as the design bytes. For
`testing/fixtures/user-regression-20261109/`, the pointer oid is compared with
`manifest.json`. That manifest says inclusion does not grant a new
redistribution license.

`docs/UI_ASSET_PROVENANCE.md` cites `testing/fixtures/design/io/provenance.json`.
That file is not in this checkout. The scan lists it under `missingCitations`
and does not invent a provenance record for it.

```bash
node scripts/inventory-publication-assets.mjs
node --test scripts/opensource-prep.test.mjs
```

## 云端结果

2026-11-09，linux x64，`node --test scripts/opensource-prep.test.mjs`：4 通过。`node scripts/check-license-coverage.mjs` 的 `problems` 为空。

同一次扫描共 1281 个文件，拟公开集合为空，全部 `withhold`：

| 记录 | 数量 |
| --- | --- |
| `no_provenance_record` | 959 |
| `provenance_json_in_directory` | 291 |
| `provenance_record_file` | 24 |
| `lfs_oid_matches_manifest` | 7 |

`public/fidelity` 有 349 个文件。其中 `alpha-curve.png` 这类与 `provenance.json` 不在同一目录的文件仍是 `no_provenance_record`。`mask-provenance.json` 只记它自己，不表示旁边的图已经获准再分发。7 个用户回归夹具的 Git LFS oid 与 `manifest.json` 一致，清单写明纳入仓库不构成新的再分发许可。

逐文件 JSON 在 `docs/publication/asset-inventory.json`。树变化后要重跑脚本，不要手改数量。

## 本机合并复核（2026-11-10）

在 `c8d7dfbc8` 基线的独立源码工作目录中执行，未混入本机未跟踪的私有夹具。4 项测试通过；许可元数据检查退出 0，`problems` 为空。重新生成的完整扫描与提交的 1281 条记录逐条一致，7 个 LFS OID 与清单匹配。项目及 vendor 许可证文件与基线逐字节相同。

本结果验证清单和当前文件元数据；没有重新授予素材许可，也不表示执行了发布或撤回已公开文件。
