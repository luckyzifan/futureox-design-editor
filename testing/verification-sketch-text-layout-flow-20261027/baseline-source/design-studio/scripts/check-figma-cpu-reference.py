#!/usr/bin/env python3
"""Strictly compare native CPU output with preserved Figma PNG references.

This is an external-reference check only: success does not certify GPU parity,
interactive latency, or equivalence between browser and MCP export environments.
No alignment, resampling, gamma correction, or tolerance is applied.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import Image


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def difference(actual, expected):
    if not actual or len(actual) != len(expected) or len(actual) % 4:
        raise ValueError('RGBA readback dimensions differ')
    delta = [abs(a - b) for a, b in zip(actual, expected)]
    return {
        'differentPixels': sum(any(delta[i:i + 4]) for i in range(0, len(delta), 4)),
        'differentChannels': sum(v != 0 for v in delta),
        'maxChannelError': max(delta, default=0),
    }


def references(directory):
    cases = json.loads((directory / 'cases.json').read_text())
    if not cases or not isinstance(cases, list):
        raise ValueError('An empty reference set cannot pass')
    identifiers = set()
    for case in cases:
        if case['id'] in identifiers:
            raise ValueError('Duplicate reference case')
        identifiers.add(case['id'])
        path = (directory / case['reference']).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError('Reference is outside its directory')
        if digest(path) != case['referenceSha256']:
            raise ValueError(f'Changed reference: {case["id"]}')
        with Image.open(path) as image:
            if image.size != (case['options']['width'], case['options']['height']):
                raise ValueError(f'Reference size mismatch: {case["id"]}')
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--references', type=Path, required=True)
    parser.add_argument('--native-binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profiles', nargs='+', default=['figma'],
                        choices=['figma', 'figmaSubpixel', 'figmaSoftware', 'analytic'])
    args = parser.parse_args()
    if len(set(args.profiles)) != len(args.profiles):
        parser.error('Profiles must be unique')
    args.output.mkdir(parents=True, exist_ok=True)
    # A startup error or timed-out renderer must not leave an earlier green
    # report at the requested destination.
    report_path = args.output / 'results.json'
    report_path.unlink(missing_ok=True)
    cases = references(args.references)
    binary = args.native_binary.resolve()
    binary_hash = digest(binary)
    records = []
    for index, case in enumerate(cases):
        with Image.open(args.references / case['reference']) as image:
            expected = image.convert('RGBA').tobytes()
        for profile in args.profiles:
            prefix = args.output / f'{index}-{profile}'
            request, png, rgba = [prefix.with_suffix(suffix) for suffix in ('.json', '.png', '.rgba')]
            payload = {'document': case['document'],
                       'options': {**case['options'], 'rasterProfile': profile}}
            request.write_text(json.dumps(payload, indent=2) + '\n')
            # Never accept an old output after an unsuccessful invocation.
            png.unlink(missing_ok=True)
            rgba.unlink(missing_ok=True)
            command = [str(binary), '--input', str(request), '--output', str(png),
                       '--rgba', str(rgba), '--backend', 'cpu']
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            record = {'id': case['id'], 'profile': profile, 'exit': result.returncode,
                      'requestSha256': digest(request), 'referenceSha256': case['referenceSha256']}
            if result.returncode:
                record['error'] = result.stderr[-4000:]
            else:
                actual = rgba.read_bytes()
                record.update(difference(actual, expected))
                with Image.open(png) as image:
                    if image.size != (case['options']['width'], case['options']['height']):
                        raise ValueError('Rendered PNG dimensions differ')
                    if image.convert('RGBA').tobytes() != actual:
                        raise ValueError('Rendered PNG and raw readback differ')
                record['rgbaSha256'] = digest(rgba)
                record['pngSha256'] = digest(png)
            records.append(record)
            print(json.dumps(record), flush=True)
    if digest(binary) != binary_hash:
        raise ValueError('Native binary changed during validation')
    # Also reject references or the case manifest changing mid-run.
    if references(args.references) != cases:
        raise ValueError('Reference inputs changed during validation')
    passed = all(r['exit'] == 0 and r['differentPixels'] == 0 for r in records)
    report = {'recordedAtUTC': datetime.now(timezone.utc).isoformat(),
              'backend': 'native-cpu', 'nativeBinarySha256': binary_hash,
              'scope': 'Strict RGBA8 external reference only; no GPU or UI parity claim',
              'caseCount': len(cases), 'profiles': args.profiles,
              'strictParityPassed': passed, 'records': records}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
