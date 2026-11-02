# FD native round-trip (2026-11-02)

This increment hardens the `.fd` container (format 2). It does not change raster, tile navigation, GPU budgets, or experimental render flags. It does not close 33 ms visible P95, 100 ms refinement, or full G2/G5.

## What changed

Format 2 still uses the same magic, version, truncated SHA-256, and value tags. The number writer now follows serde_json's storage variant (`is_u64` / `is_i64` / `is_f64`) instead of `as_u64` / `as_i64`. Those coercions turned signed zero into integer `0` and integer-valued floats such as `1.0` into integers. `Value::PartialEq` treats those as equal, so the older precision test did not catch it. Finite f64 bits, including both signed zeros, round-trip. `u64::MAX` and `i64::MIN` stay integers. Zigzag of `i64::MIN` uses unsigned bits so a debug build does not overflow on `i64::MIN << 1`. Non-finite numbers fail encode instead of being written as `0`. Lengths that do not fit in `usize` fail before a truncating cast. A string-table entry that is not UTF-8 is reported as malformed text rather than a truncated file.

`encode_authored_json` and `decode_authored_json` are the shared portable entry. `binfmt_encode` / `binfmt_decode` and `forma_encode_json` / `forma_decode_json` both validate the typed document and then keep the authored value: fields the kernel ignores, explicit nulls, and `fdCompatibility` payloads. The previous `binfmt_*` path re-serialized the typed document and dropped those. Required capabilities are still rejected. Unknown fields on structs that deny them, such as ruler guides, still fail admission. Nothing in the file registers a handler.

Files written by the old encoder remain readable. An integer-valued float that was stored as an integer stays an integer; the sign bit was not in that file.

The editor codec `json-stringify-v1` is still `JSON.stringify`. `frontend/design-desktop/test/preparation.test.mjs` requires a document containing `-0` to serialize as `JSON.stringify`, which emits `0`. That canonicalization happens before the kernel encoder. A JSON string that still contains `-0.0` (Rust `serde_json::to_string`, or a value that has not passed through `JSON.stringify`) keeps the sign in the `.fd` bytes.

## Checks

Ran from `design-studio` with `CARGO_NET_OFFLINE=true` after the crates.io index was already populated. The checked-in `.cargo/config.toml` mirror was set aside for that command and restored afterward.

- `cargo test -p futureox-design-kernel --lib binfmt::tests` — 12 passed.
- `cargo test -p futureox-design-kernel --lib fd_extensions::tests` — 4 passed.
- `cargo test -p futureox-design-kernel --test document_admission` — 3 passed.

`authored_json_keeps_ignored_fields_nulls_and_extension_numbers` checks an ignored root field, an ignored node field, an explicit null, signed-zero opacity, and a signed-zero extension payload. A ruler guide with an extra field is rejected. A required capability is rejected. `futureox-design-desktop-backend` was not typechecked here; its extra crates were not in the offline cache. The save call site uses the same `BackendError::new` shape as the other document errors in `storage.rs`.

WASM under `frontend/design-client/src/generated/` is not rebuilt in this run. Frontend tests that load that bundle do not yet execute the new encoder. The Rust tests above call the same `encode_authored_json` / `decode_value` functions the WASM entry points wrap.

No GUI, hardware GPU, or whole-editor timing was run.
