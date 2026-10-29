"""Record this task's delta against its dirty-workspace baseline, never HEAD."""
from pathlib import Path
import difflib
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
RECORD = Path(__file__).resolve().parent
BEFORE = RECORD / 'before'
OWNED = [
    '.agents/skills/futureox-design-development/SKILL.md',
    '.agents/skills/futureox-rendering-first/SKILL.md',
    'docs/DEVELOPMENT_CONTRACT_V1.md',
    'design-studio/crates/design-kernel/src/gpu/scene_plan.rs',
    'frontend/design-client/src/Canvas.tsx',
    *['frontend/design-client/src/kernel/gpu/' + name for name in [
        'renderer.ts', 'webgpu.ts', 'types.ts', 'scene-index.ts',
        'coverage-cache.ts', 'effect-region.ts', 'gradient-paint-over.ts',
        'reduced-paint-work.test.ts']],
    'frontend/design-client/src/canvas-native-source-wiring.test.tsx',
    'frontend/design-client/src/kernel/tile-cost-diagnostics.ts',
    'frontend/design-desktop/src/render-pass-work.mjs',
    'frontend/design-desktop/src/render-pass-work.d.mts',
    'frontend/design-desktop/test/render-work-diagnostics.test.mjs',
]
NEW = {
    'frontend/design-client/src/kernel/gpu/gradient-paint-over.ts',
    'frontend/design-client/src/kernel/gpu/reduced-paint-work.test.ts',
    'frontend/design-client/src/canvas-native-source-wiring.test.tsx',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


baseline = json.loads((RECORD / 'baseline.json').read_text())['inputs']
# Its first local backup was made after the one-line version-counter edit.
# Recover the pre-edit bytes and require the original frozen digest exactly.
tile = 'frontend/design-client/src/kernel/tile-cost-diagnostics.ts'
if not (BEFORE / tile).exists():
    original = (ROOT / tile).read_text().replace("||key==='drawWorkVersion'", '')
    assert sha(original.encode()) == baseline[tile]
    (BEFORE / tile).parent.mkdir(parents=True, exist_ok=True)
    (BEFORE / tile).write_text(original)
# This pre-existing untracked host test was omitted by buildInputs. Reconstruct
# only the known added import/test, and explicitly distinguish its provenance.
host_test = 'frontend/design-desktop/test/render-work-diagnostics.test.mjs'
host_before = BEFORE / host_test
if not host_before.exists():
    source = (ROOT / host_test).read_text()
    start = source.index("test('pixel work and rejection reasons")
    end = source.index("test('texture extent failures", start)
    source = (source[:start] + source[end:]).replace(
        '{PassDrawWork,FastPathWork}', '{PassDrawWork}')
    host_before.parent.mkdir(parents=True, exist_ok=True)
    host_before.write_text(source)

changes, patch = [], []
for name in OWNED:
    current = (ROOT / name).read_bytes()
    previous = None if name in NEW else (BEFORE / name).read_bytes()
    if previous == current:
        continue
    if name in baseline:
        assert previous is not None and sha(previous) == baseline[name], name
    changes.append({
        'path': name, 'beforeSha256': sha(previous) if previous is not None else None,
        'afterSha256': sha(current),
        'provenance': 'new-in-task' if previous is None else
            'reconstructed-known-delta' if name == host_test else
            'reconstructed-frozen-hash-verified' if name == tile else
            'frozen-build-input' if name in baseline else 'saved-before-edit',
    })
    patch.extend(difflib.unified_diff(
        (previous or b'').decode().splitlines(keepends=True),
        current.decode().splitlines(keepends=True),
        fromfile='a/' + name if previous is not None else '/dev/null',
        tofile='b/' + name))

# Remove only redundant copies created by this task, after byte equality. Keep
# every changed original, and never remove or reset a workspace source file.
pruned = []
for saved in sorted(BEFORE.rglob('*')):
    if not saved.is_file():
        continue
    name = str(saved.relative_to(BEFORE))
    if name not in OWNED and (ROOT / name).is_file():
        assert saved.read_bytes() == (ROOT / name).read_bytes(), name
        pruned.append(name)
        saved.unlink()

external = []
for name, original in baseline.items():
    if name not in OWNED and (ROOT / name).is_file() and sha((ROOT / name).read_bytes()) != original:
        external.append(name)
manifest = {
    'basis': 'Existing dirty workspace, not Git HEAD. Do not revert other changes.',
    'changes': changes, 'externalBuildInputChangesPreserved': external,
    'rollback': 'Verify every afterSha256, then git apply --reverse --check task.patch before applying. Rebuild WASM and desktop afterwards. The host test original was reconstructed, not pre-frozen.',
}
(RECORD / 'changes.json').write_text(json.dumps(manifest, indent=2) + '\n')
(RECORD / 'task.patch').write_text(''.join(patch))
print(json.dumps({'changedFiles': len(changes), 'redundantBackupsRemoved': len(pruned),
                  'externalInputChangesPreserved': external}))
