# Sketch format adapter

`futureox-design-kernel` is the single application kernel. Its shared `scene::Document`, editing operations, Graph history, geometry, fonts and renderer serve both Web and Electron.

This module retains Sketch source archives, unknown JSON fields and resources for format inspection and native round trips. `Session` and the legacy `kernelId: "sketch"` are archive-session protocol compatibility, not an alternate editor engine. `preview` projects retained source data through the shared rendering vocabulary.

Application import uses `interop::import_sketch_report` (WASM `import_sketch_json`) and returns `{ document, warnings }` after shared admission. It converts normalized paths to local pixels, separates source metadata from executable variable bindings, explicitly substitutes fonts not embedded in the archive, and retains original zero-size bounds while providing a minimal selection box. Format metadata lives in `designSystem.sketchContainers.nodeMetadata`; it must never participate in variable resolution or authorization. The low-level `interop::import_sketch` remains a compatibility codec for existing tooling.

Application export uses WASM `export_sketch_json`, validates the shared document, and returns a compatibility archive. Keep the original `.sketch` file: mapping into the editable model is not a guarantee of complete Sketch fidelity.

Native archive saves preserve raw JSON fragments for unchanged values, including unknown integers and fractions outside `f64` precision. This uses `serde_json::raw_value`, without globally changing numeric decoding with `arbitrary_precision`. `Layer::fields()` is a semantic projection; use `native_field_json` when exact source JSON is required.

Focused regression:

```sh
cargo test --locked -p futureox-design-kernel --lib --test sketch_import_admission --test sketch_native_native_contract --test sketch_native_text_contract --test sketch_native_flip_contract --test sketch_native_resize_ancestry_contract --test sketch_native_preview_contract --test sketch_native_display
cargo test --locked -p futureox-design-desktop-backend
```
