# Agent-authored local studio exercise

This exercise creates an original three-page design through the local MCP server, shared operation registry, Editor and repository Rust/WASM. It sends JSON-RPC over in-memory NDJSON. It exercises the actual font, geometry, editing and native codec paths with an authored replay plan.

Build the current WASM first. The full bundled font brings the serialized draft to about 24 MB. Run it on a host with enough working memory for the editor's 16× reserve. For a dedicated Node replay, the commands below configure a 384 MiB test-session budget. Use that setting on a host with at least 768 MiB of available memory at launch. [Document capacity](../../../docs/DOCUMENT_CAPACITY_V1.md)

## First checkpoint

From the repository root:

```sh
OUTPUT="$PWD/test-results/ai-generation"
CORE_DOCUMENT_MEMORY_BYTES=402653184 \
FUTUREOX_AI_PHASE=draft \
FUTUREOX_AI_GENERATION_DIR="$OUTPUT/draft" \
node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --root frontend/design-client \
  --config ../design-mcp/examples/ai-generation.vitest.config.mjs --maxWorkers=1

python3 frontend/design-mcp/examples/render-svg-previews.py \
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
OUTPUT="$PWD/test-results/ai-generation"
CORE_DOCUMENT_MEMORY_BYTES=402653184 \
FUTUREOX_AI_PHASE=final \
FUTUREOX_AI_REFINEMENTS=/absolute/path/to/selected-refinements.json \
FUTUREOX_AI_GENERATION_DIR="$OUTPUT/final" \
node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --root frontend/design-client \
  --config ../design-mcp/examples/ai-generation.vitest.config.mjs --maxWorkers=1

python3 frontend/design-mcp/examples/render-svg-previews.py \
  "$OUTPUT/final"

python3 frontend/design-mcp/examples/audit-delivery.py "$OUTPUT/final"
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

The preview helper needs Linux librsvg, Cairo and GLib. The delivery audit uses Pillow. Inspect the returned design JSON and SVG directly on systems where those helpers are unavailable. Exported HTML is static, and the native FD retains the editable design.

The output directory contains disposable documents, fonts, previews and transcripts. Record the result in Markdown with the plan, command and scope, then clear the output directory after review. [Local testing guide](../../../testing/README.md)
