# Batch regression integrate — 2026-11-02

One branch on top of `main` (`63ad10c`) for GUI regression. This branch is not merged into `main`. Every commit message on the branch includes `[skip ci]`.

Accent stays `#3459d4`. Canvas selection strokes stay the existing selection blue. There is no collaboration server. The floating Design API chip is not mounted on the Electron home, the editor footer, or the web shell. Desktop automation registration stays in the app without that chip. The canvas right-click menu is the dark Figma desktop menu (charcoal surface, blue hover).

## Merge order

1. #14 `.fig` import (non-uniform borders recorded, schema 21 text metrics kept)
2. #16 document pages, styles, component sets, hidden pages (with #14 stroke and effect notes)
3. #15 font catalog, weight matching, substitution
4. #12 frame hits, double-click, marquee
5. #18 clockwise rotation, paste/duplicate step of 10, stored corner radius
6. #19 layers, properties, context menu (clockwise field shares #18’s sign; layer rows stay on the accent)
7. #25 `.fd` number variants and ignored fields
8. #23 Display P3 export tags and multiplied layer opacity
9. #21 glass, corner-radius, and gradient handles
10. #22 red spacing guides, boolean layout, independent corners
11. #27 page chrome (localized page list still hides internal Figma canvases; glass and gradient handles from #21 stay)
12. #26 pen, eraser, and frame/page jumps (jumps use visible pages)
13. #29 later pen and eraser behavior (Escape keeps an open path on the pen; #26 jumps stay)
14. #20 shared editor chrome
15. #24 warm paper surfaces, with the blue accent and #20 desk layout kept
16. #28 local plugin autoload
17. #30 Electron SQLite workers
18. #31 zoom and drag skip full-document panel serialization (the clockwise angle still uses the live rotation channel)

## Plugin host

`main` already had the worker plugin host from #7. #28 autoload stays on that panel: startup scan, declared folder list, and the Plugins menu.

#13 is the fuller runtime (SVG, images, variables, plugin data, client storage, declared-domain fetch). Its sources live in `frontend/design-client/src/plugins/rich-host/` and the panel runs plugins through that QuickJS host. The older worker session remains for its existing tests and is not what the panel executes.

#8 is the earlier subset of #13 and is not merged again.

#17 is not merged. It replaces the same host with a Rust `plugin_api` and a smaller API surface. Taking it would drop #13’s SVG, image, variable, and fetch behavior and fight the autoload panel.

## Not re-applied

These were already on `main` before this integrate: #2–#7, #9–#11 (zoom coverage, locale and tabs, chrome ops, large topology, sRGB text metrics, the first plugin host, canvas drag, the MCP facade, web/desktop parity).

## Checks

The dev WASM kernel is not built in this environment, so the editor vitest suite was not rerun. The #13 sample manifest parses with the rich-host parser. `frontend/design-client` dependencies resolve, including `quickjs-emscripten@0.32.0`.

33/100ms and full G2/G5 are not claimed.
