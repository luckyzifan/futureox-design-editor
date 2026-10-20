# 2026-10-20 component resolution result allocation

This change addresses one full-document clone in the native component resolver
seen in the [actual FIG CPU profile](../verification-real-electron-flames-20261020/README.md).
It does not remove every clone or establish an end-to-end import speedup.

## Scope and preservation

`components::resolve` previously deep-cloned its entire immutable source into
the result before rebuilding instances. The staged result is now a sorted
`BTreeMap<String, Cow<Node>>`: unchanged nodes borrow from the source, while
rebuilt nodes are owned. Builders continue reading the same immutable source,
even after earlier roots have been staged.

Removal traversal, collision checks, root order, node budgets and per-instance
byte admission use the staged result exactly as before. Before publication,
the complete candidate document is serialized into the existing bounded byte
counter. A serializer adapter delegates to `Document`'s own serialization and
only substitutes its root `nodes` field. It preserves every other field and
its skip rules, including opaque metadata. There is no hash equality shortcut,
schema copy, or hand-maintained JSON byte difference.

After all fallible validation and budget work succeeds, only staged removals
and owned replacements are published. Definition defaults retain their prior
conditional owned source behavior. Errors before publication leave the entire
input document unchanged.

The separate `before = doc.clone()` in `components::changes` remains. Documents
whose component definitions have default properties also retain the conditional
source clone. This change removes the unconditional result clone only.

## Read-only fixture analysis

The existing FIG verification database was opened read-only and its document
copied to a temporary analysis file. It contains 19,959 nodes, 22 component
definitions without properties, 74 outer instance roots and 672 generated
origin nodes. Current instance subtrees contain 746 nodes; 19,213 nodes are
outside those subtrees. The temporary result map still copies all node IDs
(718,524 UTF-8 bytes) and allocates its tree structure, while unchanged node
payloads remain borrowed.

The fixture also contains 12,625 constraints and 7,050 networks. A simplistic
snapshot restricted to component-marked nodes would miss ordinary nodes that
layout can change, so no such candidate-only comparison was introduced.
These are scope counts, not measured timing or memory reductions.

## Verification

From `design-studio`:

```sh
cargo test -p futureox-design-kernel --test components --test component_slots --test variable_modes --test mutation_semantics
cargo test -p futureox-design-kernel --lib components::resolved_document_tests
```

All 47 targeted tests passed on the first candidate compile/run:

| Suite | Passed |
|---|---:|
| components | 24 |
| component_slots | 5 |
| variable_modes | 11 |
| mutation_semantics | 6 |
| borrowed serialization unit test | 1 |

Coverage includes generated-ID collisions; 32 MiB and exponential expansion
budgets; complete rollback on missing references and late override errors;
both borrowed and property-default-owned source paths; new/removed generated
nodes; escaped and Unicode IDs; stable repeated resolution; authored slots;
bindings/modes; dependent geometry; undo and reload. A long unrelated text
payload retains the same heap allocation through two successful resolutions.

The serialization unit test compares complete candidate JSON bytes against a
materialized `Document`, covering borrowed, replaced, removed and new nodes,
empty maps, opaque metadata with a nested `nodes` key, escaped strings and
Unicode. The byte counter accepts exactly that length and rejects one byte
less.

The debug integration compilation took 11.06 seconds; the unit test compilation
took 9.72 seconds. These are compilation observations, not performance results.
The only compilation warning was the existing unused `over_rgba8_blend`.
`git diff --check` passed for both modified Rust files.

The first combined renderer release build and its real-device measurements
were completed before this component candidate was applied. Their binaries do
not contain this change. WASM/native rebuild and matched FIG measurements must
follow before attributing any import-latency improvement to this code.

## Source identity

```text
5b03fad98a8b454ebeef473f6738e0e6ed1cd139647b2e56d21ba1d5c5ef0f9b  design-studio/crates/design-kernel/src/components.rs
63e6b8d59f23c9c9831e5d1aac5160bba77ce86394e4ff984dde86c3bf700ad9  design-studio/crates/design-kernel/tests/components.rs
```

The [repository skill](../../.agents/skills/futureox-design-development/SKILL.md)
and [development contract](../../docs/DEVELOPMENT_CONTRACT_V1.md) continue to
govern build identity, real-device acceptance and release reporting.
