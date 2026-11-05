# Figma-shaped MCP facade — 2026-11-02

The facade translates eight Figma-shaped tool names into the existing Design API. It does not add those names to the shared operation registry, does not eval plugin source, and does not change raster, tile, or navigation paths.

## Ran

- `frontend/design-mcp`: `node --test test/figma-facade.test.mjs test/figma-http.test.mjs` — 14 passed. `test/server.test.mjs` and `test/operation-backend.test.mjs` also passed.
- `frontend/design-desktop`: `node --test test/figma-mcp-host.test.mjs test/automation-bridge.test.mjs` — the new host tests passed, and the existing in-memory bridge tests passed.

Handler tests use a fake `execute`. The HTTP test binds `127.0.0.1` and checks the bearer token. The desktop test uses a fake listener plus one real local socket created by `bridge.enable`.

## Not run

No Electron GUI pass. No Cursor or Codex client. No plugin-host bridge, because that host is not in this tree. No GPU screenshot comparison. 33/100ms and full G2/G5 are unchanged.
