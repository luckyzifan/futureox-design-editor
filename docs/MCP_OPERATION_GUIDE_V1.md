# Futureox Design MCP operation guide (local v1)

## Discover the exact available API

Use the existing [local stdio adapter](../frontend/design-mcp/README.md). It connects to the explicitly enabled desktop document bridge on the same machine/user. The adapter does not host an AI, create cloud accounts, invent a REST endpoint or provide arbitrary code execution. Connection details are ephemeral; never commit bridge tokens. Legacy mode retains its 2025-11-25 handshake. Modern mode separately implements the 2026-07-28 identifier with per-request metadata; neither implies compatibility with every client.

After initialize and notifications/initialized, send:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

That example is the legacy wire shape. On a modern connection, omit the handshake and include `params._meta` on every request: `io.modelcontextprotocol/protocolVersion` is `"2026-07-28"` and `io.modelcontextprotocol/clientCapabilities` is an object. `server/discover` can inspect protocol capabilities without calling the backend. Client metadata is request-local data, never an authorization grant. A connection cannot mix modern and legacy eras. Modern results include `resultType: "complete"` and server metadata; catalog/resource results have zero private TTL. Follow the implementation and tested boundary in the adapter README rather than inferring support from a protocol version alone.

The exact names, input schemas and current count come from result.tools. Count that array after applying the actual host grants, not a static marketing total. This catalog is bounded and returned whole; invented tools/list cursors reject. The shared API provides api.capabilities and the MCP resource futureox-design://automation/capabilities. Inspect methods, limits, editing and unsupported. The registry is composed in frontend/design-client/src/automation/index.ts and core.ts; host-only preview/workspace/preferences can change the exposed list. Missing methods are unavailable in that session, even if mentioned in documentation.

Mapping is mechanical: node.update → design_node_update, text.styleRange → design_text_styleRange. Dots/hyphens normalize to underscores and collisions fail closed. Do not invent Figma aliases such as createFrame or executeJavaScript. Discovery does not grant access; execution rechecks authority.

For a saved tools/list JSON-RPC response, this counts exactly what was advertised without connecting to any endpoint:

```sh
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(r.result?.tools)) throw Error("Expected tools/list response"); console.log(r.result.tools.length); for(const t of r.result.tools) console.log(t.name)' tools-list.json
```

The direct createEditorDesignAutomation registry grows as extensions are added (including svg.import). Read api.capabilities().methods for the exact current count and descriptors. This excludes host-only preview/workspace/settings additions and is not the count promised to every MCP session. No universal total is promised. Separately, node.create.patch and node.update.patch expose the authored field set in node-input-descriptors.ts, including repeat and vectorBrush. The [generated operation coverage](OPERATION_COVERAGE_V1.json) records the actual node field names, registry descriptors, MCP mapping and current UI-category gaps instead of maintaining a numeric total by hand. See [import identity and local operation boundaries](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md) for generation, repeat-import/retry semantics, provenance, and explicit unimplemented collaboration/auth boundaries.

## Input structure, units and model mapping

MCP tools/call wraps the shared operation parameters in arguments.params. Write fences documentId, session and expectedRevision are siblings of params. Obtain them from a current read response; do not substitute the storage revision, a page ID or an MCP request ID. Reads default to handshake document/session; explicit fences can narrow them.

