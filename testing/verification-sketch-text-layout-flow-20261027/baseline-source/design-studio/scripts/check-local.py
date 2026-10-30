#!/usr/bin/env python3
"""Owned UUID PostgreSQL + real Rust HTTP regression. Never touches an existing DB."""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    run = Path(tempfile.mkdtemp(prefix='design-studio-test-'))
    os.chmod(run, 0o700)
    role = 'design_' + uuid.uuid4().hex
    dbname = 'design_' + uuid.uuid4().hex
    pgport = free_port()
    ports = [free_port(), free_port()]
    token = secrets.token_urlsafe(36)
    database = f'postgresql://{role}@127.0.0.1:{pgport}/{dbname}'
    manifest = run / 'manifest.json'
    manifest.write_text(json.dumps({'database_url': database, 'token': token, 'ports': ports}))
    os.chmod(manifest, 0o600)
    log = (run / 'test.log').open('w')
    processes = []
    started = False

    def call(path, method='GET', body=None, auth=True, server=0):
        headers = {'Content-Type': 'application/json'}
        if auth:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(f'http://127.0.0.1:{ports[server]}{path}', data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read()
                return response.status, (json.loads(raw) if 'json' in response.headers.get('content-type','') else raw) if raw else None
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    try:
        subprocess.run(['initdb', '-D', str(run / 'pg'), '-U', role, '--auth=trust', '--no-locale', '--encoding=UTF8'], check=True, stdout=log, stderr=log)
        subprocess.run(['pg_ctl', '-D', str(run / 'pg'), '-l', str(run / 'postgres.log'), '-o', f'-h 127.0.0.1 -p {pgport} -k {run}', '-w', 'start'], check=True, stdout=log, stderr=log)
        started = True
        subprocess.run(['createdb', '-h', '127.0.0.1', '-p', str(pgport), '-U', role, dbname], check=True, stdout=log, stderr=log)
        for i, port in enumerate(ports):
            env = {**os.environ, 'DESIGN_DATABASE_URL': database, 'DESIGN_API_TOKEN': token, 'DESIGN_BIND': f'127.0.0.1:{port}'}
            processes.append(subprocess.Popen([os.environ.get('DESIGN_TEST_SERVER_BINARY', str(ROOT / 'target/debug/futureox-design-server'))], env=env, stdout=log, stderr=log))
            for attempt in range(150):
                if processes[-1].poll() is not None:
                    raise RuntimeError(f'Server exited; private diagnostics at {run}')
                try:
                    if call('/health', server=i)[0] == 200:
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Server readiness timeout')
        assert call('/api/design/documents', auth=False)[0] == 401
        assert call('/api/design/documents')[1] == []
        id = str(uuid.uuid4())
        document = {'schemaVersion': 1, 'id': id, 'name': '自研编辑器回归', 'pages': [{'id': str(uuid.uuid4()), 'name': 'Page', 'children': [], 'background': '#ffffff'}], 'nodes': {}}
        if len(sys.argv) > 1:
            document = json.loads(Path(sys.argv[1]).read_text())
            document['id'] = id
        path = f'/api/design/documents/{id}'
        request = {'document': document, 'revision': 0, 'requestId': str(uuid.uuid4())}
        status, saved = call(path, 'PUT', request)
        assert status == 200 and saved['revision'] == 1
        assert call(path, server=1)[1]['document'] == document
        render_options={'pageId':document['pages'][0]['id'],'width':320,'height':240,'view':{'x':0,'y':0,'zoom':0.25},'transparent':False,'grid':False}
        status,png=call('/api/design/render','POST',{'document':document,'options':render_options})
        assert status == 200 and png.startswith(b'\x89PNG\r\n\x1a\n')
        if len(sys.argv) > 2:
            assert png == Path(sys.argv[2]).read_bytes(), 'Native/WASM PNG mismatch'
        assert call('/api/design/render','POST',{'document':document,'options':render_options},auth=False)[0] == 401
        for malformed_options in [None, [], 'invalid']:
            assert call('/api/design/render', 'POST', {'document': document, 'options': malformed_options})[0] == 422
        assert call('/api/design/render','POST',{'document':document,'options':{**render_options,'width':20000}})[0] == 422
        assert call('/api/design/render','POST',{'document':document,'options':render_options},server=1)[1] == png
        fidelity_options = {**render_options, 'rasterProfile': 'figma'}
        fidelity_status, fidelity_png = call('/api/design/render', 'POST', {'document': document, 'options': fidelity_options})
        assert fidelity_status == 200 and fidelity_png.startswith(b'\x89PNG\r\n\x1a\n')
        assert call('/api/design/render', 'POST', {'document': document, 'options': fidelity_options}, server=1)[1] == fidelity_png
        if len(sys.argv) > 4:
            assert fidelity_png == Path(sys.argv[4]).read_bytes(), 'Native/WASM Figma sampling mismatch'
        if len(sys.argv) > 5:
            wide_options = {**render_options, 'width': 9000, 'height': 32}
            wide_status, wide_png = call('/api/design/render', 'POST', {'document': document, 'options': wide_options})
            assert wide_status == 200 and wide_png == Path(sys.argv[5]).read_bytes(), 'Native/WASM tiled wide PNG mismatch'
        assert call('/api/design/render', 'POST', {'document': document, 'options': {**render_options, 'rasterProfile': 'invalid'}})[0] == 422
        for density in [1, 2]:
            options = {**render_options, 'pixelPreview': density}
            status, preview = call('/api/design/render', 'POST', {'document': document, 'options': options})
            assert status == 200 and preview.startswith(b'\x89PNG\r\n\x1a\n')
            replica_preview = call('/api/design/render', 'POST', {'document': document, 'options': options}, server=1)[1]
            if replica_preview != preview:
                (run / 'failed-preview-first.png').write_bytes(preview)
                (run / 'failed-preview-second.png').write_bytes(replica_preview)
                raise AssertionError('Cross-replica PNG differs; diagnostic PNGs retained')
            if len(sys.argv) > 3:
                expected = Path(sys.argv[3]) / f'native-preview-{density}-wasm.png'
                assert preview == expected.read_bytes(), f'Native/WASM {density}x preview PNG mismatch'
        assert call('/api/design/render', 'POST', {'document': document, 'options': {**render_options, 'pixelPreview': 3}})[0] == 422
        assert call('/api/design/render', 'POST', {'document': document, 'options': {**render_options, 'pixelPreview': 2, 'view': {'x': 0, 'y': 0, 'zoom': .001}}})[0] == 422
        # Exercise managed storage and the real HDR export route even when the
        # default contract fixture is an empty legacy document.
        managed = json.loads(json.dumps(document))
        managed_id = str(uuid.uuid4())
        managed['id'] = managed_id
        managed['schemaVersion'] = max(3, document['schemaVersion'])
        managed['rasterProfile'] = 'figma'
        managed['colorManagement'] = {'documentSpace': 'srgb', 'referenceWhiteNits': 203, 'peakLuminanceNits': 1000}
        node_id = str(uuid.uuid4())
        managed['nodes'][node_id] = {'id': node_id, 'name': 'HDR API probe', 'kind': 'rectangle', 'transform': [1,0,0,1,0,0], 'width': 8, 'height': 8, 'children': [], 'visible': True, 'locked': False, 'opacity': 1, 'blend': 'normal', 'fills': [{'kind': 'solid', 'color': 'color(srgb-linear 4 2 1)', 'opacity': 1, 'angle': 0, 'stops': [{'offset': 0, 'color': '#ffffff'}, {'offset': 1, 'color': '#000000'}]}], 'strokes': [], 'effects': [], 'radii': [0,0,0,0], 'smoothing': 0, 'clip': False, 'mask': False, 'points': 6, 'innerRadius': 0.45, 'text': '', 'fontSize': 28}
        managed['pages'][0]['children'].append(node_id)
        managed_path = f'/api/design/documents/{managed_id}'
        assert call(managed_path, 'PUT', {'document': managed, 'revision': 0, 'requestId': str(uuid.uuid4())})[0] == 200
        assert call(managed_path, server=1)[1]['document'] == managed
        for space, codes in [('srgb',[1,13,0,1]), ('display-p3',[12,13,0,1]), ('rec2100-pq',[9,16,0,1]), ('rec2100-hlg',[9,18,0,1]), ('a98-rgb',None), ('prophoto-rgb',None)]:
            export_options = {**render_options, 'width': 16, 'height': 16, 'view': {'x':0,'y':0,'zoom':1}, 'colorOutput': {'space': space, 'toneMap': 'none'}}
            status, tagged = call('/api/design/render', 'POST', {'document': managed, 'options': export_options})
            assert status == 200 and tagged[24] == 16, 'Managed export is not 16-bit PNG'
            offset = 8
            chunks = {}
            while offset + 12 <= len(tagged):
                length = int.from_bytes(tagged[offset:offset+4], 'big')
                chunks[tagged[offset+4:offset+8]] = tagged[offset+8:offset+8+length]
                offset += length + 12
            if codes is not None:
                assert list(chunks[b'cICP']) == codes
            else:
                assert b'cICP' not in chunks
            if space in ['srgb','display-p3','a98-rgb','prophoto-rgb']:
                assert b'iCCP' in chunks
            assert call('/api/design/render', 'POST', {'document': managed, 'options': export_options}, server=1)[1] == tagged
        assert call('/api/design/render', 'POST', {'document': managed, 'options': {**render_options, 'colorOutput': {'space':'unknown'}}})[0] == 422
        assert call(path, 'PUT', request, server=1)[1]['revision'] == 1
        mismatch = {**request, 'document': {**document, 'name': 'different'}}
        assert call(path, 'PUT', mismatch)[0] == 409
        stale = {**request, 'requestId': str(uuid.uuid4())}
        assert call(path, 'PUT', stale)[0] == 409
        invalid = {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': {**document, 'pages': []}}
        assert call(path, 'PUT', invalid)[0] == 422
        if document['nodes']:
            first = next(iter(document['nodes']))
            malformed = json.loads(json.dumps(document))
            malformed['nodes'][first]['blend'] = 'unknown-mode'
            assert call('/api/design/render', 'POST', {'document': malformed, 'options': render_options})[0] == 422
            assert call(path, 'PUT', {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': malformed})[0] == 422
        paint_node = next((key for key, node in document['nodes'].items() if node.get('fills')), None)
        if paint_node:
            malformed = json.loads(json.dumps(document))
            malformed['nodes'][paint_node]['fills'][0]['blend'] = 'pass-through'
            assert call('/api/design/render', 'POST', {'document': malformed, 'options': render_options})[0] == 422
            assert call(path, 'PUT', {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': malformed})[0] == 422
        layout_nodes = [key for key, node in document['nodes'].items() if node.get('layout')]
        if layout_nodes:
            malformed = json.loads(json.dumps(document))
            malformed['nodes'][layout_nodes[0]]['layout']['columns'] = 0
            assert call(path, 'PUT', {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': malformed})[0] == 422
        instance_nodes = [key for key, node in document['nodes'].items() if node.get('instance') and not node.get('instanceOrigin')]
        profile_nodes = [key for key, node in document['nodes'].items() if any(s.get('widthProfile') for s in node.get('strokes', []))]
        if profile_nodes:
            for profile in [[{'position': 0, 'left': -1, 'right': 1}], [{'position': 0.5, 'left': 1, 'right': 1}, {'position': 0.5, 'left': 2, 'right': 2}]]:
                malformed = json.loads(json.dumps(document))
                malformed['nodes'][profile_nodes[0]]['strokes'][0]['widthProfile'] = profile
                assert call(path, 'PUT', {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': malformed})[0] == 422
                assert call('/api/design/render', 'POST', {'document': malformed, 'options': render_options})[0] == 422
        if instance_nodes:
            for override in [{'width': -10}, {'children': []}, {'fills': [{'kind': 'image', 'color': '#ffffff', 'opacity': 1, 'angle': 0, 'stops': [{'offset': 0, 'color': '#ffffff'}, {'offset': 1, 'color': '#000000'}], 'image': 'https://example.com/image.png'}]}]:
                malformed = json.loads(json.dumps(document))
                malformed['nodes'][instance_nodes[0]]['instance']['overrides']['$root'] = override
                assert call(path, 'PUT', {**request, 'revision': 1, 'requestId': str(uuid.uuid4()), 'document': malformed})[0] == 422
        def edit(i):
            return call(path, 'PUT', {'document': {**document, 'name': f'parallel-{i}'}, 'revision': 1, 'requestId': str(uuid.uuid4())}, server=i % 2)[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(edit, range(8)))
        assert results.count(200) == 1 and results.count(409) == 7
        assert call(path)[1]['revision'] == 2
        assert call(path, 'PUT', request, server=1)[1]['revision'] == 1
        assert call('/api/design/documents')[1][0]['revision'] == 2
        processes[0].send_signal(signal.SIGINT)
        processes[0].wait(timeout=10)
        assert call(path, server=1)[1]['revision'] == 2
        status, api = call('/api-doc/openapi.json', server=1)
        assert status == 200 and '/api/design/documents/{id}' in api['paths']
        print('PASS: authentication, migrations, save/read, cross-replica idempotency, conflicting receipts, stale revisions, invalid document, concurrent writes, replica shutdown, OpenAPI, native PNG render, 1x/2x pixel preview, cross-replica pixel consistency, render limits, managed schema color roundtrip, tagged 16-bit sRGB/P3/PQ/HLG exports')
    finally:
        for process in processes:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
        if started:
            subprocess.run(['pg_ctl', '-D', str(run / 'pg'), '-m', 'fast', '-w', 'stop'], check=True, stdout=log, stderr=log)
        log.close()
        print(f'Private test artifacts: {run}')


if __name__ == '__main__':
    main()
