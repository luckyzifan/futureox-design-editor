# Failure-only surface inventory V1

Baseline: `09e6bce9917eef8104957eb67f23583e3a2f52e4`.

This diagnostic patch narrows the remaining surface-budget evidence gap. It does not increase a budget, change reclamation/destruction, resample, alter imageGrid, or repair a rendering failure. It records only when diagnostics are enabled. Existing DEV-only trace code is unchanged; this patch does not remove pre-existing node/stack traces from other debug channels.

## Capture and bounds

`acquire` receives a fixed numeric callsite and optional pass mode. After a successful new allocation or pool borrow, a WeakMap stores the latest pool hand-out's role/callsite/mode. This is NOT a logical owner, allocation age, last GPU write, or reason a texture is still alive. Previously allocated textures without a diagnostic tag remain role 0, honestly unknown. There is no per-frame inventory scan or GPU readback.

The rejected request's tag is attached before recovery. `budgetError` takes a snapshot immediately after the final admission failure and attaches sanitized immutable scalars to that specific Error, preserving wrapper inheritance and existing terminal/message transport. Later renderer mutations cannot change that Error's evidence. Diagnostic exceptions never replace the original allocation failure.

The scanner allows at most 4,096 iterator advances and 1,024 unique physical resource identities. Empty free-pool containers and duplicate aliases consume the iteration budget. These are diagnostic work limits, not render resource limits. Deduplication uses an own-data `texture.resource` object where available, otherwise the Texture object. Alias references do not multiply bytes. Conflicting wrappers are flagged and use the maximum observed byte size; this is not asserted to be exact physical memory.

Sources: busy, free lists, used, coordinate maps, retired uploads, retained interaction textures, images, atlas pages, retired image assets and the renderer's last-used map. Private cache entry arrays and driver internals are not traversed. Membership queries into material/coverage caches are constant-time. No node ID, URI, document key, matrix, pixel or GPU resource handle is emitted.

## Reading the numbers

- `failureSurfaceSnapshotVersion=1` identifies this schema.
- `failureSurfaceUniqueCount/Bytes` describe the observed union, not all allocated VRAM.
- `failureSurfaceScanSteps`, `ScanTruncated`, `ScanError`, `InvalidCount`, `MetadataConflictCount` and `TotalsCapped` describe completeness. Any nonzero warning weakens totals; truncation is not a leak diagnosis. Byte aggregates saturate at 16 GiB and flag saturation.
- `failureSurfaceLedgerResidualBytes = max(0, renderer ledger - observed unique bytes)`. This can include driver scratch, unvisited/unknown textures and accounting differences. `LedgerOvercountBytes` reports the opposite discrepancy. Neither proves a leak or reclaimable memory. The existing renderer ledger is authoritative for its admission policy, not hardware VRAM consumption.
- Busy/Free/Used/Pinned/Overlap/AliasProtected each have Count/Bytes. These overlap and MUST NOT be summed. Used means tracked in the current frame's commands. Pinned means only the known renderer pin sets, retained interaction membership or alias count >1. Driver-private/cache pins are not comprehensively inventoried, so absence does not grant permission to destroy anything.
- Free-pool `PoolCompleted`, `PoolPending`, `PoolEpochUnknown` Count/Bytes classify the recorded release epoch against the driver's completed epoch. This alone is not a reclamation proof and does not override used/pin/ordering rules.
- `ClassNCount/Bytes` use mutually exclusive precedence over the observed union: 1 material cache, 2 coverage cache, 3 interaction, 4 coordinate, 5 retired upload/asset, 6 image/atlas, 7 free, 8 remaining busy, 9 other. Higher priority wins; this does not make caches exclusive lifetime owners. Material-cache accounting elsewhere can include metadata and must not be added as another texture total.
- `RoleNCount/Bytes` classify the most recent tagged hand-out: 0 unknown, 1 empty/zero initialization, 2 generic pass output, 3 coverage/mask, 4 image regional output, 5 filter output/intermediate, 6 display frame, 7 texture replay, 8 byte-shadow output/source, 9 painter-stage copy, 10 atlas page. Generic pass outputs remain generic in aggregate; this is not a full live dependency graph.
- `SizeNCount/Bytes` bucket maximum physical side: 1 <=512, 2 <=1024, 3 <=2048, 4 <=4096, 5 >4096. Invalid dimensions are separately flagged.
- `LargestBytes/Width/Height/Role/Callsite/PassMode` identify the largest observed physical texture, not necessarily the cause of pressure. Equal-sized ties use scan order.
- An omitted aggregate means zero only for a complete, valid scan. Truncated/error results are partial lower-bound observations where applicable.

## Rejected allocation and fixed callsites

`failureAllocationCallsite` and `failureAllocationRole` identify the attempted allocation. `failureAllocationPassMode` is 0 unknown/not a generic pass, otherwise the code-controlled pass mode plus one (mode 0 becomes 1). `failureAllocationKind` retains its existing separate meaning. Non-acquire budget errors may have callsite 0.

Callsites: 0 unknown; 1 transparentZero; 2 empty; 3 painterExpand; 4 painterCrop; 5 passOutput; 6 pathCoverage; 7 nodeMask; 8 boundedImageOutput; 9 streamImageOutput; 10 streamImageBefore; 11 streamImageSource; 12 filterSourceMask; 13 byteShadowOutput; 14 byteShadowSource; 15 filterImageMask; 16 isolatedHorizontal; 17 filterTableResolve; 18 filterRegionResolve; 19 isolatedBlurOutput; 20 displayMaterialMask; 21 displayImageMask; 22 sequentialFrame; 23 displayBackdropStripReuse; 24 displayBackdropStripNew; 25 displayBackdropSource; 26 displayBackdropHorizontal; 27 displayBackdropOutput; 28 textureReplayOutput; 29 atlasPage.

28 acquire callsites and the existing atlas creation site are tagged. The atlas allocation/check order and all rendering/resource behavior remain unchanged.

## Validation scope

Tests exercise actual `acquire`/`run` budget rejection, pool reuse, retain/release alias protection, immutable Error ownership, failed-inventory isolation and disabled diagnostic fast paths. Pure scanner tests cover physical alias deduplication, overlapping membership, mutually exclusive classes, pool epochs, iteration/unique bounds, empty containers, invalid values, own-data allowlists, saturation and real Node MessageChannel transport.

These are CPU/fake-driver tests. No production build, hardware GPU pixels, actual Electron Worker or complete 117 replay is claimed. The additional fields require a new reproduction; prior requests 93/108/176 cannot acquire missing ownership information retrospectively.
