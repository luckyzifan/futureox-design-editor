#!/usr/bin/env python3
"""Read-only static artifact checks. This does not run a browser or app renderer."""
import base64
import hashlib
from html.parser import HTMLParser
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
from PIL import Image

root = pathlib.Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
checks = []
def digest(data):
    return hashlib.sha256(data).hexdigest()
def check(name, condition, **detail):
    if not condition:
        raise AssertionError(name)
    checks.append({'name': name, 'passed': True, **detail})

class Html(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.resources = []
        self.scripts = 0
    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if 'id' in attributes:
            self.ids.append(attributes['id'])
        if tag == 'script':
            self.scripts += 1
        for key in ['src', 'href']:
            if key in attributes:
                self.resources.append(attributes[key])

for page in manifest['outputs']:
    name = page['name']
    directory = root / name
    code = json.loads((directory / 'export-manifest.json').read_text())
    html = Html()
    html.feed((directory / 'index.html').read_text())
    check(f'{name}: HTML contains exactly one element per native node', len(html.ids) == page['nodeCount'] and set(html.ids) == {item['elementId'] for item in code['nodeIdMap'].values()}, count=len(html.ids))
    check(f'{name}: no duplicate element IDs', len(set(html.ids)) == len(html.ids))
    check(f'{name}: no scripts or remote resource URLs', html.scripts == 0 and all('://' not in resource and not resource.startswith('//') for resource in html.resources))
    for resource in html.resources:
        check(f'{name}: local linked resource exists: {resource}', (directory / resource).is_file())
    css = (directory / 'styles.css').read_text()
    for resource in re.findall(r'url\([\'"]?([^\)\'"\s]+)', css):
        check(f'{name}: packaged CSS resource exists: {resource}', (directory / resource).is_file())
    check(f'{name}: exact raw API HTML hash', digest((directory / 'raw-api.html').read_bytes()) == page['htmlSha256'])
    check(f'{name}: exact raw API CSS hash', digest((directory / 'raw-api.css').read_bytes()) == page['cssSha256'])
    svg = directory / 'design.svg'
    check(f'{name}: exact native SVG hash', digest(svg.read_bytes()) == page['svgSha256'])
    tree = ET.parse(svg)
    check(f'{name}: native SVG geometry exists', len(tree.findall('.//{http://www.w3.org/2000/svg}path')) > 0)
    preview = Image.open(directory / 'cpu-svg-preview.png')
    check(f'{name}: CPU preview has expected dimensions and nonblank content', preview.size == (1440, 1000) and len(preview.convert('RGB').getcolors(10_000_000)) > 64)

font = (root / 'fonts/NotoSansSC.ttf').read_bytes()
native = json.loads((root / 'forma-studio.json').read_text())
check('Native editable node count matches manifest', len(native['nodes']) == manifest['nodeCount'])
check('Native original pages preserved', [page['name'] for page in native['pages']] == ['Workspace', 'Files', 'Settings'])
check('Packaged font is exactly the embedded native font', base64.b64decode(native['fonts']['forma-noto']['data']) == font)
check('Font hash matches source manifest', digest(font) == manifest['font']['sha256'])
check('Font license and provenance are present', (root / 'fonts/OFL.txt').is_file() and (root / 'fonts/source.json').is_file())
check('Saved FD hash and actual bytes match manifest', digest((root / 'forma-studio.fd').read_bytes()) == manifest['nativeFd']['sha256'] and (root / 'forma-studio.fd').stat().st_size == manifest['nativeFd']['bytes'])
check('Chinese text remains native and in editable HTML', native['nodes']['42000000-0000-4000-8000-000000000225']['text'] == '本地设计工作区' and '本地设计工作区' in (root / 'settings/raw-api.html').read_text())
check('Static HTML behavior limitation appears in generated UI', 'App behavior needs implementation.' in (root / 'settings/raw-api.html').read_text())
for asset in manifest['assets']:
    check(f"Exported editable asset matches hash: {asset['name']}", digest((root / asset['file']).read_bytes()) == asset['sha256'])

report = {'scope': 'Static delivery checks only; not browser or product renderer acceptance', 'passed': len(checks), 'failed': 0, 'checks': checks}
(root / 'delivery-audit.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'passed': len(checks), 'failed': 0}, indent=2))
