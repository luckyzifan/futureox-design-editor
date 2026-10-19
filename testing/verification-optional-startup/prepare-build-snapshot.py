#!/usr/bin/env python3
"""Freeze a metadata-extraction comparison without mutating live build assets."""
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
for name in ['index.html', 'package.json', 'bun.lock', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json']:
    shutil.copy2(repo / 'frontend/design-client' / name, client / name)
(client / 'node_modules').symlink_to((repo / 'frontend/design-client/node_modules').resolve(), target_is_directory=True)
frozen = (evidence / 'export.before.tsx').read_text()
assert hashlib.sha256(frozen.encode()).hexdigest() == '0d3804590084e0b43e486a23ed1876455e1f1788ff8624f3cfbb75559a4f83de'
start = frozen.index('export type ExportTarget =')
end = frozen.index('function projectSlice(', start)
pdf_start = frozen.index('/** Content the true-vector PDF writer')
pdf_end = frozen.index('/** Explicit visual exchange mode.', pdf_start)
expected = (frozen[:pdf_start] + frozen[pdf_end:])
expected = expected[:start] + expected[end:]
expected = expected.replace(', worldMatrix, inverse', ', inverse').replace(', type Matrix', '')
expected = expected.replace("import { KernelClient } from './kernel/client'", "import { KernelClient } from './kernel/client'\nimport { pdfVectorIssues, type ExportTarget } from './export-metadata'\n// Keep the existing synchronous public exports; UI-only metadata callers can\n// use the light module without pulling React's SVG serializer into startup.\nexport { pdfVectorIssues, sliceExportTarget, type ExportTarget } from './export-metadata'")
assert (client / 'src/export.tsx').read_text() == expected, 'Unrelated export changes require a new reviewed baseline'
(client / 'src/export.tsx').write_text(frozen)
for name in ['ExportPanel.tsx', 'NodeExportPanel.tsx', 'clipboard-export.ts']:
    file = client / 'src' / name
    source = file.read_text()
    assert source.count("from './export-metadata'") == 1
    file.write_text(source.replace("from './export-metadata'", "from './export'"))
# Reconstruct only the UI boundary for the second measured stage, preserving
# current unrelated App/dialog source in each controlled before/after pair.
app = client / 'src/App.tsx'
source = app.read_text()
assert source.count("import { AutomationPanel } from './AutomationPanelLauncher'") == 1
app.write_text(source.replace("import { AutomationPanel } from './AutomationPanelLauncher'", "import { AutomationPanel } from './AutomationPanel'"))
panel = client / 'src/AutomationPanel.tsx'
source = panel.read_text()
compatibility = "// Compatibility entry: callers keep the same public button component while\n// App imports its lightweight launcher without loading this optional dialog.\nexport { AutomationPanel } from './AutomationPanelLauncher'\n"
original = (evidence / 'AutomationPanel.before.tsx').read_text()
wrapper = original[original.index('export function AutomationPanel('):original.index('export function AutomationDialog(')]
assert source.count(compatibility) == 1
panel.write_text(source.replace(compatibility, wrapper))
manifest = {str(p.relative_to(before)): hashlib.sha256(p.read_bytes()).hexdigest() for p in before.rglob('*') if p.is_file() and not p.is_symlink()}
(workspace / 'snapshot-inputs.before.json').write_text(json.dumps({'files': manifest}, indent=2) + '\n')
print(f'Frozen {len(manifest)} inputs in {before}')
