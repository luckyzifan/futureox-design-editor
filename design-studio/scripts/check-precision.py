#!/usr/bin/env python3
"""Owned, strict local precision gate. A missing GPU or nonzero byte diff fails."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
parser.add_argument('--profiles', default='analytic,figma,figmaSubpixel')
parser.add_argument('--stages', default='kernel,native,frontend,browser')
args = parser.parse_args()
profiles = args.profiles.split(',')
stages = args.stages.split(',')
if not set(profiles) <= {'analytic', 'figma', 'figmaSubpixel'}:
    parser.error('Unknown raster profile')
if not set(stages) <= {'kernel', 'native', 'frontend', 'browser'}:
    parser.error('Unknown gate stage')
output = (args.output or ROOT / '.local/design-validation' / f'precision-{uuid.uuid4()}').resolve()
output.mkdir(parents=True, exist_ok=False)
environment = os.environ.copy()
for name in ['DESIGN_PARITY_INPUT', 'DESIGN_PARITY_CASES']:
    environment.pop(name, None)
expected = {'oracle', 'sampling-oracle', 'filter-oracle', 'coverage-oracle', 'texture-copyback-oracle', 'icc-patch', 'generated-shaders'} | set(stages) | ({'build'} if {'frontend', 'browser'} & set(stages) else set()) | ({'arithmetic'} if 'native' in stages else set())
if {'native', 'browser'} <= set(stages):
    expected.add('cross')
environment['DESIGN_PARITY_PROFILES'] = ','.join(profiles)
environment['DESIGN_TEST_OUTPUT'] = str(output / 'browser')
environment['DESIGN_GPU_TEST_ARTIFACTS'] = str(output / 'native')
checks = []


def run(name, command, directory=ROOT):
    log = output / f'{name}.log'
    started = time.monotonic()
    print(json.dumps({'stage': name, 'state': 'running', 'log': str(log)}), flush=True)
    with log.open('w') as stream:
        process = subprocess.Popen(command, cwd=directory, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=1200)
        except BaseException:
            # Only this freshly created process group belongs to this run.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    if name in {'native', 'arithmetic'} and code == 0:
        summaries = re.findall(r'test result: ok\. (\d+) passed; \d+ failed; (\d+) ignored', log.read_text())
        if not summaries or sum(int(p) for p, _ in summaries) == 0 or any(int(i) for _, i in summaries):
            code = 2
    result = {'stage': name, 'command': command, 'exit': code,
              'seconds': round(time.monotonic() - started, 3), 'log': str(log)}
    checks.append(result)
    print(json.dumps(result), flush=True)


try:
    run('oracle', ['python3', 'design-studio/scripts/generate-precision-vectors.py', '--check'])
    run('sampling-oracle', ['python3', 'design-studio/scripts/generate-sampling-vectors.py', '--check'])
    run('filter-oracle', ['python3', 'design-studio/scripts/generate-filter-vectors.py', '--check'])
    run('coverage-oracle', ['python3', 'design-studio/scripts/generate-coverage-vectors.py', '--check'])
    run('texture-copyback-oracle', ['python3', 'design-studio/scripts/generate-texture-copyback-vectors.py', '--check'])
    run('icc-patch', ['python3', 'design-studio/scripts/check-moxcms-patch.py'])
    run('generated-shaders', ['python3', 'design-studio/scripts/generate-rational-glsl.py', '--check'])
    if 'kernel' in stages:
        run('kernel', ['cargo', 'test', '--locked', '--manifest-path', 'design-studio/Cargo.toml',
                       '-p', 'futureox-design-kernel', '--no-fail-fast', '--', '--test-threads=2'])
    if 'native' in stages:
        run('arithmetic', ['cargo', 'test', '--locked', '--manifest-path', 'design-studio/Cargo.toml',
                          '-p', 'futureox-design-gpu', '--features', 'hardware-tests', '--test', 'arithmetic', '--test', 'sampling', '--test', 'rational_filter', '--test', 'coverage64', '--test', 'area', '--test', 'texture_clip',
                          '--', '--test-threads=1', '--nocapture'])
        run('native', ['cargo', 'test', '--locked', '--manifest-path', 'design-studio/Cargo.toml',
                       '-p', 'futureox-design-gpu', '--features', 'hardware-tests', '--test', 'native',
                       '--', '--test-threads=1', '--nocapture'])
    if 'frontend' in stages or 'browser' in stages:
        run('build', ['bun', 'run', 'build'], ROOT / 'frontend/design-client')
    if 'frontend' in stages:
        run('frontend', ['bun', 'run', 'test'], ROOT / 'frontend/design-client')
    if 'browser' in stages:
        run('browser', ['bun', 'scripts/check-gpu-parity.ts'], ROOT / 'frontend/design-client')
    if {'native', 'browser'} <= set(stages):
        run('cross', ['python3', 'design-studio/scripts/compare-precision-readbacks.py', str(output), '--profiles', args.profiles])
finally:
    corpus = ROOT / 'testing/fixtures/design/precision-corpus.json'
    passed = {c['stage'] for c in checks} == expected and all(c['exit'] == 0 for c in checks)
    report = {'profiles': profiles, 'stages': stages,
              'passed': passed,
              'fullAcceptancePassed': passed and set(profiles) == {'analytic', 'figma', 'figmaSubpixel'} and set(stages) == {'kernel', 'native', 'frontend', 'browser'},
              'corpusSha256': hashlib.sha256(corpus.read_bytes()).hexdigest(),
              'arithmeticSha256': hashlib.sha256((ROOT / 'testing/fixtures/design/arithmetic-vectors.json').read_bytes()).hexdigest(),
              'samplingSha256': hashlib.sha256((ROOT / 'testing/fixtures/design/sampling-vectors.json').read_bytes()).hexdigest(),
              'filterSha256': hashlib.sha256((ROOT / 'testing/fixtures/design/filter-vectors.json').read_bytes()).hexdigest(),
              'coverageSha256': hashlib.sha256((ROOT / 'testing/fixtures/design/coverage-vectors.json').read_bytes()).hexdigest(),
              'textureCopybackSha256': hashlib.sha256((ROOT / 'testing/fixtures/design/texture-copyback-vectors.json').read_bytes()).hexdigest(),
              'checks': checks,
              'scope': 'Exact RGBA8 and managed binary32 bit comparisons on all requested profiles; independent arithmetic oracle. Missing backends fail. External Figma PNG similarity remains separate.'}
    (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'passed': report['passed']}), flush=True)
raise SystemExit(0 if report['passed'] else 1)
