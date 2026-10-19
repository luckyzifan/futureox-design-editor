# Agent-authored local studio exercise

This is a new original three-page design authored by the assistant for the user's
request to actually exercise MCP generation. It does not claim the adapter has its
own model or that this test called an external model provider.

The actual path is:

Assistant-authored operation plan → NDJSON JSON-RPC → `DesignMcpServer` →
`OperationBackend` → shared operation API → real `Editor` and repository Rust/WASM.

Only the transport is in memory. No operation results, Editor, fonts, geometry,
native codec, or WASM are mocked. This is intentionally separate from the existing
Luma fixture, and from blocked OS socket/browser/Electron/GPU acceptance.

## First checkpoint

From the repository root:

```sh
OUTPUT="$PWD/../design-ai-workspace-next/generated-example"
FUTUREOX_AI_PHASE=draft \
FUTUREOX_AI_GENERATION_DIR="$OUTPUT/draft" \
node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --root frontend/design-client \
  --config ../design-mcp/examples/ai-generation.vitest.config.mjs

python3 testing/verification-ai-generation/render-svg-previews.py \
  "$OUTPUT/draft"
```

Inspect the actual returned per-page `context.json`, `checks-after.json`, and
`cpu-svg-preview.png`. The previews are native SVG exports rasterized by installed
librsvg/Cairo on CPU; they are not screenshots of the application renderer.

Do not pre-script refinement decisions and then describe them as model inspection.
After inspecting, record concrete decisions and exact operations in a separate
JSON file with `decisions` and `operations` arrays. Node IDs are stable across
draft/final replay; the first page ID is generated per document.

## Final replay and regression validation

```sh
OUTPUT="$PWD/../design-ai-workspace-next/generated-example"
FUTUREOX_AI_PHASE=final \
FUTUREOX_AI_REFINEMENTS="$PWD/testing/verification-ai-generation/agent-refinements.json" \
FUTUREOX_AI_GENERATION_DIR="$OUTPUT/final" \
node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --root frontend/design-client \
  --config ../design-mcp/examples/ai-generation.vitest.config.mjs

python3 testing/verification-ai-generation/render-svg-previews.py \
  "$OUTPUT/final"

python3 testing/verification-ai-generation/audit-delivery.py "$OUTPUT/final"
```

The final run replays original creation and applies inspected refinements through
MCP, exports FD/JSON/HTML/CSS/SVG/assets/font, decodes the saved FD through the real
WASM into another Editor, edits reopened text over MCP and verifies undo/redo. It
also imports FD through MCP with ID remapping, checks every imported node and
child relationship, and edits the result.

Failed writes/read guards are tested against exact document object identity,
revision, page, and selection. Cases cover missing guards, wrong session, stale
revision, atomic rollback, invalid enum, text-kind mismatch, wrong-page context,
checksum corruption, and stale semantic cursors. Identical text edits must return
`noChange` without increasing the revision.

Heavy generated documents, duplicated fonts and full request/response transcripts
are retained outside the source checkout at the chosen `OUTPUT` directory. The
source increment contains only scripts, tests and compact review evidence in
`testing/verification-ai-generation`. The recorded first run was relocated after
verification; `generated-output-relocation.json` records old/new paths and proves
all moved file hashes were preserved. Payloads larger than 4096 characters
are represented in transcripts by length and SHA-256 rather than duplicating font
base64 or large artifacts. Exact exported files are retained separately.

The UI contains synthetic examples only. Exported HTML is static and approximate;
it is not a working file-management app. Native design nodes are genuinely editable.
