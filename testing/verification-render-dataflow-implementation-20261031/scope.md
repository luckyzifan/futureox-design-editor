# Implementation scope

Implement the deep audit's proven work-reduction items in dependency order: identity resize, per-decoder color preparation and row lifetime, read-only Grid queries, immutable geometry/cold payload storage and capacity, packet work/ownership, and demand-driven filter setup. Preserve source math, endian formats, budgets, document/scene ownership, cancellation and fallbacks. Do not adopt metadata-only incomplete Engine or copy the erroneous Sketch blur scale table.

Frozen preimage includes earlier uncommitted source-work-reuse changes. Case oracles: exact authored JSON/store receipts, f64/float pixel bits where original exact contract applies, current approved SDR display error gate only for its existing scope. No global precision/budget change.

G1 native+portable rebuild after kernel changes; G3 targeted model/history/serialization/color/layout/pixel regressions; G6 preimage counterexamples and source/product hashes; G7 cancellation/partial upload/lifetime. Real topology snapshot (124447 nodes) memory and native startup are separate from small synthetic and GUI/GPU gates. At most two build jobs; performance A/B sequential without concurrent heavy build. Full G2/G5 remain individually recorded, not inferred from tests.

Status and implementation decisions are recorded in WORKLOG.md.
