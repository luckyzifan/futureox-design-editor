# AI-authored MCP generation and inspection

## Result

The assistant created an original three-page Forma local-design workspace, then
executed actual MCP requests against the real Editor/WASM. This is a new design,
separate from the existing Luma fixture.

- 3 pages: Workspace, Files, Settings
- 262 editable native nodes, including 126 text nodes
- 392 creation operations, followed by 3 inspection-selected changes
- 83 JSON-RPC requests across original, reopened and reimported sessions
- 89,917 bytes maximum model-facing tool response; file data read via resources
- Complete post-refinement checks: 89 / 93 / 80 nodes, zero reported issues
- 13 regression groups passed, including 9 rejection/unchanged-state cases
- 40 static delivery checks passed
- Saved native FD: 23,763,496 bytes
- FD SHA-256: `58b36b843392fe932eb568f3a890b3a1c1ca6ee44a9e22b0b82b5c2af50a327f`

## Actual agent-in-the-loop checkpoint

The draft was generated and its bounded context/check results returned before any
refinement decisions were written. All three native SVG exports were rasterized
with installed librsvg/Cairo on CPU. The root assistant inspected these actual
images and chose:

1. Increase the Workspace hero height from 220 to 244 px, improving CTA bottom
   spacing from 4 to 28 px. The structural checks had not flagged this visual issue.
2. Replace the Settings workspace-name text with `本地设计工作区`, preserving font
   and style, and verifying editable Chinese text.
3. Explicitly state that HTML/CSS is static and app behavior needs implementation.

These were submitted as a real guarded MCP batch. Tests verify exactly those
three nodes changed and all other nodes, page structure, child lists, fonts, and
text styles were preserved. The root assistant inspected the final Workspace and
Settings CPU previews and approved this scoped visual review. The unchanged Files
preview has exactly the same SHA-256 as the inspected draft.

No deliberately planted issue is represented as an accidentally discovered
product defect. The visual spacing change demonstrates the gap between structural
checks and visual review.

## Native/editability verification

The actual saved FD is decoded through the real WASM codec into another Editor.
Every original page, node and font is retained. A text node is changed via a new
MCP connection; undo, redo, and restoration are verified. Separately, actual MCP
`document.import` reads the FD, remaps all 262 nodes, and checks each node's kind,
text, dimensions, children and optional layout before editing imported text.

Rejections verify exact original document object identity, revision, page, and
selection: missing write guards, wrong session, stale revision, partial-batch
rollback, unsupported node kind, text operation on a non-text node, wrong-page
context, corrupted FD checksum, and stale semantic cursor. A repeated unchanged
text update returns `noChange` and preserves the revision.

## Limits and failure transparency

Only NDJSON transport is in memory; the MCP server, operation backend, Editor,
native codec, font, geometry and Rust/WASM are real. This test does not call an
external model provider or prove an external AI client connected over OS
stdio/socket transport. Browser, Electron, WebGPU, and product-renderer pixel
acceptance were not run. No blocked route was retried through an alternative.

CPU preview images are rasterized native SVG exports, not application screenshots.
HTML is a static editable approximation with synthetic data and no implemented app
behavior. The native FD is the lossless editable carrier. Structural/heuristic
checks do not prove aesthetics, overlap, accessibility or pixel equivalence.

The first final-run attempt failed because this new test expected the lower-level
`missing_revision` error at the MCP layer, which correctly returns `invalid_params`
before reaching that layer. The assertion was corrected against the actual
response and schema. The semantic-context cursor assertion was also aligned with
its documented `invalid_params` response. No production code was changed. The
failed log is retained as `final-run-attempt1.log`; the completed run is
`final-run.log`.

`tested-source-hashes.json` records SHA-256 for the conservative 133-file import
closure and actual WASM/font/config inputs, with zero unresolved relative imports.
This was captured after the run and checked against modification timestamps;
none of these inputs was modified after the recorded final-run start. It is not
misrepresented as an atomic pre-run snapshot or executed-module trace. Concurrent
late App/SettingsDialog/VariablesPanel edits are outside this dependency closure.
The actual WASM SHA-256 is
`e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b`.

## Artifact location and packaging

Heavy generated outputs were moved outside the source checkout after verification:

- Original full draft: `/workspace/shared/design-ai-workspace-next/generated-example/draft`
- Final full output: `/workspace/shared/design-ai-workspace-next/generated-example/final`
- Compact review evidence: `draft-review/` and `final-review/` in this directory
- Exact relocation and all moved-file hashes: `generated-output-relocation.json`

The previous paths ended in `testing/verification-ai-generation/draft` and
`testing/verification-ai-generation/final`; they are no longer the full-artifact
locations. All moved bytes were hash-verified unchanged. Full resource/transcript
evidence remains outside the source tree; compact protocol summaries point to each
actual request and outcome. Source changes consist only of new example/test files
and this new verification directory. Existing frozen evidence and production code
were not edited.

The clean UI package includes FD, three HTML/CSS pages, SVG, two native vector
assets, font and license, CPU previews, manifests and explicit scope notes. It
omits duplicated native JSON and large protocol transcripts; those remain in the
full output above. The package entry page is delivery navigation, not an MCP
exporter feature.
