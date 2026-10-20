# Local import/provenance/coverage verification

Run from any working directory:

```sh
bash testing/verification-import-local-contracts/verify.sh \
  /absolute/evidence-directory EXPECTED_CURRENT_WASM_SHA256
```

The command checks full frontend TypeScript, the targeted and adjacent regression
suites, the actual WASM identity, and reproducibility of
`docs/OPERATION_COVERAGE_V1.json`. It uses existing frontend dependencies and does
not install software, connect a service, start an HTTP/socket listener, change
grants, or duplicate font/WASM/fixture assets.

Verified paths include actual Editor/Rust-WASM native history, source tags,
FIG/Sketch codecs, repeat import isolation, exact receipts versus new import
intent, atomic rejection, and in-memory NDJSON MCP. The coverage generator
constructs a full local catalog without activating any native permission.
Its read-only/no-host-grants case separately verifies filtering.

No browser/Electron GUI, real Worker transport, real sockets, GPU presentation,
or external MCP-client interoperability is asserted. The existing real-117
Sketch append fixture test skips unless `SKETCH_FIXTURE` is explicitly provided.
Tests with simulated workers/transport are not actual platform acceptance.

Read [the maintained contract](../../docs/IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md)
for supported and intentionally unsupported semantics.
