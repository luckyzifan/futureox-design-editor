#!/usr/bin/env python3
"""Exact-baseline, per-file hash-guarded source apply/rollback. Never touches data or builds."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

def digest(path):
    if not path.exists():
        if path.is_symlink():
            raise ValueError('Refusing dangling symlink: ' + str(path))
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

def replace(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
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

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

def perform(bundle, root, command):
    bundle, root = Path(bundle).resolve(), Path(root).resolve(strict=True)
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if command not in ('check', 'apply', 'rollback'):
        raise ValueError('Use check, apply or rollback')
    top = Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    if top != root:
        raise ValueError('Target must be the repository root')
    head = git(root, 'rev-parse', '--verify', 'HEAD').decode().strip()
    if head != manifest['baseline']:
        raise ValueError('HEAD mismatch; expected ' + manifest['baseline'] + ', got ' + head)
    if git(root, 'diff', '--cached', '--name-only', '-z', 'HEAD'):
        raise ValueError('Index has staged changes; refusing to alter working files or index')
    allowed = {item['path'] for item in manifest['changes']}
    dirty = set(git(root, 'diff', '--name-only', '-z', 'HEAD').decode().rstrip('\0').split('\0')) - {''}
    if dirty - allowed:
        raise ValueError('Unrelated tracked edits exist; use a separate clean baseline checkout')
    pending = []
    # Preflight all files before writing any. Exact old/new bytes also permit safe
    # resumption after interruption; unknown edits are never overwritten.
    for item in manifest['changes']:
        rel, old, new = item['path'], item['baselineSha256'], item['sha256']
        target = safe_target(root, rel)
        source = safe_target(bundle / 'source', rel)
        baseline = safe_target(bundle / 'baseline', rel)
        if digest(source) != new or digest(baseline) != old:
            raise ValueError('Bundle hash mismatch: ' + rel)
        actual = digest(target)
        if actual not in (old, new):
            raise ValueError('Target was modified; refusing to overwrite: ' + rel)
        if actual is not None:
            current_mode = target.stat().st_mode & 0o777
            valid_modes = {item['mode'], item['baselineMode']} - {None}
            if current_mode not in valid_modes:
                raise ValueError('Target mode was modified: ' + rel)
        desired = old if command == 'rollback' else new
        mode = item['baselineMode'] if command == 'rollback' else item['mode']
        if actual != desired or (actual is not None and target.stat().st_mode & 0o777 != mode):
            pending.append((target, None if desired is None else (baseline if command == 'rollback' else source).read_bytes(), desired, mode))
    if command == 'check':
        return {'mode': command, 'validatedFiles': len(manifest['changes']), 'filesToChange': len(pending), 'baseline': head}
    for target, data, wanted, mode in pending:
        if data is None:
            target.unlink()
        else:
            replace(target, data, mode)
        if digest(target) != wanted:
            raise ValueError('Post-write verification failed: ' + str(target))
    return {'mode': command, 'validatedFiles': len(manifest['changes']), 'filesChanged': len(pending), 'baseline': head, 'databaseTouched': False}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Usage: python3 apply_increment.py check|apply|rollback /absolute/path/to/Core')
        print(json.dumps(perform(Path(__file__).parent, sys.argv[2], sys.argv[1]), indent=2))
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