- Pages are ordered document.pages records with ordered root node IDs, not frame nodes. Use page.list/get/create/update/reorder/setCurrent and their discovered schemas.
- Frames are node.create with kind: "frame" and parentId set to a page or supported container. Sections/groups are their own native kinds. The 12 creation kinds are slice, frame, section, group, rectangle, ellipse, polygon, star, line, vector, text. A component is not a thirteenth kind.
- Main components, component sets and instances are native node facets managed by dedicated component.* methods. component.create takes nodeIds; component.instantiate takes componentId plus optional pageId/parentId/x/y. Inspect component.list/get and the current schemas before using override/property/variant operations. Ordinary main-component duplication can produce linked instances; it is not an unconditional deep-copy operation.
- Node creation x/y and authored transforms are parent-local document units. Whole-property transform is [a,b,c,d,tx,ty], with x′=a*x+c*y+tx and y′=b*x+d*y+ty. Negative translation/reflection is valid; singular matrices reject. node.get also exposes worldBounds, which must not be written back as parent-local coordinates. node.move preserves world transforms by default.
- Width, height, radii, spacing, strokes and fontSize use native document units, not screen pixels scaled by zoom/devicePixelRatio. Opacity, smoothing, gradient-stop offsets and normalized anchors use 0–1, not Inspector percentages. Font weight is 1–1000; lineHeight is a font-size multiplier (native model 0.1–10), letterSpacing is an absolute native spacing value. Gradient paint angle is degrees; ellipse arc startAngle/sweepAngle are radians. Export scale is a multiplier; CPU preview returns actual pixel dimensions separately.
- Whole-property radii is [topLeft,topRight,bottomRight,bottomLeft], layout.padding is [top,right,bottom,left]. Granular node.patch instead uses named partial objects, e.g. radii: {topLeft: 12}; granular transform uses {a,b,c,d,x,y}, not tx/ty or an array. Granular layout padding uses {top,right,bottom,left}.
- node.update replaces each supplied property, not arbitrary deep merge. Top-level optional null removes an optional property. The granular patch methods preserve omitted leaves and require existing layout/sizing/constraints/textStyle facets. Input schemas cannot express every kind/reference/determinant/grapheme constraint: final native model admission remains authoritative even after schema validation succeeds.
- text.styleRange and text.replaceRange use half-open UTF-16 offsets on complete grapheme boundaries, not UTF-8 bytes or Unicode code-point counts. replaceRange requires expectedText equal to the selected old substring. Insertion uses start=end and expectedText=""; deletion uses text="". Limits include 100,000 UTF-16 units and 4,096 runs.

## Shared selection commands

The existing node.align, node.distribute, node.group and node.ungroup methods use the same Core selection contract as the corresponding UI commands; UI is not rendered through MCP. Read [shared selection commands](SHARED_SELECTION_COMMANDS_V1.md) for exact geometry/defaults and candidate verification status. No new endpoint or compatibility selector is required.

Selection-frame wrapping is transparent/unclipped and preserves child world geometry; empty node.create frame keeps its existing factory defaults. Ungroup supports ordinary group/frame/section/boolean containers without baking parent styles. Component/instance structure and active auto-layout topology reject. Two-node distribution is unchanged; overlapping/contained distribution and unproven derived geometry after earlier batch edits return explicit errors without a commit. These limits must not be interpreted as fake successful editing or full Figma algorithm equivalence.

## Granular and bulk edits

Use [granular editing](GRANULAR_MCP_EDITING.zh-CN.md) for node.patch, layout.patch, paint.patch, text.styleRange and text.replaceRange. Paints are located by observed stable paintId and fill/stroke target. Expected partial leaves reject with value_conflict if any old value differs. They supplement, never replace, the outer write fences.

Use [bulk editing](DESIGN_BULK_EDITS.zh-CN.md) for node.patchMany, layout.patchMany, paint.patchMany, text.styleMany and text.replaceMany. Each uses params.targets with distinct nodeId values and the corresponding leaf-operation fields. At most 500 expanded operations are allowed across the whole request, including bulk wrappers nested in batch.apply. Duplicate nodes in one bulk wrapper reject; use explicitly ordered batch operations for sequential ranges in the same text node. Missing/locked/conflicting targets fail the whole request, never silently skip.

