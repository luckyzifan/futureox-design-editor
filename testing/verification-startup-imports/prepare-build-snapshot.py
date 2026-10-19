#!/usr/bin/env python3
"""Freeze both comparison inputs without changing the working tree or public assets.

Usage: python3 prepare-build-snapshot.py /absolute/path/to/new-workspace
Then: node compare-builds.mjs /absolute/path/to/new-workspace
"""
from pathlib import Path
import hashlib
import json
import shutil
import sys

evidence = Path(__file__).resolve().parent
repo = evidence.parent.parent
workspace = Path(sys.argv[1]).resolve()
workspace.mkdir(parents=True, exist_ok=False)
before = workspace / 'before'
client = before / 'frontend/design-client'
for relative in ['frontend/design-client/src', 'design-studio/crates/design-kernel/shaders']:
    shutil.copytree(repo / relative, before / relative)
for name in ['index.html', 'package.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json']:
    shutil.copy2(repo / 'frontend/design-client' / name, client / name)
(client / 'node_modules').symlink_to((repo / 'frontend/design-client/node_modules').resolve(), target_is_directory=True)

frozen = (evidence / 'import-svg.before.ts').read_text()
assert hashlib.sha256(frozen.encode()).hexdigest() == '1c00e9d6b5b3c0c556dcc1da364c459f85545dec612bb99aff5cb8719e5fc556'
# Derive the exact expected extraction. Refuse to accidentally compare unrelated
# later importer changes against this historical parser baseline.
start = frozen.index('export function pathNetwork(')
end = frozen.index('export function svgTransform(', start)
expected = (frozen[:start] + frozen[end:]).replace("import { SVGPathData } from 'svg-pathdata'\n", '').replace('  uid,\n', '').replace('  type Network,\n', '')
expected = expected.replace("import { parseSvgViewBox, svgViewportTransform } from './import-svg-viewport'\n", "import { parseSvgViewBox, svgViewportTransform } from './import-svg-viewport'\nimport { pathNetwork } from './path-network'\nexport { pathNetwork } from './path-network'\n")
assert (client / 'src/import-svg.ts').read_text() == expected, 'Importer has unrelated changes; review and update the controlled comparison first'
(client / 'src/import-svg.ts').write_text(frozen)
for name in ['engine.ts', 'editable-network.ts']:
    file = client / 'src' / name
    source = file.read_text()
    assert source.count("import { pathNetwork } from './path-network'") == 1
    file.write_text(source.replace("import { pathNetwork } from './path-network'", "import { pathNetwork } from './import-svg'"))
# path-network.ts can remain unused in the baseline copy; Vite does not import it.
manifest = {str(p.relative_to(before)): hashlib.sha256(p.read_bytes()).hexdigest() for p in before.rglob('*') if p.is_file() and not p.is_symlink()}
(workspace / 'snapshot-inputs.before.json').write_text(json.dumps({'files': manifest}, indent=2) + '\n')
print(f'Frozen {len(manifest)} inputs in {before}')
