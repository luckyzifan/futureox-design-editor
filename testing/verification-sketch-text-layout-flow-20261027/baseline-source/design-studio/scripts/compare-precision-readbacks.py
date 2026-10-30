#!/usr/bin/env python3
"""Join native and browser evidence using the same requested scene/profile."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--profiles', default='analytic,figma,figmaSubpixel')
args = parser.parse_args()
corpus = json.loads((ROOT / 'testing/fixtures/design/precision-corpus.json').read_text())
records = []
for profile in args.profiles.split(','):
    for index, case in enumerate(corpus['cases']):
        for suffix in ['rgba'] + (['linear.f32'] if case['document'].get('colorManagement') is not None else []):
            prefix = f'corpus-{profile}-{index}'
            paths = {
                'native-cpu': args.output / 'native' / f'{prefix}-cpu.{suffix}',
                'native-gpu': args.output / 'native' / f'{prefix}-native.{suffix}',
                **{b: args.output / 'browser' / f'{profile}-{index}' / f'{b}.{suffix}'
                   for b in ['cpu', 'webgpu', 'webgl2']},
            }
            row = {'profile': profile, 'index': index, 'name': case['document']['name'],
                   'format': suffix, 'missing': [b for b, p in paths.items() if not p.is_file()],
                   'differences': {}}
            if not row['missing']:
                reference = paths['native-cpu'].read_bytes()
                expected_size = case['options']['width'] * case['options']['height'] * (16 if suffix == 'linear.f32' else 4)
                if len(reference) != expected_size:
                    row['sizeError'] = {'expected': expected_size, 'actual': len(reference)}
                for backend, path in paths.items():
                    data = path.read_bytes()
                    row['differences'][backend] = abs(len(data) - len(reference)) + sum(a != b for a, b in zip(data, reference))
            row['failed'] = bool(row['missing'] or row.get('sizeError') or any(row['differences'].values()))
            records.append(row)
report = {'checks': len(records), 'failures': sum(r['failed'] for r in records),
          'scope': 'Five actual readbacks: native CPU, native GPU, WASM CPU, WebGPU, WebGL2',
          'records': records}
(args.output / 'cross-results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'records'}))
raise SystemExit(1 if report['failures'] else 0)