The following is a schema-shaped MCP request template. Replace the two UUIDs and numeric fences with observed values; expected name must match the actual node. It is not a ready-to-submit mutation for an unknown document.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "design_batch_apply",
    "arguments": {
      "documentId": "11111111-1111-4111-8111-111111111111",
      "session": 0,
      "expectedRevision": 1,
      "params": {
        "mutationId": "rename-card-1",
        "operations": [
          {
            "method": "node.patchMany",
            "params": {
              "targets": [
                {
                  "nodeId": "22222222-2222-4222-8222-222222222222",
                  "patch": {"name": "Card title"},
                  "expected": {"name": "Old title"}
                }
              ]
            }
          }
        ]
      }
    }
  }
}
```

For authored-only preflight, use design_batch_preflight with the same operations and fences but remove mutationId. It accepts the five granular methods, their registered bulk wrappers and variable.bind/unbind. It does not accept arbitrary creation/import/extension operations. Returned validation="authored-only", derivedResolution="deferred" and authoritativeCommitValidationRequired=true mean that layout, component materialization, final kernel validation and actual commit still lie ahead. Preflight is neither a rendered preview nor a reservation of the revision.

## Permissions, receipts and undo

Read [operation permissions](LOCAL_OPERATION_PERMISSIONS_V1.md). With a narrowing policy, authorize the batch method, each wrapper and each expanded leaf. Read-only discovery filtering is not the security boundary: direct execution must deny unauthorized reads/writes/history/receipt access. Current resources are whole document sessions, not page/node ACLs. Workspace and application preferences require independent native grants; see [workspace MCP](workspace-mcp.md).

One successful authored batch publishes atomically through Editor.change and creates one native undo entry; all-no-op edits create none. Failure publishes no partial edit. Native undo/redo remains separate from durable saved-history restore. Granular instance edits retain native whole-field override behavior, not a new leaf-level inheritance model.

batch.apply mutationId is optional, 1–128 ASCII letters/digits/_/-. On an uncertain response, retry exactly the same params and original document/session/revision fences in the same live session. A matching successful receipt returns replayed=true without another mutation, even if the user has since undone it. Changed arguments/fences conflict. Receipts are limited to 128 and 32 MiB serialized budget per API document session; they are not persisted across process restart. A receipt's revision is the original commit, while the response's outer revision is current. Failed staging/preflight does not consume a receipt.

### Synchronous supersession after an accepted mutation

Ordinary mutation responses and exact retry responses retain their existing fields. If a synchronous application subscriber edits, navigates, or loads another session after the authoritative commit but before the response, the adapter uses a private Editor receipt of the normalized immutable committed snapshot. It never combines the newer document with the older operation context. This receipt is not accepted from JSON, is not a permission or a replay token, and does not authorize cross-session writes.

Only an interrupted publication adds `result.completion`. Its output schema is `automationMutationCompletionSchema` in `frontend/design-client/src/automation/types.ts`. For an actual authored commit it contains `status: "committed"`, `superseded: true`, `contextApplied: false`, `retry: "do-not-retry"`, and the exact original `documentId`, `session`, and `revision`. The outer response uses that same original identity, `ok` remains true, and changes/history facts refer to the committed snapshot, not the current canvas. Do not repeat an accepted edit; read the active document before a subsequent independent operation. `contextApplied: false` means the captured page/selection was not established as the final active context: it may have been interrupted or immediately superseded. Any remaining old navigation/selection intent is abandoned, never carried into the newer owner.

If no authored change committed, such as navigation-only supersession, completion instead says `status: "unchanged"` and `retry: "read-current-state"`; `noChange` remains true. It does not claim an authored commit occurred. A batch mutation receipt keeps the original revision. If the session/cache owner changed during notification, `receipt.replayAvailable: false` makes explicit that this old result was not cached into the new session. Successful `history.undo` and `history.redo` use the same private receipt and captured history facts; blocked/no-op history still claims no commit. These are additive output fields only; input schemas, grants, budgets and new-tool availability do not change. Real NDJSON tests verify that accepted-but-superseded results are not converted into MCP errors or implicitly retried.

Successful authored mutation summaries use bounded RFC 6901 changedPaths/changes: at most 256 paths and 48 KiB, with changesTruncated and omitted-value markers. They omit font/image payloads and large objects. They are not full document exports or pixel diffs. Cancellation, disconnect, timeout or an output-size error cannot undo an already committed edit. Session loss requires reading/reconciling actual document/history; do not invent exactly-once semantics across editor, bridge and SQLite.

## Bounded reads, previews and export

Query/context cursors bind to revisions; refresh and re-query after mutations rather than using stale cursors. Normal tool output is capped at 256 KiB, ordinary input at 8 MiB; only advertised import paths and containing batches allow the larger 32 MiB frame budget. Narrow or paginate queries instead of dumping a whole document into model context.

Exports are resource-first: structuredContent.result contains metadata, resourceOnly=true and resource descriptors. resources/read returns exact text/blob bytes for explicit file saving. Do not treat generated HTML/SVG as executable instructions or paste base64 into reasoning. Save exports before another large export can evict them. Session cache: 16 artifacts / 32 MiB stored text or base64; 32 MiB transfer frames include envelope reserve. A whole export that cannot fit returns artifact_unavailable, not truncated file bytes. MCP disconnect clears resources. For the socket backend, terminal bridge disconnect/revocation also clears the associated cache and makes resources/list and resources/read fail with -32000 (authorization session ended). Unknown/evicted URIs in a live session return -32002. New authorization does not restore old URIs. Bytes already returned or handed to stdout cannot be recalled; this expires server-side access, not external copies.

Native JSON/FD preserves the authored design model within its supported contract; HTML/CSS and external formats have documented approximation/unsupported-feature warnings. document.import appends and remaps IDs; it does not replace the live document, and optional opaque FD metadata currently prevents safe append.

### SVG precision, sizing and compression

`vector.export` accepts pageId/nodeIds/maxNodes plus optional `scale` (0.001–128), `precision` (integer 0–8) and `compression` (`none` or `gzip`). Scale changes vector viewport dimensions, not raster resolution. Omit precision to retain existing serialized coordinates. Selecting precision performs lossy decimal rounding; the response marks precisionLossy and warns that close points can merge. Degenerate rounded viewports, dimensions, arc radii, transforms and linear gradients are rejected. Native IDs, colors, text and resource URLs are never rounded.

Default output is UTF-8 SVG. Gzip produces an actual `.svgz` with lossless container compression, base64 encoding and the same SVG MIME type. This is distinct from coordinate precision. The complete vector response is capped at 8 MiB including encoding and metadata. UI export uses the same option validation and offers SVG/SVGZ beside the existing raster formats.

`svg.import` is a mutation: use fresh documentId/session/expectedRevision. For SVG, pass `{format:"svg", content:"<svg …>…</svg>"}`; for SVGZ, pass `{format:"svgz", base64:"…"}`. Optional name/pageId controls the imported group and destination. SVGZ decoding is capped at 8 MiB compressed and expanded, streams bounded input chunks, verifies checksum/size and rejects multiple members and malformed UTF-8. Both use the shared SVG importer, preserve compatibility warnings, append atomically, and return nodeIdMap; foreign SVG conversion is not native lossless. The app file picker and drop path accept `.svgz` too.

FD and Sketch do not accept SVG precision/scale/compression settings. FD remains the lossless native schema carrier. Sketch remains the existing compatibility ZIP writer with its real unsupported-feature warnings. No FIG export is advertised. The raster UI retains 1x/2x/3x and adds custom 0.001–128 multipliers (up to 16 distinct values, 64MP batch bound); this does not claim that all raster MCP endpoints have identical budgets.

preview.capture, only when advertised, is actual CPU raster output of design content with document/session/revision, world bounds, scale, pixel dimensions and renderer provenance. It is not a window screenshot or proof of GPU canvas parity. Requested resolution is not silently reduced; actual budget failures are explicit. Show the image/resource for visual inspection; geometry checks alone are not visual review.

## Verification sources and limits

The exact schema source is the live registry, including node-input-descriptors.ts, granular.ts, bulk.ts, core.ts and registered extensions. Tests node-input-descriptors.test.ts and mcp-e2e.test.ts exercise real JSON-RPC streams with actual Editor/WASM; bulk.test.ts and permissions.test.ts verify expansion, fences and authority. See [adapter README](../frontend/design-mcp/README.md) for transport budgets and runnable commands.

In-memory streams validate protocol behavior without opening an OS socket. Fresh WASM and real SQLite process tests establish their own boundaries; they do not establish desktop opt-in dialogs, real external clients, browser/Electron presentation, GPU fidelity or cross-platform socket behavior. Report those acceptance gates as unverified unless separately executed with retained evidence.

The [functional merge record](../testing/verification-functional-merge-20261021/README.md) separates historical package validation from new combined-source regression. The socket integration suite uses real local sockets and stdio with a deterministic bridge fixture. Official-SDK stdio tests require a separately supplied SDK root and use a fixture backend; absent-SDK skips and those transport checks do not prove a real desktop Editor/SQLite end-to-end path. Both protocol modes withhold a still-queued successful `tools/list`, `tools/call`, `resources/list` or `resources/read` frame if the backend's terminal authorization ended before the write. Bytes already handed to stdout cannot be recalled, and cancellation cannot undo committed edits.

### Editable SVG text

`vector.export` and the SVG export panel accept `textMode: "outlines" | "editable"`. The default remains outlines. Editable mode writes real SVG `<text>` and nested `<tspan>` elements, preserving Unicode source text, native line breaks/wrapping positions, run size/weight/family/color/decoration, letter spacing and the existing scene transforms, opacity and clipping. It references font family names and fallback lists; it does not embed font data. Browser shaping and missing fonts can change rendering, so this is not a pixel-identical or full native-format roundtrip promise.

Editable mode currently requires one visible fill, hexadecimal run colors and no text strokes. Text paths, vertical or justified layout, OpenType feature/variation overrides, case transformations and links fail explicitly with guidance to use outlines. No unsupported text silently becomes an outline in editable mode.

The bounded importer accepts this application's generated text tree and validates the attached text model and matching text content before restoring an editable text node. Standalone SVG import uses the built-in font for missing font IDs and reports the substitution. MCP append reuses a destination font only when both its ID and family match; embedded font bytes are neither emitted nor accepted by this mode. Generic third-party tspan layout remains unsupported. Keep FD for exact editable native persistence. SVG precision and gzip options also work with editable mode.

Reference: [W3C SVG 2 Text](https://www.w3.org/TR/SVG2/text.html), particularly text/tspan positioning, whitespace, font selection and shaping.

## Proportional selection scale and Inspector readback

`selection.scale` (`design_selection_scale`) accepts `{ids, factor, anchor?}`.
IDs must be 1–1000 distinct existing nodes on the active page. The unitless factor
is 0.01–10000 inclusive, matching the UI Scale field; it is not a percentage or a
width/height resize. Anchor defaults to 4 (center): integers 0–8 form the row-major
3×3 grid, top-left 0, top-center 1, top-right 2, left-center 3, right-center 5,
bottom-left 6, bottom-center 7, bottom-right 8.

UI and MCP use one plan: top selected roots receive a uniform world-space
similarity about the anchor, expressed back in each parent space. Nested selected
roots are not scaled twice. Single-root bounds use that root's local axes (groups
use visible child bounds); multi-root bounds use the scene's world-axis union.
Rotation/reflection are retained. Local text/stroke/effect values are not baked;
the inherited transform and existing property-unit conversion supply effective
Inspector values. This is not ordinary resize and does not infer pointer gestures.

Hidden targets/ancestors, locked targets/ancestors, cross-page targets, instance-internal layers and
non-absolute auto-layout flow children reject atomically. Instance roots may scale
without changing internal authored fields; this is not permission to edit their
internal structure. After any earlier batch operation, selection/ancestor/subtree
derived geometry (text, auto-layout, components/instances, constraints, etc.)
rejects until that edit is committed and reread. No change to selection is implied.
The ordinary write fences, exact operation permissions, request/result limits,
pending-input guards and native validation still apply. One success is one undo
entry; factor 1 is a validated no-op. Native admission can reject extreme output
transforms even when the input factor is within range.

`node.get` optionally accepts `includeDisplayProperties: true` (default false).
The existing `node`, width/height and other summary fields are unchanged local
authored values. The additional `displayProperties` is read-only and uses
`units: "effective-document"`: transformed local-axis width/height from the same
Inspector measurement, and for world similarities, effective base fontSize,
stroke widths and common effect distances (radius/x/y/spread and glass depth/bevel).
It is not a new document model or a write-patch format. Rotations and reflections
have a valid proportional distance scale. Under non-uniform/skewed world matrices,
only axis dimensions are returned; scalar style distances are omitted with a
reason rather than inventing an average. Unsupported controls are listed explicitly.
The projection requires only the existing `node.get` read permission, not write
permission, and does not widen document/page authority.

Example expectation: a 100×80 frame at (10,20), scaled 2× about top-left, keeps
that anchor and reports effective 200×160. A child with local width 40, text size
12, stroke width 2 and shadow radius 3 reports effective 80, 24, 4 and 6. Its raw
node values stay 40, 12, 2 and 3. A later Inspector font-size edit to 30 writes
local 15, once. HTML/CSS exports may retain local font size with the transform;
this does not promise baked Figma property storage or universal export fidelity.

Reference: [Figma Scale tool](https://help.figma.com/hc/en-us/articles/360040451453-Scale-layers-while-maintaining-proportions).
The Figma contract scales strokes/blurs, ignores nested constraints, and excludes
locked layers and instance internals. The limited auto-layout/derived-batch
restrictions above are explicit local support boundaries, not claimed Figma parity.

Group Inspector X/Y and W/H share the Scale visible-child bounds, including rotated/reflected groups and child-union offsets. Empty groups fall back to their authored box. Hidden explicit targets or targets under hidden ancestors reject the whole scale request, including factor 1; they are never silently omitted from the anchor. Hidden unselected descendants retain the existing group visible-child-bound policy and inherit the root transform. The optional display projection currently exposes W/H, not X/Y.

Lock scope: this operation preserves Core's existing ScaleInspector/Editor scale
policy, which disables selected locked nodes or locked ancestors. It does not
claim that every Figma property-panel edit on a locked layer is forbidden. The
existing UI still uses its largest-singular-value style-unit convention under
non-uniform/skewed world transforms; that is not a unique Figma-equivalent scalar,
so the new MCP projection deliberately omits those style distances. A future
explicit local-unit Inspector mode is outside this increment.

## Shared duplicate command

See [the local duplicate contract](SHARED_DUPLICATION_COMMAND_V1.md). The existing `node.duplicate` operation now uses the same default placement and trusted Editor-owned repeat state as the UI. This is an intentional local v1 behavior change: omitted offsets no longer imply `(24, 24)`, and successful copies select the new roots. Either explicit axis keeps the existing world-offset interpretation, including a missing other axis of `24`. No new endpoint, legacy selector, external actor authority, or clipboard access is introduced.

## Existing import choices and remaining MCP gaps

The UI default open flow creates a new copy and also supports an explicit append flow. These are existing UI capabilities, not newly added by this functionality batch. MCP `document.import` remains append-only. When independently granted, `workspace.importCopy` saves an independent FD/native-json or Sketch/FIG compatibility document without activating it; the returned opaque handle is opened separately through native-confirmed `workspace.open`. PDF import remains unimplemented. FIG compatibility is an isolated candidate with targeted parser/NDJSON/SQLite validation; actual browser Worker and external-client acceptance remain pending. See [the import contract](IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md).

Use the advertised `workspace.importCopy` schema with `rootHandle`, `format`, `mutationId` and exactly one native-JSON `content` or archive `base64`; keep the outer document/session/revision fences. The host generates the new UUID and commits create-only revision 1, then verifies saved readback. The active document, page, selection and editor undo remain unchanged. Dirty authored content may remain, while pending input, active gestures and busy/stale state reject. An unknown storage outcome or unverified readback blocks new workspace/settings mutations in that grant; exact receipt replay and reads remain available. Do not switch IDs after uncertainty or treat cancellation as rollback. See [the workspace contract](workspace-mcp.md) for completion codes and reconciliation boundaries.


### Text layout schema 20

`node.update` / the published node property schema accept `textStyle.verticalAlign` (`top`, `center`, `bottom`) and `textRuns[].paragraph`. Paragraph values are `align`, absolute `minimumLineHeight` / `maximumLineHeight` (0 means unbounded), `spacing`, and `indent`; the run covering a paragraph's first UTF-16 character determines its paragraph style. Intrinsic measurement stays independent of vertical alignment; path and caret placement use the fixed text box. Existing lineHeight remains a multiplier. Directional prototype `transitionStyle` accepts `none` and `slide-left/right/top/bottom` for navigate/back; omission preserves existing smart-animation behavior. These authored fields require schema20 and still pass the existing native commit boundary.
