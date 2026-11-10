# Publication asset inventory

`scripts/inventory-publication-assets.mjs` walks two trees and writes a
per-file record. It does not grant a license.

- `frontend/design-client/public/fidelity/`: every file.
- `testing/fixtures/`: files whose extension is png, jpg, jpeg, gif, webp, fig,
  sketch, svg, tif, tiff, pdf, zip, or fd.

A `provenance.json`, `cases.json`, or `SOURCE.json` can identify a file and
its sha256. `nearestLicenseApplied` stays false. A file is `public` only when
`docs/publication/explicit-grants.json` names it and the checkout bytes match
that grant's synthetic-pixel provenance. Every other scanned file is
`withhold`.

This is an inventory and a proposed publication decision. It does not change
Git tracking, repository visibility, package inputs, or access to files that
are already published. It does not rewrite history.

Git LFS pointers are not hashed as the design bytes. For
`testing/fixtures/user-regression-20261109/`, the pointer oid is compared with
`manifest.json`. That manifest says inclusion does not grant a new
redistribution license.

`docs/UI_ASSET_PROVENANCE.md` cites `testing/fixtures/design/io/provenance.json`.
That file is back in this checkout, restored from git history rather than
rewritten. The scan reads its `images` list and does not treat the list as a
grant by itself.

```bash
node scripts/inventory-publication-assets.mjs
node --test scripts/opensource-prep.test.mjs
```

## 2026-11-10 review

The scan on this checkout reports 385 files. `public/fidelity` is still 349
files, all `withhold`. The other 36 are fixture binaries. Hash mismatches: 0.
Unbound source-list hashes: 0. This is a Linux file-byte review, not a Mac,
Electron, or Metal run, and it is not a legal clearance.

| Record | Count | Publication |
| --- | --- | --- |
| `source_list_hash_match` | 282 | withhold |
| `explicit_grant` | 3 | public |
| `source_list_omits_file` | 35 | withhold |
| `provenance_record_file` | 24 | withhold |
| `upstream_notice_unverified` | 20 | withhold |
| `no_provenance_record` | 14 | withhold |
| `lfs_oid_matches_manifest` | 7 | withhold |

The only public paths are the three synthetic I/O images named in
[explicit-grants.json](publication/explicit-grants.json):

- `testing/fixtures/design/io/display-p3-mid-icc.png`
- `testing/fixtures/design/io/lossless.webp`
- `testing/fixtures/design/io/orientation-6.jpg`

Their provenance source sentence is "Locally generated synthetic pixels; no
user images or Figma reference pixels." The copyright line is the root
`LICENSE` line, `Copyright (c) 2026 Cookieboty and contributors`, and the
license field is MIT. `generate.py` and `provenance.json` were restored from
the parent of `d81c3b42`, the commit that deleted them. The JPEG and WebP checkout
sha256 values match that provenance record. Pillow 12.3.0 on this Linux host
also reproduced those two hashes. The same run reproduced the Display P3
PNG's pixels and embedded ICC profile, but not its container sha256, so the
checkout bytes that match the provenance record were kept.

`lossless.webp` had been absent. The reproduced 38-byte file matches the
sha256 already written in the restored provenance, so it was put back. No
other fixture bytes were generated or replaced.

Figma PNG exports stay withhold even where a source list sha256 matches.
That match identifies the bytes; it does not grant redistribution. The native
FIG at `testing/fixtures/design/figma-materials-native-2026-10-08.fig` matches
`nativeFigSha256` and stays withhold. User-regression Git LFS pointers match
`manifest.json` and stay withhold; their design bytes were not reviewed
because this checkout has the pointer text. Third-party Sketch and fig2sketch
files keep the repository and license claim recorded in their `SOURCE.json`
or `LICENSE`, and those claims are not applied: there is no upstream revision
pin, and the semantic-ui kit README still names the Lato font family. WFP
logo files have no LICENSE file. Fourteen files, including
`fig-interop-v106.fig`, the two design Sketch fixtures, `color-library.sketch`,
and the marker-calibration directory, still have no per-file source list.

Per-file records are in [asset-inventory.json](publication/asset-inventory.json).
Regenerate with the commands above after the tree changes. Historical counts,
including the earlier 139 fixture binaries and the 384-file withhold-only
scan, stay historical.
