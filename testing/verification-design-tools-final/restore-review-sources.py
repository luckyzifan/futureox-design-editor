#!/usr/bin/env python3
"""Restore sanitized review views into a NEW external directory; never run tests."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_absolute(value):
    result = Path(value).expanduser().resolve()
    if any(c in str(result) for c in ["'", '"', '\\', '\n', '\r', '\x00']):
        raise ValueError('Paths must not contain quotes, backslashes, or control characters.')
    return result


def within(path, parent):
    return path == parent or parent in path.parents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='Existing complete Design checkout; never modified.')
    parser.add_argument('--out', required=True, help='New external directory which must not exist.')
    parser.add_argument('--build-root', help='Existing build-root layout with cargo-target/debug binaries/rlibs; optional for source-only restoration.')
    parser.add_argument('--prior-zip', help='Optional c11 archive path for historical command references.')
    parser.add_argument('--workspace-root', help='Optional mapping for other historical workspace references.')
    parser.add_argument('--agent-home', help='Optional mapping for historical tool-location references.')
    parser.add_argument('--font-fixture-dir', help='Existing generated temporary fixture directory; redirect only the two known historical external font-review reads, without copying fonts or running tests.')
    parser.add_argument('--link-node-modules', action='store_true', help='Create external review-directory links to the checkout existing client dependencies; installs nothing.')
    args = parser.parse_args()
    bundle = Path(__file__).resolve().parent
    repo = safe_absolute(args.repo)
    if Path(args.out).expanduser().is_symlink():
        raise ValueError('--out must not be an existing or broken symlink.')
    out = safe_absolute(args.out)
    if not (repo / 'frontend/design-client/package.json').is_file():
        raise ValueError('The selected path is not a complete Design checkout.')
    if out.exists() or within(out, repo) or within(out, bundle):
        raise ValueError('--out must be a new directory outside the checkout and publication bundle.')
    substitutions = {'__DESIGN_REPO__': str(repo), '__REVIEW_ROOT__': str(out)}
    font_fixture = None
    if args.font_fixture_dir:
        supplied = Path(args.font_fixture_dir).expanduser()
        if supplied.is_symlink():
            raise ValueError('--font-fixture-dir must not be a symlink.')
        fixture_dir = safe_absolute(args.font_fixture_dir)
        manifest_file = fixture_dir / 'manifest.json'
        if not fixture_dir.is_dir() or manifest_file.is_symlink() or not manifest_file.is_file() or manifest_file.stat().st_size > 16_384:
            raise ValueError('Generated font fixture directory/manifest is missing or invalid.')
        fixture_manifest = json.loads(manifest_file.read_text())
        fonts = fixture_manifest.get('fonts', [])
        if (fixture_manifest.get('schemaVersion') != 1 or fixture_manifest.get('fontToolsVersion') != '4.61.1'
                or fixture_manifest.get('sourceSha256') != 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
                or not isinstance(fonts, list) or len(fonts) != 2
                or {record.get('file') for record in fonts} != {'noto-latin.ttf', 'noto-cjk.ttf'}):
            raise ValueError('Generated font fixture manifest has unexpected identity or filenames.')
        for record in fonts:
            file = fixture_dir / record['file']
            size = record.get('bytes')
            if (not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 65_536
                    or file.is_symlink() or not file.is_file() or file.stat().st_size != size
                    or digest(file) != record.get('sha256')):
                raise ValueError('Generated font fixture file identity is invalid: ' + record['file'])
        font_fixture = {'directory': str(fixture_dir), 'manifest': fixture_manifest,
                        'note': 'New deterministic generated fixtures differ from historical review bytes. Any test rerun requires new source/runtime/fixture attribution; no historical passing result is transferred.'}
    for name in ['build_root', 'prior_zip', 'workspace_root', 'agent_home']:
        value = getattr(args, name)
        if value:
            substitutions['__' + name.upper() + '__'] = str(safe_absolute(value))
    manifest = json.loads((bundle / 'provenance.json').read_text())
    pending = []
    redirected_font_sources = []
    targeted_font_sources = {'review-canvas-font/independent-font.test.tsx', 'review-canvas-font/ownership-negative-control.test.tsx'}
    for row in manifest['files']:
        source_path = bundle / row['published_path']
        if source_path.is_symlink():
            raise ValueError('Published source must not be a symlink: ' + row['published_path'])
        source = source_path.resolve()
        target = out / row['restored_path']
        if not within(source, bundle) or not within(target.resolve(), out):
            raise ValueError('Unsafe path in provenance manifest.')
        if source.is_symlink() or digest(source) != row['published_sha256']:
            raise ValueError('Published source hash mismatch: ' + row['published_path'])
        text = source.read_text()
        for marker, value in substitutions.items():
            text = text.replace(marker, value)
        if font_fixture is not None and row['restored_path'] in targeted_font_sources:
            old = "readFileSync('" + str(repo / 'testing/verification-font-batch/fixtures/noto-latin.ttf') + "')"
            new = "readFileSync('" + str(fixture_dir / 'noto-latin.ttf') + "')"
            if not row['dormant_source_view'] or text.count(old) != 1:
                raise ValueError('Historical font read does not match the exact approved literal: ' + row['restored_path'])
            text = text.replace(old, new)
            if old in text:
                raise ValueError('Targeted historical font read remains unresolved.')
            redirected_font_sources.append(row['restored_path'])
        pending.append((target, text, row))
    if font_fixture is not None and set(redirected_font_sources) != targeted_font_sources:
        raise ValueError('Expected both historical font-review source views.')
    # No filesystem writes occur until all copied bytes and paths have passed.
    out.mkdir(parents=True)
    restored = []
    for target, text, row in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        target.chmod(0o644)
        restored.append({
            'path': str(target.relative_to(out)),
            'sha256': digest(target),
            'source_view': row['dormant_source_view'],
            'unresolved_placeholders': sorted(set(re.findall(r'__[A-Z_]+__', text))),
        })
    if args.link_node_modules:
        dependencies = repo / 'frontend/design-client/node_modules'
        if not dependencies.is_dir():
            raise ValueError('Existing client node_modules is missing; no dependency link created and nothing installed.')
        for review in ['review-canvas-font', 'review-mcp-export', 'review-svg-import']:
            (out / review / 'node_modules').symlink_to(dependencies, target_is_directory=True)
    required = [
        'frontend/design-client/node_modules',
        'frontend/design-client/public/kernel/design_kernel_bg.wasm',
        'frontend/design-client/src/generated/design-kernel/design_kernel.js',
        'frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm',
        'frontend/design-client/public/fonts/NotoSansSC.ttf',
        'testing/verification-font-batch/fixtures/noto-latin.ttf',
        'testing/fixtures/design/figma-materials-native-2026-10-08.fig',
        'testing/verification-svg-compatibility/import-svg.before.ts',
        'testing/verification-svg-compatibility/import-svg-viewport.before.ts',
        'testing/verification-svg-compatibility/svg-presentation.before.ts',
    ]
    prerequisites = [{'path': str(repo / rel), 'exists': (repo / rel).exists()} for rel in required]
    if font_fixture is not None:
        prerequisites = [item for item in prerequisites if item['path'] != str(repo / 'testing/verification-font-batch/fixtures/noto-latin.ttf')]
        prerequisites.append({'path': str(fixture_dir / 'noto-latin.ttf'), 'exists': True})
    if args.build_root:
        build = safe_absolute(args.build_root)
        for rel in ['cargo-target/debug/futureox-design-desktop-backend', 'cargo-target/debug/design-render']:
            prerequisites.append({'path': str(build / rel), 'exists': (build / rel).is_file()})
    report = {'tests_executed': False, 'product_files_modified': False,
              'note': 'Restoration is not test acceptance. Historical before snapshots need their original isolated dependency layout. Missing fixtures/binaries and unresolved placeholders must be supplied or explicitly adapted before those commands are run.',
              'prerequisites': prerequisites, 'restored_files': restored}
    report['font_fixture_redirection'] = font_fixture
    report['exact_historical_font_reads_redirected'] = redirected_font_sources
    (out / 'RESTORATION-STATUS.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'restored_files': len(restored), 'tests_executed': False,
                      'missing_prerequisites': [r['path'] for r in prerequisites if not r['exists']],
                      'source_views_with_unresolved_placeholders': [r['path'] for r in restored if r['source_view'] and r['unresolved_placeholders']],
                      'status_report': str(out / 'RESTORATION-STATUS.json')}, indent=2))


if __name__ == '__main__':
    main()
