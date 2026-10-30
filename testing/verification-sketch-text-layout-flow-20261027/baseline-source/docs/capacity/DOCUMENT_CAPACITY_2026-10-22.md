# Resource-aware local document capacity

## Frame resources, 2026-10-25

The native FGSC producer and JavaScript frame-resource receiver no longer have
a fixed 32 MiB retention ceiling. Both use the trusted startup `memoryBytes`
policy already pinned for their runtime. Documents and packet metadata cannot
raise it. Native immutable resources and the retained same-request frame share
that native allowance; cache statistics report the actual limit and its source.
JavaScript retains charges for retired resources until every outstanding ACK
cohort releases them, including retransmission of a previously evicted entry.

This explicitly requested capacity change is separate from a performance result.
It does not change GPU working-set admission, single-resource/device limits,
sampling, effects or export precision. Per-runtime cache accounting is not a
process-wide RSS guarantee. The earlier document/source policy below still
applies independently.

Candidate based on main 5494bb50. This describes implementation and remaining
limits, not an unlimited-memory or production acceptance claim. See the final
verification record for exact build hashes, completed tests and actual ten-copy
117.sketch results.

## The failure and scope

Six appended copies of the real 117.sketch produced 4,518 nodes and 30,273,705
serialized bytes. The seventh was rejected atomically by the old 32 MiB native
editing guard, independently of GPU memory. That byte ceiling was duplicated in
admission, layout, component resolution, renderer loading and patches, FD,
desktop codec/storage and preparation. TS/native also had aggregate 20,000-node
and 100-page product quotas. Changing only one constant would not fix open,
edit, save and reopen coherently.

The candidate replaces those accumulated-document guards with one pinned
trusted resource policy. It does not raise MCP network frame budgets or turn
off hostile archive validation. A request frame is not a document size.

## Policy and ownership

- The desktop samples machine/container available memory at startup, reserves
  headroom, and passes the exact `memoryBytes` to backend and preparation child
  processes and the frozen preload bridge. Children do not independently resample
  free memory after the app has already consumed it.
- The main frontend pins that policy before WASM admission. Owned render,
  preparation and import workers receive the same value in bootstrap messages.
  Documents, file metadata and MCP parameters cannot configure it.
- The current serialized document allowance is `floor(memoryBytes / 16)`.
  The factor reserves heuristic headroom for the JSON source, parsed model,
  isolated drafts, history and render representations. It is **not** a measured
  RSS bound, allocation guarantee or promise against process OOM.
- Model count safety checks derive from the same working memory (`/4096` nodes,
  `/1024` pages), rather than fixed commercial quotas. These estimates are coarse;
  exact serialized bytes, per-field constraints and full graph validation also
  apply. All counts must be finite safe integers on the frontend.
- The separate native `DocumentEditor` retains its 80-entry patch policy with a
  byte allowance of one quarter of working memory. The live frontend `GraphApi`
  path is different: its unchanged 128-entry history shares `Arc`/persistent
  NodeStore records, while cloning non-node base metadata. TS history shares
  immutable authored records. Neither is a process-wide resident-memory budget.
  Retention may evict oldest entries under each existing timeline policy.
- Browser/Node hosts use available runtime resource information. Browser heap and
  device-memory reports are coarse hints, not free-RAM measurements. If none is
  available the explicit conservative fallback is 512 MiB working memory, yielding
  32 MiB serialized capacity. That fallback is reported as unknown-runtime policy,
  not silently described as a product quota or unlimited capacity.
- Rejection reports the effective resource allowance and keeps the current
  document uncommitted. Policy is immutable during a process session. More memory
  requires a new trusted startup, not an untrusted file asking for more.

## Current architectural ceiling

This application still uses whole-document JSON/typed models in wasm32. The
shared portable policy cannot exceed 4 GiB linear addressability; that is distinct
from available machine memory. The representation reserve therefore also bounds
admitted document bytes. This is a current shared WASM architecture limit, not a
claim that native 64-bit systems physically have only 4 GiB or that arbitrary
large projects are now supported.

No policy can make RAM, disk, JS strings, SQLite values or individual GPU resources
unlimited. Exhaustion outside a fallible allocator can still terminate a process.
The candidate improves admission and reports predictable failures; it does not
implement a paged/out-of-core document model. Durable CAS, edit atomicity,
checksums and identity ownership are unchanged.

## Allocation and transport changes

- Exact TS UTF-8 sizing scans code units without allocating a document-sized
  `TextEncoder` byte array. Surrogate pairs and invalid lone surrogates match the
  platform encoder's byte count.
- FD decoding borrows the source string table, checks the table resource cost and
  uses fallible reservations before allocating the table and expanded strings.
  Expanded references retain their independent accounting and nesting checks.
- FD encoding avoids two redundant string-table buffers. FD typed validation
  deserializes the value tree by reference instead of cloning it wholesale, then
  explicitly drops the typed validation graph before allocating output bytes.
  Unknown authored fields remain in Value. These are allocation reductions,
  **not** a streaming FD codec.
- Desktop document-bearing operations use bounded multipart transfer behind the
  existing host adapter. Each transport frame remains bounded. The complete
  document still consumes bounded working memory when assembled and parsed.
  Preparation input uses a separate bounded multipart route for the same reason.
- Native byte counters use serializers writing to counters, not discarded JSON
  buffers. Component expansion and local edits use the shared resource allowance
  before atomic publication.

## Audited 32 MiB checks

