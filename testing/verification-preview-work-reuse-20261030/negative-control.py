"""Run the same component assertions against the frozen pre-edit component."""
from pathlib import Path
import json
import subprocess

out = Path(__file__).resolve().parent
repo = out.parent.parent
test = repo / 'frontend/design-client/src/canvas-edit-preview.test.mjs'
preimage = out / 'before/frontend/design-client/src/CanvasEditPreview.tsx'
source = test.read_text().replace('import.meta.url', json.dumps(test.as_uri()))
source = source.replace("readFileSync(componentUrl, 'utf8')", f"readFileSync(new URL({json.dumps(preimage.as_uri())}), 'utf8')")
run = subprocess.run(['/Users/Apple/.nvm/versions/node/v24.12.0/bin/node', '--input-type=module', '-'],
                     input=source, text=True, cwd=test.parent, capture_output=True)
output = run.stdout + run.stderr
(out / 'component-negative.log').write_text(output)
expected = [
    'preferred SVG prepares no bitmap or split-document plan until a fallback is displayed',
    'continuous camera input performs no copy and captures only the final quiet presentation',
    'deferred capture rejects stale cameras, sessions, sizes, DPR, preview frames and replaced presentations',
]
assert run.returncode != 0, 'preimage unexpectedly passed'
for name in expected:
    assert f'✖ {name}' in output, f'missing regression assertion: {name}'
assert 'ERR_MODULE_NOT_FOUND' not in output and 'ERR_INVALID_ARG_VALUE' not in output, output
result = {'exit_code': run.returncode, 'expected_failures': expected,
          'evidence': 'CPU mock: same production component boundary test, frozen preimage implementation'}
(out / 'component-negative.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
