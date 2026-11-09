# UI asset provenance and publication gates

Reviewed 2026-10-20. This is an engineering inventory, not a legal clearance or
promise of zero copyright/trademark risk. Noncommercial use does not automatically
permit copying. No project license has been selected by this review.

## Evidence-backed inventory

| Material | Evidence | Status / action |
| --- | --- | --- |
| Futureox F/D branding | `frontend/design-mcp/examples/branding.test.ts` authors native vector networks; `docs/BRANDING.md`; `public/branding/` and desktop assets | Original authoring path inspected; no imported image/font in generator. Trademark clearance not established. |
| Noto Sans SC | `frontend/design-client/public/fonts/source.json`, `OFL.txt` | OFL-1.1; retain full notice and font license. Native font staging now copies source/license alongside TTF. |
| Lucide icons | UI imports `lucide-react`; installed package LICENSE | Conditional on full ISC plus Feather-derived MIT attribution. Exact text retained under `public/licenses/`. |
| React and other JS runtime code | Installed package license texts and `public/licenses/inventory.json` | Notices preserved; scope is listed packages, not a complete application SBOM. |
| moxcms | `vendor/moxcms/Cargo.toml`, LICENSE.md, LICENSE-APACHE.md | BSD-3-Clause OR Apache-2.0. Both original texts retained. |
| Synthetic image I/O fixtures | `testing/fixtures/design/io/provenance.json`, generate.py; color_assets.rs | Local synthetic pixels, with ICC generation traced to moxcms. |
| Figma-rendered calibration references | `frontend/design-client/public/fidelity/` provenance records, including browser-2026-10-07 and mcp-2026-10-06 | 298 PNGs / 349 total files at review. Created calibration node/export evidence exists; complete ownership/redistribution rights not established by acquisition records alone. |
| Native calibration document | `testing/fixtures/design/figma-materials-native-2026-10-08.fig` and companion JSON | Source publication gate pending ownership/permission review. |

Font SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
The reviewed Futureox Ops sample ZIP includes that exact font, OFL.txt and source.json,
byte-identical to repository copies. Its original UI generation sources are
`frontend/design-mcp/examples/ops-platform-design.ts` and ops-platform.test.ts.

## Distribution boundary

Vite normally copies every public-directory entry. The production-public plugin
now disables that automatic copy and copies product entries while excluding the
`fidelity` directory. Development/test sources are preserved. Desktop packaging
rejects stale renderer output that still contains fidelity. Tests perform a real
Vite build and verify source references remain, distribution references are absent,
and actual font, branding and license bytes survive unchanged.

This is a product-output exclusion, not permission to publish the remaining source
repository. Reference fixtures, documents and historical verification evidence
still require review before public source release. Do not delete or relabel
provenance to disguise an unresolved origin. No fixture license has been granted
or changed by these modifications.

## Unresolved source and binary release gates

- Implementation-origin review remains open for the GPU stroke, prefix-sum
  and memory-accounting modules. Keep applicable attribution and resolve the
  original source, permissions and modification history before publication.
- Renamed shader filenames/symbols retain existing bytes and attribution. Descriptive
  naming does not clear copyright or provenance issues.
- Rust Cargo.lock has 337 packages at review. Complete target-specific runtime,
  transitive, Electron/Chromium and Rust binary notice verification remains open.
- Frontend installed metadata has 99 packages, including build-time MPL-2.0
  lightningcss packages. Installed does not mean shipped; determine distribution
  reachability before applying source/license obligations.
- Kiwi's installed npm archive lacks its license text. The full upstream LICENSE.md
  was retrieved and preserved; exact upstream-source revision matching remains open.
- Top-level project licensing and third-party material licensing are separate.
  Do not apply a new project license to material the project does not own.

## Safe next steps

Confirm ownership/permission for reference files, or omit those files from a public
source release while keeping private verification evidence. Replace unverified
borrowed implementation or assets with independently authored alternatives where
needed, preserving records of the investigation and actual generation. Keep
mandatory third-party notices when cleaning up internal names or completed reports.

## Primary sources

- [Google Fonts Noto Sans SC OFL](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt)
- [Official SIL OFL](https://openfontlicense.org/open-font-license-official-text/)
- [Lucide ISC and Feather MIT](https://lucide.dev/license)
- [Kiwi upstream license](https://github.com/evanw/kiwi/blob/master/LICENSE.md)
- [Vite public directory copying](https://vite.dev/guide/assets.html)
- [Figma terms, customer-content ownership section 2.8](https://www.figma.com/legal/tos/)
- [Copyright Office: noncommercial use is not automatically fair use](https://www.copyright.gov/fair-use/)
- [Open Source Definition section 6](https://opensource.org/osd): an imposed
  commercial-use ban is not OSI open source; voluntarily not monetizing is distinct.
