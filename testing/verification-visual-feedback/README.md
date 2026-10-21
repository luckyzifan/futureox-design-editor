# Product CPU visual-feedback verification

## Implemented

- `preview.capture` uses the existing `exportImage` → `KernelClient` → product CPU
  raster pipeline. There is no SVG/HTML/DOM substitute or automatic scale decrease.
- Explicit PNG, JPEG and WebP formats; active-page default; exact page/root IDs,
  document/session/revision, bounds/origin, dimensions, scale, byte count and backend.
- The capability identifies **CPU design-content export**. It explicitly disclaims
  application-window/selection-overlay screenshots and displayed GPU equivalence.
  Worker availability is disclosed as unprobed rather than claiming a successful capture.
- Snapshot cloning, read-only permission, document/session and optional revision
  fences, active-page race rejection, async deadline/cancel handling, renderer errors,
  pixel/side budgets and base64-aware 8 MiB transfer limits.
- Every preview has an immutable, bounded, MCP-session-local image resource.
  A bounded image is also delivered once as native MCP image content. Binary data
  is not duplicated into text or structured JSON. Larger images remain available at
  their original requested scale through `resources/read`.
- `app.export` files are projected atomically as inert resources. The MCP server
  does not execute the generated application JavaScript.
- A narrowly typed native host callback supports the separately implemented
  workspace/settings adapter. It retains document/session/deadline/cancel checks
  and returns transport errors without manufacturing successful operation envelopes.

## What ran

Final focused results: 51/51 client CPU/Editor/export tests, 42/42 MCP
framing/operation/server/resource/prompt tests, and full client TypeScript passed.
See `manifest.json` for logs and image hashes; `focused-source-hashes.json` records
a limited source/input snapshot, not a complete dependency closure.

`preview-feedback.test.ts` runs the actual Editor, operation registry, renderer
bridge, export pipeline, WASM `VectorEngine.render_region_png`, Rust image
transcoder and MCP protocol server. Its Web Worker **message/lifetime boundary**
is an in-process adapter. Its NDJSON streams are in memory. Real WASM pixels are
produced. Neither a browser nor an OS socket is launched.

The scripted regression exercises context inspection, guarded fill modification,
PNG capture, exact inline-image/resource byte comparison, stale revision rejection,
immutable old resources and undo that restores byte-identical PNG output. Separate
cases cover all three real raster formats, cancellation/worker disposal, dimensions,
active page races, renderer absence, budget preflight, transport limits and failure
preservation. Transport-only binary fixtures are explicitly labeled as such.

### Actual agent visual review

1. The first run generated `product-cpu-before.png` and `product-cpu-after.png`.
2. The assistant viewed both actual PNGs through the image viewer.
3. After that inspection, `agent-refinement.json` recorded a small decision to
   center the label within the existing button. This is a synthetic card refinement,
   not a claim that a real product defect was discovered.
4. A separate MCP regression requires the input PNG SHA-256 to match the previously
   inspected image exactly, applies the recorded decision in one fenced batch, and
   captures `product-cpu-reviewed.png` through the same real CPU export path.
5. The assistant viewed the reviewed PNG: the label is centered; the button size,
   color, title, 480×280 dimensions and 1× requested scale remain unchanged.

`cpu-feedback-evidence.json` and `agent-review-evidence.json` record per-request
outcomes, pixel hashes, capture metadata and explicit verification boundaries.
No external model provider was contacted. The visual decision was made by the
assistant inspecting tool-returned product pixels.

### Reproduce the permitted CPU checks

From `frontend/design-client`:

```sh
FUTUREOX_VISUAL_FEEDBACK_DIR=/absolute/path/to/new-evidence \
  ./node_modules/.bin/vitest run \
  src/automation/bridge.test.ts src/automation/preview-feedback.test.ts \
  src/automation/export.test.ts src/automation/mcp-e2e.test.ts \
  src/export-regions.test.ts
./node_modules/.bin/tsc --noEmit
```

From repository root:

```sh
node --test frontend/design-mcp/test/preview-resources.test.mjs \
  frontend/design-mcp/test/artifacts-prompts.test.mjs \
  frontend/design-mcp/test/server.test.mjs
```

## Preserved failures and limits

- `cpu-expanded-run.log`: the first expanded run found that very large geometry
  reached the lower-level 64-million-pixel planner error before the stricter preview
  error. Production preview preflight was corrected, preserving scale and resolution;
  the same unchanged existing assertion then passed in the rerun.
- `typecheck-first-run.log`: a concurrent app-export schema edit temporarily had an
  unrelated TypeScript error. Its owner fixed it; the subsequent full client typecheck
  passed. Logs are retained rather than overwritten as successful runs.
- `native-helper-help.log`: only the safe help path ran. It reads no connection
  credentials and opens no process/socket. The helper also passed `node --check`.
- OS socket/stdio-to-desktop, Electron, browser-worker dispatch, actual GPU canvas,
  app screenshots, client-specific image presentation and production-provider calls
  remain **NOT RUN** here. Prior environment restrictions were not bypassed.
- This focused visual-feedback suite is not a claim that the whole repository passed.

## Manual native acceptance (not performed in this environment)

On the authorized desktop, after opening the intended document and explicitly
turning on its local bridge:

1. Start with read scope. Configure the ephemeral connection in local process
   environment variables as documented in `frontend/design-mcp/README.md`. Never
   save tokens in source, evidence, prompts or screenshots.
2. Run the read-only helper from a new output directory:

   ```sh
   node frontend/design-mcp/examples/capture-native-preview.mjs \
     --run --output /absolute/path/to/new-native-evidence --scale 1
   ```

   The helper launches the actual MCP CLI and native local socket, captures the
   current page at the explicit requested scale, reads exact image resources and
   verifies PNG signature/dimensions/byte count. It saves evidence without connection
   secrets. It does not edit, export an app, change settings, or evaluate scripts.
3. In the actual AI client, confirm the native image content is visible, or that
   large-image resources can be opened. Check document/page/node/revision metadata.
   A resource link alone is not proof the client displayed the image.
4. Under a separately authorized write session, inspect context, capture, make one
   specific reversible edit using observed fences, capture again, visually inspect,
   then undo and capture. Confirm stale revisions fail and independent content stays
   unchanged. A scripted response is not a substitute for actually viewing pixels.
5. Exercise cancellation, timeout, rapid page switch, document switch, bridge
   revocation and re-enable. No late result should become a preview of the new
   document/page. While the grant remains live, old MCP resources must retain their original
   revision. They expire when the MCP session closes or its associated backend
   observes terminal disconnect/revocation. Subsequent resource reads/listing must
   fail explicitly; re-enable must not restore the old cache. Already delivered
   or accepted output bytes and external client copies cannot be recalled.
6. Separately record the actual Electron window/GPU canvas at the same authored
   document state. Compare text, effects, masks, fonts, color management, crop and
   scale. CPU preview success alone does not establish displayed-GPU parity.
7. Keep each stage's status and actual screenshots. Do not mark native/client/GPU
   acceptance passed until it was performed in the permitted native environment.