Replaced document-capacity gates: kernel `lib`, `editing`, `layout`, `components`,
`renderer`, `preparation`, `binfmt`; TS `document-admission`, `desktop-session`,
native FD/JSON file picking, and preparation snapshot proofs; desktop codec,
preparation and backend file/workspace/recovery policy. Native/TS model aggregate
node/page checks, paste-over destination aggregate checks and styled-text derived
span counts are resource-derived. Automation insertion indices use safe integers
and the actual destination list length, not 20,000. MCP Sketch accumulation and FD
expanded data no longer reuse the frame size as an editable-document quota.

Deliberately retained independent security/format/retention limits:

- MCP 32 MiB explicit transfer frames, 8 MiB ordinary request budget, bounded
  output/resource caches, import-copy carrier limits and request concurrency.
  Many bounded appends may grow an accepted document beyond any one frame.
  An artifact too large for MCP still requires native export; no truncation.
- External Sketch/FIG/PDF picker and codecs retain their input/ZIP expansion,
  ratio, member count, per-entry, CRC/path and malformed-input protections.
  SVG/SVGZ have their own compressed/expanded rules. Native FD/JSON file picking
  instead uses document resource admission.
- Native compressed op frames retain a 32 MiB expanded-frame limit. A very
  large single op batch may reject even when its destination document is valid;
  whole-document replacement is a separate history route. Chunked op transactions
  require their own atomic protocol, not removal of decompression defenses.
- Clipboard packets/paste expansion, component-library import carriers,
  embedded-font parsing and individual
  resource limits, opaque extension metadata bounds, node graph depth/cycle
  checks, individual text/vector/effect restrictions and operation-specific
  validation remain independent. Large documents do not authorize giant hostile
  single objects or an unbounded automation batch.
- Catalog DB and export-cache limits; GPU field/program/page/snapshot caches;
  image-table working-set budgets; native GPU CLI file inputs; server HTTP body
  limits; render diagnostics counters. These are not local authored-document
  admission. A 32 MiB optional cache may decline reuse without rejecting a document.

## Remaining feature and process bounds

The audit still found separate feature-level aggregate restrictions, not all of
which are untrusted-input defenses: global guides at 20,000, design-system font
source maps at 20,000, prototype interaction-owner maps at 20,000, component-slot
roots at 20,000, and external Sketch override traversal at 20,000. Design-system
collections/variables/styles/libraries also retain existing cardinality limits.
These require independent feature contract and test work; this patch does not
claim that every commercial feature quota has been eliminated.
The non-floating solid-batch GPU path also had a 20,000-instance run/arena
threshold that could reject an otherwise admitted scene. Its independent renderer
fix and tests must be included before claiming large flat-scene rendering works;
it is not a legitimate document admission or untrusted-input defense.

Automation receipt storage remains 128 results / 32 MiB per document session.
The obsolete 20,000 generated-ID estimate is removed. Actual resolved IDs are
measured after native materialization and before the Editor history commit;
in-flight bytes, slots and mutation identities are reserved. A result that cannot
fit rejects before mutation, while exact lost-response retries retain the original
result. Deliberately closing/replacing a session can still invalidate its receipts.
Large results will eventually need a separate compact/paginated return contract,
not a larger unbounded receipt cache.

SaveCoordinator currently clones each queued explicit save to preserve its body
and identity if a caller mutates the input. It has no aggregate pending-snapshot
byte budget. Coalescing distinct explicit versions would change durability and
must not be silently substituted. Fonts, history metadata, concurrent workers,
queued saves, expanded values and rendering allocations are not covered by one
measured shared resident-memory accountant. The /16 reserve is therefore only
admission headroom, not enforcement of a global application RAM limit.

## Verification to run on the combined build

1. Rebuild actual WASM and native desktop binaries from the candidate, not stale
   generated output. Compare main/worker/host effective policy values.
2. Exact resource threshold and malformed/UTF-8/unsafe expansion tests.
3. Actual >32 MiB native JSON admission and byte-preserving FD roundtrip; aggregate
   >20,000 nodes/>100 pages under available resource admission.
4. Ten actual 117 imports through Editor.appendDocument, preserving all 7,530
   nodes, original snapshots, native undo/redo, same-page root count and identity.
5. Native FD save/reopen and actual desktop multipart file/workspace persistence,
   revision CAS and cancellation/failure isolation.
6. Ordinary MCP append into an already >32 MiB destination; frame/ZIP/clipboard
   rejection tests still pass. An allowed frame is not automatic permission to
   exceed resource admission.

A paged document model with per-page/asset persistent chunks, incremental
admission and bounded materialization would be a separate architectural change.
It must preserve arbitrary authored values, references, history, native FD
compatibility and atomic commits, rather than merely substituting a higher cap.


## macOS native startup detection, 2026-10-26

Native macOS processes without an inherited launch policy now query available
memory from the fixed macOS `/usr/bin/vm_stat` utility, without a shell or PATH
lookup. It counts free + inactive pages using the reported page size, without
subtracting compressed memory a second time. Malformed/failed readings use the
existing unknown-runtime fallback.
They retain the existing half-memory headroom, wasm32 ceiling, 16× document
reserve and once-per-process pin. The kernel still forbids unsafe code. Explicit
trusted overrides retain their precedence and fail-closed validation. Electron
continues passing its exact startup policy to every participant.

A small actual available-memory reading can still yield a small document
allowance. Large source pages therefore use explicit consecutive working sets;
this is separate from raising a budget or claiming a full-page live scene.
See [the measured regression record](../../testing/verification-source-page-load-20261026/README.md).
