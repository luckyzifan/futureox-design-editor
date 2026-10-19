#!/usr/bin/env python3
"""Bounded CPU-only native scene probe. Does not create a GPU or install/build anything."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def leaf(name, x, y, kind='rectangle'):
    return {'id': name, 'kind': kind, 'width': 6, 'height': 6,
            'transform': [1, 0, 0, 1, x, y],
            'fills': [{'kind': 'solid', 'color': '#578add'}]}


def fixture(kind):
    nodes = {f'v{i}': leaf(f'v{i}', 1 + i % 4 * 8, 1 + i // 4 * 8, 'ellipse') for i in range(8)}
    roots = list(nodes)
    if kind == 'flat-offscreen':
        for i in range(3000):
            name = f'off{i}'
            nodes[name] = leaf(name, 20000 + i % 100 * 12, 20000 + i // 100 * 12)
            roots.append(name)
    else:
        for group in range(100):
            parent = f'group{group}'
            children = []
            for i in range(30):
                name = f'{parent}-n{i}'
                nodes[name] = leaf(name, i % 10 * 8, i // 10 * 8)
                children.append(name)
            nodes[parent] = {'id': parent, 'kind': 'frame', 'width': 90, 'height': 30,
                             'clip': True, 'children': children,
                             'transform': [1, 0, 0, 1, 20000 + group % 10 * 120, 20000 + group // 10 * 120],
                             'fills': [{'kind': 'solid', 'color': '#eeeeee'}]}
            if kind == 'nested-effects':
                nodes[parent]['effects'] = [{'kind': 'shadow', 'radius': 8, 'visible': True,
                                             'color': '#000000', 'opacity': 0.25, 'x': 4, 'y': 4}]
            roots.append(parent)
        if kind == 'nested-effects':
            nodes['v0']['effects'] = [{'kind': 'blur', 'radius': 1, 'visible': True, 'color': '#000000'}]
    return {'schemaVersion': 1, 'id': kind, 'name': kind,
            'pages': [{'id': 'p', 'name': 'p', 'background': '#ffffff', 'children': roots}], 'nodes': nodes}


class Host:
    def __init__(self, binary, font, timeout):
        self.process = subprocess.Popen([str(binary), '--font', str(font)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.sequence = 0
        self.timeout = timeout

    def wait(self, stream, deadline, write=False):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f'Native request exceeded {self.timeout} seconds')
        readable, writable, _ = select.select([] if write else [stream], [stream] if write else [], [], remaining)
        if not (writable if write else readable):
            raise TimeoutError(f'Native request exceeded {self.timeout} seconds')

    def read(self, count, deadline):
        parts = []
        while count:
            self.wait(self.process.stdout, deadline)
            part = os.read(self.process.stdout.fileno(), count)
            if not part:
                raise RuntimeError('Native preparation process closed before replying')
            parts.append(part)
            count -= len(part)
        return b''.join(parts)

    def call(self, label, method, args):
        self.sequence += 1
        start = time.monotonic()
        deadline = start + self.timeout
        request = (json.dumps({'id': self.sequence, 'lane': 'interaction', 'method': method, 'args': args}) + '\n').encode()
        offset = 0
        while offset < len(request):
            self.wait(self.process.stdin, deadline, write=True)
            try:
                offset += os.write(self.process.stdin.fileno(), request[offset:offset + 16384])
            except BlockingIOError:
                continue
        header = self.read(12, deadline)
        if header[:4] != b'FPR1':
            raise RuntimeError('Invalid native preparation reply magic')
        metadata_size, payload_size = struct.unpack('<II', header[4:])
        if metadata_size > 1024 * 1024 or payload_size > 48 * 1024 * 1024:
            raise RuntimeError('Synthetic probe reply exceeded its bounded allocation')
        metadata = json.loads(self.read(metadata_size, deadline))
        payload = self.read(payload_size, deadline)
        if metadata.get('id') != self.sequence:
            raise RuntimeError('Native preparation response ID mismatch')
        row = {'step': label, 'elapsedMs': round((time.monotonic() - start) * 1000, 3),
               'payloadBytes': payload_size, 'error': metadata.get('error'),
               'compileStats': metadata.get('compileStats')}
        if payload[:4] == b'FGPD':
            length = struct.unpack('<I', payload[8:12])[0]
            delta = json.loads(payload[24:24 + length])
            row.update(emittedChangedNodes=len(delta['nodes']), fullScene=delta['base'] == 0)
        if metadata.get('error'):
            raise RuntimeError(metadata['error'])
        if method == 'apply_interaction_transforms' and metadata.get('value') is not True:
            raise RuntimeError('Synthetic translation was not admitted to the native fast path')
        return row, payload

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        return self.process.returncode, self.process.stderr.read().decode(errors='replace')


def run(args):
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {'scope': 'Synthetic CPU scene preparation only; no GPU/device/browser/GUI, pixel, FPS or user-file performance claim',
              'buildProfile': args.build_profile, 'binarySha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              'perRequestTimeoutSeconds': args.timeout, 'results': []}
    for kind in ['flat-offscreen', 'nested-clipped', 'nested-effects']:
        document = fixture(kind)
        raw = json.dumps(document)
        (args.output_dir / f'{kind}.json').write_text(raw)
        case = {'fixture': kind, 'nodeCount': len(document['nodes']),
                'rootCount': len(document['pages'][0]['children']),
                'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'steps': [],
                'scannedNodes': 'Not instrumented. preparedNodes counts retained entries, not scanned nodes.'}
        host = Host(args.binary, args.font, args.timeout)
        try:
            def step(label, method, values):
                row, payload = host.call(label, method, values)
                case['steps'].append(row)
                return row, payload
            step('load-includes-process-and-font-startup', 'load_document', [raw])
            for zoom in [1, 32]:
                options = json.dumps({'pageId': 'p', 'width': 1024, 'height': 1024, 'rasterProfile': 'figmaSubpixel',
                                      'view': {'x': 0, 'y': 0, 'zoom': zoom},
                                      'captureViewport': {'x': 0, 'y': 0, 'w': 1024, 'h': 1024}})
                row, _ = step(f'zoom-{zoom}-cold', 'compile_gpu_scene_update', [options, True])
                if row['emittedChangedNodes'] != 8 or not row['fullScene']:
                    raise AssertionError('Cold synthetic scene must emit its eight visible nodes')
                row, _ = step(f'zoom-{zoom}-unchanged', 'compile_gpu_scene_update', [options, False])
                if row['emittedChangedNodes'] != 0 or row['fullScene']:
                    raise AssertionError('Unchanged scene must use the empty exact delta')
            transform = [1, 0, 0, 1, 9.375, 1.25]
            step('translate-one-visible-node', 'apply_interaction_transforms', [json.dumps({'v1': transform})])
            row, _ = step('zoom-32-after-translation', 'compile_gpu_scene_update', [options, False])
            if row['emittedChangedNodes'] != 1:
                raise AssertionError('Synthetic one-node translation must emit one changed node')
            _, actual = step('zoom-32-retained-full-packet', 'compile_gpu_packet', [options])
            fresh_document = copy.deepcopy(document)
            fresh_document['nodes']['v1']['transform'] = transform
            oracle = Host(args.binary, args.font, args.timeout)
            try:
                oracle.call('oracle-load', 'load_document', [json.dumps(fresh_document)])
                _, expected = oracle.call('oracle-compile', 'compile_gpu_packet', [options])
                if actual != expected:
                    raise AssertionError('Retained translated scene differs from a fresh native compile')
            finally:
                oracle.close()
            case.update(passed=True, retainedMatchesFresh=True,
                        translatedPacketSha256=hashlib.sha256(actual).hexdigest())
        except Exception as error:
            case.update(passed=False, failure=str(error))
        finally:
            case['exitCode'], case['stderr'] = host.close()
            report['results'].append(case)
            print(json.dumps(case), flush=True)
            (args.output_dir / 'results.json').write_text(json.dumps(report, indent=2))
    return 0 if all(case['passed'] for case in report['results']) else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True, help='Already-built design-prepare executable')
    parser.add_argument('--font', type=Path, default=ROOT / 'frontend/design-client/public/fonts/NotoSansSC.ttf')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--build-profile', default='unknown', help='Provenance label only; does not change or build the binary')
    parser.add_argument('--timeout', type=float, default=15, help='Per-request timeout in seconds, including pipe writes (maximum 60)')
    args = parser.parse_args()
    if not 0 < args.timeout <= 60:
        parser.error('--timeout must be greater than zero and at most 60 seconds')
    args.binary = args.binary.resolve()
    args.font = args.font.resolve()
    if not args.binary.is_file() or not args.font.is_file():
        parser.error('The prebuilt binary and font must both exist')
    raise SystemExit(run(args))
