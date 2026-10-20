# Futureox Ops management platform + analytics wall

Original agent-authored synthetic UI exercise with Overview, Users, Projects,
Settings (1440×1000 each) and an Analytics Wall (1920×1080). All design creation,
batch changes, shared styles, component creation/instantiation, targeted text edits,
undo/redo, FD and Sketch exports/imports use the actual project's MCP.

Run from repository root:

```sh
FUTUREOX_OPS_GENERATION_DIR=/absolute/output/directory \
  node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --root frontend/design-client \
  --config ../design-mcp/examples/ops-platform.vitest.config.mjs
python3 frontend/design-mcp/examples/render-ops-previews.py /absolute/output/directory
```

The transport is real NDJSON JSON-RPC over in-memory Node streams. It goes through
DesignMcpServer → OperationBackend → actual operation API → actual Editor/WASM.
No server operation, font engine, native decoder, or document model is mocked.
MCP resource reads are materialized into delivery files, while large resource
bytes are represented by lengths and SHA-256 in the recorded protocol transcript.

Deliverables include `futureox-ops.fd`, `futureox-ops.sketch`, five page SVGs,
static approximate HTML/CSS, native CPU preview PNGs and a feature-loss report.
The renderer is the repository's actual VectorEngine.render_rgba analytic CPU
renderer at 0.5× zoom. PNG conversion merely encodes its RGBA buffers. It is not a
browser/GUI/Sketch-app screenshot or GPU acceptance test.

FD decode must equal the original document exactly; append import checks all
nodes and remapped child relationships. Sketch is a compatibility carrier:
the actual ZIP is inspected, imported through MCP, every original text is
verified, and one imported text is edited. Export/import warnings are retained.
SVG is reimported through the actual MCP svg.import operation, which uses the
shared importSvg parser in a CPU XML host and the native append transaction.
SVG outlines text and loses native font/component/style semantics. These losses
are explicitly recorded, not claimed as lossless import. HTML is static UI,
not a functioning administration backend or live data dashboard.

Only the repository's bundled unmodified Noto Sans SC fixture is used. Exported
font bytes, license and source metadata travel together outside the repository.
