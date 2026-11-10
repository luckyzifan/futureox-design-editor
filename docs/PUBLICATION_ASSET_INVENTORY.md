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

## Cloud measurement versus main

Measured on this Linux cloud VM on 2026-11-10. Baseline is `main` at
`ccaa2ea1a4a62aeff162fe4912e3920f99e529a2`. This is not a Mac, Electron, or
Metal run. No render timing, draw count, or memory budget was changed, so the
5% end-to-end performance gate does not apply. No fidelity threshold was
loosened.

Commands:

```bash
git worktree add /tmp/fx-main ccaa2ea1a4a62aeff162fe4912e3920f99e529a2
node /tmp/fx-main/scripts/inventory-publication-assets.mjs
node --test /tmp/fx-main/scripts/opensource-prep.test.mjs
node /tmp/fx-main/scripts/check-license-coverage.mjs
node scripts/inventory-publication-assets.mjs
node --test scripts/opensource-prep.test.mjs
node scripts/check-license-coverage.mjs
```

An independent Python hashlib check, not the inventory scanner, compared each
grant with the provenance `images` entry, the root `LICENSE`, and the
checkout bytes. The same script compared named sha256 entries inside fidelity
`provenance.json` and `cases.json` files with the PNG bytes.

| Measurement | Baseline `ccaa2ea` | Candidate |
| --- | --- | --- |
| Scanned files | 384 | 385 |
| `proposedPublic` | 0 | 3 |
| Files with a non-empty `source` | 0 | 335 |
| Files with a non-empty `attribution` | 0 | 323 |
| Files with a license field | 0 | 3, all `MIT` |
| `licenseStatus` granted / not granted | field absent | 3 / 382 |
| Content `hashCheck` match / mismatch | field absent | 285 / 0 |
| Fidelity files with `publication: public` | 0 of 349 | 0 of 349 |
| User-regression files with `publication: public` | 0 of 7 | 0 of 7 |
| Cited `testing/fixtures/design/io/provenance.json` missing | 1 | 0 |
| Independent verifiable public assets | 0 | 3 of 3 |
| Independent named source-list hashes | 398 match, 0 mismatch | 398 match, 0 mismatch |
| `display-p3-mid-icc.png` and `orientation-6.jpg` versus main | the baseline bytes | byte-identical, sha256 `e4721be2…` and `fed2837a…` |
| `node scripts/check-license-coverage.mjs` problems | 0 | 0 |
| `node --test scripts/opensource-prep.test.mjs` | 4 passed | 6 passed |

The test-count change is not the gain. The gain is that planned-public assets
with a verifiable basis go from 0 to 3, and 285 checkout hashes are now
recorded against source lists with 0 mismatches. Unapproved fidelity and user
files stay at 0 public.

Pillow 12.3.0 on this host ran `generate.py` in `/tmp`, not over the checkout.
`orientation-6.jpg` sha256 matched `fed2837ad7a94d17ce8130babe47da376723560fa0fe6cfea0acbb84dde82ca2`
(706 bytes). `lossless.webp` sha256 matched
`920da8b5a2098b996d6721c7b2ce7bd406bd5f20b5463aa2fd4827395c86c002` (38 bytes).
`display-p3-mid-icc.png` stayed 438 bytes with the same pixels and the same
598-byte ICC profile, but the container sha256 was
`aa4e705baa7663a98fe35bbd212d63af466c9662c5de2189a56da4a6fb667fef` instead of
the recorded `e4721be2db2983b37521e6d860e64e594b32deb24c7e667b3e1144522e6b4b9a`.
The checkout file that matches the record was kept.

`cargo test --locked --offline -p futureox-design-kernel --test image_metadata`
failed before compile because the cargo registry cache was empty
(`no matching package named axum`). After downloading crates, the same test
with the lockfile, without `--offline`, passed on both trees. The existing
assertion `pixels[..4] == [32, 130, 197, 255]` was not changed.

| Command | Result |
| --- | --- |
| Baseline: `cargo test --locked --manifest-path /tmp/fx-main/design-studio/Cargo.toml -p futureox-design-kernel --test image_metadata -- --test-threads=1` | 5 passed, 0 failed, 0.01s. Compile 32.48s. |
| Candidate: `cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --test image_metadata -- --test-threads=1` | 5 passed, 0 failed, 0.02s. Compile 47.64s. |

The 0.01s versus 0.02s test time is run-to-run fluctuation, not a performance
gain. The included JPEG and Display P3 PNG bytes are identical on both trees.

The browser script `frontend/design-client/scripts/check-io-import.ts` was not
run: bun is not installed. This VM did not run Mac, Electron, or Metal.
