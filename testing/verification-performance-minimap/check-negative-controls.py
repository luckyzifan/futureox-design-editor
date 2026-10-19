"""Run real feature-restoration mutations in an isolated source copy.

Never edits the working checkout. Uses existing dependency/WASM/font artifacts;
no install, Rust build, browser, socket, or GPU process is started.
"""
from pathlib import Path
import hashlib, json, re, shutil, subprocess, tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CLIENT = REPO / 'frontend/design-client'
old = subprocess.check_output(['git', 'show', 'HEAD:frontend/design-client/src/CanvasMinimap.tsx'], cwd=REPO, text=True)
original_canvas = (CLIENT / 'src/Canvas.tsx').read_text()
mount = '<CanvasMinimap editor={editor} entries={entries} view={displayView} size={size}/>'
marker = '      <CanvasGuides editor={editor} view={displayView} size={size} intercept={e=>{'
assert original_canvas.count(marker) == 1
results = []
with tempfile.TemporaryDirectory(prefix='design-minimap-negative-') as directory:
    isolated = Path(directory)
    shutil.copytree(CLIENT / 'src', isolated / 'src')
    for name in ('package.json', 'vitest.config.ts', 'tsconfig.json'):
        shutil.copy2(CLIENT / name, isolated / name)
    for name in ('node_modules', 'public'):
        (isolated / name).symlink_to((CLIENT / name).resolve(), target_is_directory=True)
    (isolated / 'src/CanvasMinimap.tsx').write_text(old)
    for name, insertion in [
        ('restore-old-mount', f'      {mount}\n'),
        # A CSS-hidden overview that only appears after a navigation update
        # must fail the allocation/draw assertion, not merely a DOM query.
        ('restore-hidden-after-pan', f'      {{state.view.x !== 0 && <div style={{{{display:"none"}}}}>{mount}</div>}}\n'),
    ]:
        mutated = "import {CanvasMinimap} from './CanvasMinimap'\n" + original_canvas.replace(marker, insertion + marker)
        (isolated / 'src/Canvas.tsx').write_text(mutated)
        result = subprocess.run(['node', str(CLIENT / 'node_modules/vitest/vitest.mjs'), 'run', 'src/canvas-minimap-removal.test.tsx',
                                 '-t', 'offscreen content mounts no minimap', '--reporter=verbose'], cwd=isolated, text=True, capture_output=True)
        output = result.stdout + result.stderr
        (HERE / f'{name}.log').write_text(output)
        assertion_failed = (
            'AssertionError: expected "getContext" to not be called at all' in output
            and '❯ absent src/canvas-minimap-removal.test.tsx:' in output
            and 'expect(contextCalls).not.toHaveBeenCalled()' in output
            and re.search(r'Number of calls: [1-9][0-9]*', output) is not None
            and re.search(r'Tests\s+1 failed \| 2 skipped \(3\)', output) is not None
            and 'Not implemented' not in output
        )
        row = {'name': name, 'exitCode': result.returncode, 'expectedFailureObserved': result.returncode != 0 and assertion_failed,
               'mutatedCanvasSha256': hashlib.sha256(mutated.encode()).hexdigest(), 'log': f'{name}.log'}
        results.append(row)
summary = {'runtime': 'isolated source snapshot; production Canvas + React/jsdom + Editor/WASM; KernelSurface device boundary replaced',
           'deletedComponentSource': 'HEAD:frontend/design-client/src/CanvasMinimap.tsx',
           'deletedComponentSha256': hashlib.sha256(old.encode()).hexdigest(), 'controls': results}
(HERE / 'negative-controls.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
if not all(row['expectedFailureObserved'] for row in results):
    raise SystemExit(1)
