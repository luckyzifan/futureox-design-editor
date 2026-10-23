# Local patch to flo_curves 0.8.1

Source: crates.io flo_curves 0.8.1, Apache-2.0; original LICENSE retained.

`src/bezier/path/ray.rs`: sort ray collisions by the total f64 line parameter only. The former pairwise SMALL_DISTANCE / edges_overlap comparator was non-transitive and panicked in Rust stable sort on the topology Sketch 36-stop board. Existing winding classification still groups coincident/overlapping edges and orders each group according to inside/outside state. No coordinate rounding, curve reduction, clipping tolerance or sampling policy changes.

Validation and provenance: ../../testing/verification-topology-repairs-20261023/README.md.
