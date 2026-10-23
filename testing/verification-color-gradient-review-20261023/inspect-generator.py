#!/usr/bin/env python3
"""Read-only diagnosis; temporary translator changes exist only in memory.

No generated source is written. Accepting empty parameters and suppressing the
final guard below are diagnostic probes, not proposed production fixes.
"""
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / 'design-studio/scripts/generate-rational-glsl.py'
spec = importlib.util.spec_from_file_location('audit_generator', path)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
source = (ROOT / 'design-studio/crates/design-kernel/shaders/vector.wgsl').read_text()
blocks = {
    label: source.split('// BEGIN GENERATED ' + label + ' SOURCE\n', 1)[1]
                 .split('// END GENERATED ' + label + ' SOURCE', 1)[0]
    for label in ['MATERIAL MATH', 'BLEND MATH']
}
composite = source[source.index('fn blendRN('):source.index('fn fixedLinear(')]
for name, kind in [('cb', 'vec3<f32>'), ('cs', 'vec3<f32>'),
                   ('components', 'vec3<f32>'), ('m', 'vec4<f32>'),
                   ('left', 'vec4<f32>'), ('middle', 'vec4<f32>'),
                   ('right', 'vec4<f32>'), ('rgb', 'vec4<f32>')]:
    composite = re.sub(r'\b(let|var) ' + name + '=', r'\1 ' + name + ':' + kind + '=', composite)
blocks['BLEND COMPOSITE'] = composite
for name in ['coverage64', 'area']:
    blocks[name] = (ROOT / f'design-studio/crates/design-kernel/shaders/{name}.wgsl').read_text()

patched_source = path.read_text().replace(
    "parameter(p)for p in m[2].split(',')",
    "parameter(p)for p in m[2].split(',') if p.strip()",
)
patched = {'__name__': 'audit_only', '__file__': str(path)}
exec(compile(patched_source, str(path), 'exec'), patched)
unguarded = {'__name__': 'audit_only', '__file__': str(path)}
exec(compile(patched_source.replace("raise ValueError('Untranslated construct')", 'pass'),
             str(path), 'exec'), unguarded)
rows = []
for label, block in blocks.items():
    row = {'block': label, 'zeroArgumentFunctions': re.findall(r'fn (\w+)\(\)->', block)}
    for key, translate in [('current', generator.translate),
                           ('emptyArgumentSkipInMemoryOnly', patched['translate'])]:
        try:
            translate(block)
            row[key] = 'translated (not compiled or validated as GLSL)'
        except Exception as error:
            row[key] = type(error).__name__ + ': ' + str(error)
    diagnostic = unguarded['translate'](block)
    row['residualWgslDiagnosticOnly'] = [
        line.strip() for line in diagnostic.splitlines()
        if re.search(r'\b(fn|var|let|bitcast|array|u32|i32|f32)\b', line.split('//')[0])
    ]
    rows.append(row)
print(json.dumps(rows, indent=2))
