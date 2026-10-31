# Scope frozen before edits

Target: redundant Sketch root dependency walks, retained-root clone, geometry-only scene record clones, allocation of size/index JSON buffers, duplicate field opens, linear child deduplication. Full source Engine remains authoritative; do not replace its complete document with a metadata shell. No raster/sampling/math/budget changes.

G0/G4 startup source-open, snapshot-conversion and native-load are measured separately on the existing topology source. Existing 3.88s is whole native load, not a source-read-only profile. Freeze same source hash, owner IDs, release toolchain and configuration for paired runs. Use exact snapshot bytes/header/Merkle hashes, root order, owned original Value and model/packet/CPU pixels as equality oracles. Existing limits and cancellation failures must stay unchanged. No speed threshold for a whole-app claim is defined; full G2/G5 remain NOT_RUN.

Tests: affected native scene_store/preparation/source_compile and backend large_document suites, frozen old/new actual startup A/B when local products build. At most two build jobs, no performance run during heavy tests/build. Cancellation, failed files, missing images/components, source revision and cleanup keep existing scope. If byte/model parity fails, stop promoting that candidate and fix/revert it.
