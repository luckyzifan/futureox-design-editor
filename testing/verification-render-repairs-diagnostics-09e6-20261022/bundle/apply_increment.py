#!/usr/bin/env python3
"""Hash-guarded source-only apply/rollback. No checkout, reset, build or download."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def digest(path):
    if not path.exists():
        return None
    if not path.is_file() or path.is_symlink():
        raise ValueError('Refusing non-regular file: ' + str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_target(root, relative):
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or any(p in ('', '.', '..') for p in rel.parts):
        raise ValueError('Invalid manifest path')
    target = root / rel
    for path in [target, *target.parents]:
        if path == root:
            break
        if path.is_symlink():
            raise ValueError('Refusing symlink target or parent: ' + str(path))
    return target


def replace(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix='.core-increment-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def perform(bundle, root, command):
    bundle, root = Path(bundle).resolve(), Path(root).resolve(strict=True)
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if command not in ('check', 'apply', 'rollback'):
        raise ValueError('Use check, apply or rollback')
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--verify', 'HEAD'], text=True).strip()
    if command != 'rollback' and head != manifest['baseline']:
        raise ValueError('HEAD mismatch; expected ' + manifest['baseline'] + ', got ' + head)
    staged = subprocess.check_output(['git', '-C', str(root), 'diff', '--cached', '--name-only', '-z', 'HEAD', '--', *[item['path'] for item in manifest['changes']]])
    if staged:
        raise ValueError('Affected files have staged changes; refusing to alter working files or index')
    pending = []
    # Validate every input and destination before changing any file. Re-running
    # after interruption accepts only exact baseline/candidate bytes, not edits.
    for item in manifest['changes']:
        rel, old, new = item['path'], item['baselineSha256'], item['sha256']
        target = safe_target(root, rel)
        source = safe_target(bundle / 'source', rel)
        baseline = safe_target(bundle / 'baseline', rel)
        if digest(source) != new or (old is not None and digest(baseline) != old):
            raise ValueError('Bundle hash mismatch: ' + rel)
        actual = digest(target)
        if actual not in (old, new):
            raise ValueError('Target was modified; refusing to overwrite: ' + rel)
        desired = old if command == 'rollback' else new
        if actual != desired:
            pending.append((target, None if desired is None else (baseline if command == 'rollback' else source).read_bytes(), desired))
    if command == 'check':
        return {'mode': command, 'validatedFiles': len(manifest['changes']), 'filesToChange': len(pending), 'baseline': head}
    for target, data, wanted in pending:
        if data is None:
            target.unlink()
        else:
            replace(target, data)
        if digest(target) != wanted:
            raise ValueError('Post-write verification failed: ' + str(target))
    return {'mode': command, 'validatedFiles': len(manifest['changes']), 'filesChanged': len(pending), 'baseline': head}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Usage: python3 apply_increment.py check|apply|rollback /absolute/path/to/Core')
        print(json.dumps(perform(Path(__file__).parent, sys.argv[2], sys.argv[1]), indent=2))
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
