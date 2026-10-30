#!/usr/bin/env python3
"""Compare unmodified Figma browser exports with current kernel readbacks.

First run frontend/design-client/scripts/check-gpu-parity.ts with
DESIGN_PARITY_INPUT pointing at the reference directory's cases.json. Its
nonzero exit is retained when internal parity fails. This reporter also fails
on any strict external difference or missing/different internal backend.
Requires Pillow; never aligns, rescales, blurs or regenerates reference pixels.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
PROFILES = ('analytic', 'figma', 'figmaSubpixel')
BACKENDS = ('cpu', 'rust-cpu', 'native', 'webgpu', 'webgl2')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(a, b):
    if len(a) != len(b):
        raise ValueError('Readback dimensions differ')
    delta = [abs(x-y) for x, y in zip(a, b)]
    return {'differentBytes': sum(d != 0 for d in delta),
            'differentPixels': sum(any(delta[i:i+4]) for i in range(0, len(delta), 4)),
            'maximum': max(delta, default=0), 'meanAbsoluteError': sum(delta)/len(delta)}


def verified_native_reuse(report, binary_hash, request, profile, case_id, backend, repeat=1):
    """Reuse only a successful, byte-verified native run of the exact input.

    Commands in a prior report are read as evidence, never executed. A changed
    binary/input requires a fresh run. Corrupt matching evidence is an error.
    """
    if report is None or report.get('nativeBinarySha256') != binary_hash:
        return None
    matching = [e for e in report['executions'] if
                (e['profile'], e['case'], e['backend']) == (profile, case_id, backend)]
    if not matching:
        return None
    if len(matching) != 1:
        raise ValueError('Ambiguous prior native execution')
    entry = matching[0]
    if entry['exit'] != 0:
        return None
    command = entry['command']
    def argument(flag):
        return command[command.index(flag)+1]
    driver = 'cpu' if backend == 'rust-cpu' else 'metal'
    if argument('--backend') != driver or int(argument('--repeat')) != repeat or json.loads(Path(argument('--input')).read_text()) != json.loads(request.read_text()):
        return None
    rgba = Path(argument('--rgba'))
    rows = [r for r in report['rows'] if
            (r['profile'], r['case'], r['backend']) == (profile, case_id, backend)]
    if len(rows) != 1 or 'error' in rows[0] or digest(rgba) != rows[0]['sha256']:
        raise ValueError('Prior native readback is missing, corrupt, or ambiguous')
    return entry, rgba


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--references', type=Path, default=ROOT/'frontend/design-client/public/fidelity/browser-2026-10-07')
    parser.add_argument('--readbacks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-binary', type=Path, required=True)
    parser.add_argument('--reuse-native-report', type=Path,
                        help='Prior report; verify binary SHA, complete input, driver, exit and RGBA SHA before reusing native outputs')
    parser.add_argument('--figma-url', default='https://www.figma.com/design/KawVhUXCap10WDTprxYEmu/')
    parser.add_argument('--repeat', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.repeat <= 100:
        parser.error('--repeat must be 1..100')
    refs, readbacks, out = args.references.resolve(), args.readbacks.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    images = out/'images'
    images.mkdir(exist_ok=True)
    native = out/'native'
    native.mkdir(exist_ok=True)
    cases = json.loads((refs/'cases.json').read_text())
    browser = json.loads((readbacks/'results.json').read_text())
    reuse_report = json.loads(args.reuse_native_report.read_text()) if args.reuse_native_report else None
    binary_hash = digest(args.native_binary.resolve())
    if not cases:
        raise ValueError('An empty reference set cannot pass acceptance')
    expected_records = {(profile, index) for profile in PROFILES for index in range(len(cases))}
    actual_records = [(r['profile'], r['index']) for r in browser['records']]
    if len(actual_records) != len(expected_records) or set(actual_records) != expected_records:
        raise ValueError('Browser run must cover every case on every profile exactly once')
    rows, internal, executions = [], [], []
    for index, case in enumerate(cases):
        ref = refs/case['reference']
        if digest(ref) != case['referenceSha256']:
            raise ValueError(f'Reference changed: {ref}')
        reference = Image.open(ref).convert('RGBA')
        if reference.size != (case['options']['width'], case['options']['height']):
            raise ValueError(f'Reference size mismatch: {ref}')
        reference.save(images/f'{index}-figma.png')
        reference_bytes = reference.tobytes()
        for profile in PROFILES:
            directory = readbacks/f'{profile}-{index}'
            request = directory/'request.json'
            expected = {'document': case['document'], 'options': {**case['options'], 'rasterProfile': profile}}
            if json.loads(request.read_text()) != expected:
                raise ValueError(f'Readbacks came from different inputs: {request}')
            outputs = {b: directory/f'{b}.rgba' for b in ('cpu', 'webgpu', 'webgl2')}
            errors = {}
            for backend, driver in [('rust-cpu', 'cpu'), ('native', 'metal')]:
                prefix = native/f'{profile}-{index}-{backend}'
                rgba = prefix.with_suffix('.rgba')
                # Never read stale output after a failed command.
                if rgba.exists():
                    raise ValueError(f'Use a fresh output directory: {rgba}')
                cached = verified_native_reuse(reuse_report, binary_hash, request, profile, case['id'], backend, args.repeat)
                if cached is not None:
                    original, source = cached
                    shutil.copyfile(source, rgba)
                    log = source.with_suffix('.log')
                    if log.exists():
                        shutil.copyfile(log, prefix.with_suffix('.log'))
                    executions.append({**original, 'reusedFrom':str(args.reuse_native_report.resolve()),
                                       'verifiedRequestSha256':digest(request), 'verifiedRgbaSha256':digest(rgba)})
                    outputs[backend] = rgba
                    continue
                command = [str(args.native_binary.resolve()), '--input', str(request),
                           '--output', str(prefix.with_suffix('.png')), '--rgba', str(rgba),
                           '--backend', driver, '--repeat', str(args.repeat)]
                result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
                prefix.with_suffix('.log').write_text(result.stdout + result.stderr)
                executions.append({'profile': profile, 'case': case['id'], 'backend': backend,
                                   'exit': result.returncode, 'command': command})
                if result.returncode:
                    errors[backend] = (result.stdout + result.stderr).strip()[-1600:]
                else:
                    outputs[backend] = rgba
            for backend in BACKENDS:
                path = outputs.get(backend)
                row = {'case': case['id'], 'index': index, 'profile': profile, 'backend': backend,
                       'width': reference.width, 'height': reference.height,
                       'strictComparable': case['strictComparable']}
                if path is None or not path.exists():
                    row['error'] = errors.get(backend, 'Missing readback')
                else:
                    actual = path.read_bytes()
                    row.update(metrics(reference_bytes, actual))
                    row['sha256'] = digest(path)
                    image = Image.frombytes('RGBA', reference.size, actual)
                    image.save(images/f'{index}-{profile}-{backend}.png')
                    if backend == 'cpu':
                        # This amplification is for viewing only. Metrics always
                        # compare the original raw RGBA bytes, including alpha.
                        delta = ImageChops.difference(reference, image).convert('RGB')
                        delta.point(lambda x: min(255, x*8)).save(images/f'{index}-{profile}-diff.png')
                rows.append(row)
                if backend != 'cpu':
                    entry = {'case': case['id'], 'profile': profile, 'backend': backend}
                    if 'error' in row or not outputs['cpu'].exists():
                        entry['error'] = row.get('error', 'Missing WASM CPU readback')
                    else:
                        entry.update(metrics(outputs['cpu'].read_bytes(), path.read_bytes()))
                    internal.append(entry)
        print(json.dumps({'case': case['id'], 'state': 'compared'}), flush=True)
    strict = [r for r in rows if r['strictComparable']]
    strict_count = sum(bool(c['strictComparable']) for c in cases)
    generated = datetime.now(timezone.utc).isoformat()
    report = {'referenceProvenance': json.loads((refs/'provenance.json').read_text()),
              'generatedUTC': generated, 'caseCount': len(cases), 'strictCaseCount': strict_count,
              'nativeBinarySha256': binary_hash,
              'casesSha256': digest(refs/'cases.json'), 'browserMetadata': browser['metadata'],
              'browserEvidenceSources': browser.get('sourceRuns', []),
              'verifiedNativeReuseCount': sum('reusedFrom' in e for e in executions),
              'browserInternalFailures': browser['failures'],
              'numericFailures': browser['numericalFailures'],
              'scope': f'{len(cases)} controlled real Figma PNG fixtures at the recorded original resolutions; {strict_count} common-parameter cases. Other mappings are explicitly approximate. Not a Figma feature coverage percentage.',
              'strictExternalPassed': bool(strict) and not any(r.get('differentBytes', 1) for r in strict),
              'internalPassed': not browser['failures'] and not browser['numericalFailures'] and not any(r.get('differentBytes', 1) for r in internal),
              'rows': rows, 'internalComparisons': internal, 'executions': executions}
    (out/'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    font = ImageFont.load_default(size=13)
    sheet = Image.new('RGB', (848, 88 + ((len(cases)+1)//2)*192), '#f4f6f8')
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 12), 'Figma browser PNG / kernel figma profile / RGB difference x8', font=font, fill='#17202a')
    draw.text((16, 36), '128px nearest-neighbor thumbnails ONLY. Metrics use original raw RGBA; ZERO difference required.', font=font, fill='#384450')
    blocks = []
    for index, case in enumerate(cases):
        x, y = 16+(index % 2)*424, 70+(index//2)*192
        label = case['id'] + ('' if case['strictComparable'] else ' [approximate mapping]')
        draw.text((x, y), label, font=font, fill='#17202a')
        for col, suffix in enumerate(('figma', 'figma-cpu', 'figma-diff')):
            path = images/f'{index}-{suffix}.png'
            if path.exists():
                sheet.paste(Image.open(path).convert('RGB').resize((128, 128), Image.Resampling.NEAREST), (x+col*132, y+22))
        row = next(r for r in rows if r['index'] == index and r['profile'] == 'figma' and r['backend'] == 'cpu')
        label_metrics = f"changed pixels {row.get('differentPixels','missing')}; max channel {row.get('maximum','missing')}/255"
        draw.text((x, y+154), label_metrics, font=font, fill='#384450')
        profile_blocks = []
        for profile in PROFILES:
            measured = [r for r in rows if r['index'] == index and r['profile'] == profile]
            lines = ''.join('<tr><td>'+html.escape(r['backend'])+'</td><td>'+html.escape(str(r.get('differentPixels','unavailable')))+'</td><td>'+html.escape(str(r.get('maximum','—')))+'</td><td>'+html.escape(r.get('error',''))+'</td></tr>' for r in measured)
            profile_blocks.append(f'<section data-profile="{profile}"><div class="triplet"><figure><img src="images/{index}-figma.png"><figcaption>Figma 浏览器导出</figcaption></figure><figure><img src="images/{index}-{profile}-cpu.png"><figcaption>内核 WASM CPU · {profile}</figcaption></figure><figure><img src="images/{index}-{profile}-diff.png"><figcaption>RGB 差值 ×8（黑色为零）</figcaption></figure></div><table><tr><th>后端</th><th>不同像素</th><th>最大通道差 /255</th><th>错误</th></tr>{lines}</table></section>')
        blocks.append('<article><h2>'+html.escape(case['id'])+'</h2><p>'+html.escape(case.get('mappingNote','') or '共同参数，严格逐字节比较。')+'</p>'+''.join(profile_blocks)+'</article>')
    sheet.save(out/'figma-comparison.png')
    page = '''<!doctype html><meta charset="utf-8"><title>设计内核与 Figma 实测对照</title>
<style>body{font:15px system-ui;background:#f4f6f8;color:#19222c;max-width:1080px;margin:32px auto;padding:0 20px}header{position:sticky;top:0;background:#f4f6f8;padding:12px 0;z-index:1}article{background:white;padding:20px;margin:20px 0;border-radius:12px}h1{font-size:25px}h2{font-size:20px}.triplet{display:flex;gap:20px;flex-wrap:wrap}figure{margin:0}img{width:256px;height:256px;image-rendering:pixelated;border:1px solid #d8dce0}figcaption{padding:8px 0}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:8px;border-top:1px solid #dde2e8}td:last-child{max-width:500px;overflow-wrap:anywhere;color:#993c33}select{font:inherit;padding:6px}section[hidden]{display:none}</style>
<header><h1>设计内核与 Figma：真实浏览器导出对照</h1><label>内核剖面 <select id="profile"><option>figma</option><option>figmaSubpixel</option><option>analytic</option></select></label></header>
<p><strong>外部 Figma 严格验收：__EXTERNAL_STATUS__。内部后端一致性：__INTERNAL_STATUS__。</strong></p>
<p>__CASE_COUNT__ 组控制变量样本，按各样本记录的原始导出尺寸比较；__STRICT_COUNT__ 组共同参数进入严格比较，其余映射在各样本中注明。此数量不是 Figma 功能覆盖率。生成时间：__GENERATED__。</p>
<p>RGBA 原字节参与判定，任何非零差异均失败。可视差值图仅将 RGB 差值放大 8 倍；浏览预览统一显示为 256×256 最近邻图，未缩放比较数据。内部后端一致性和 Figma 外部保真分开统计。三个剖面均请求全部后端，缺失后端记为失败。</p>
<p>经完整输入、二进制、驱动与 RGBA 校验和核验后复用了 __REUSE_COUNT__ 项原生读回；原执行命令、来源及本次重新执行记录见 results.json。</p>
<p><a href="results.json">完整指标、错误与命令</a> · <a href="__FIGMA_URL__">Figma 校准文件</a></p>
'''+''.join(blocks)+'''<script>const select=document.querySelector('#profile');function update(){for(const section of document.querySelectorAll('[data-profile]'))section.hidden=section.dataset.profile!==select.value}select.addEventListener('change',update);update()</script>'''
    page = (page.replace('__CASE_COUNT__', str(len(cases)))
            .replace('__REUSE_COUNT__', str(report['verifiedNativeReuseCount']))
            .replace('__STRICT_COUNT__', str(strict_count))
            .replace('__GENERATED__', html.escape(generated))
            .replace('__EXTERNAL_STATUS__', '通过' if report['strictExternalPassed'] else '未通过')
            .replace('__INTERNAL_STATUS__', '通过' if report['internalPassed'] else '未通过')
            .replace('__FIGMA_URL__', html.escape(args.figma_url, quote=True)))
    (out/'index.html').write_text(page)
    print(json.dumps({'output': str(out), 'strictExternalPassed': report['strictExternalPassed'], 'internalPassed': report['internalPassed']}))
    return 0 if report['strictExternalPassed'] and report['internalPassed'] and not browser['numericalFailures'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
