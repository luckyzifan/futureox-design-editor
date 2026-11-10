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

## 当前清单

清理未接入产品和回归入口的研究仓库后，当前清单包含 384 个文件。所有记录仍为 `withhold`，拟公开集合为空。

| 记录 | 数量 |
| --- | --- |
| `lfs_oid_matches_manifest` | 7 |
| `no_provenance_record` | 62 |
| `provenance_json_in_directory` | 291 |
| `provenance_record_file` | 24 |

`public/fidelity` 的 349 个参考文件保持原样。7 个用户回归夹具的 Git LFS OID 与 `manifest.json` 一致；清单从 Git 中的指针表示生成，不把本机是否已下载 LFS 内容当作再分发授权。

逐文件记录见 [asset-inventory.json](publication/asset-inventory.json)。树变化后按上方命令重新生成并检查；历史测试数量和扫描结果不替代当前清单。
