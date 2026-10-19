#!/usr/bin/env python3
"""Generate the bounded integer sampling block, preserving the existing sampler."""
import argparse
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rational_generator', Path(__file__).with_name('generate-rational-glsl.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
source = (ROOT / 'design-studio/crates/design-kernel/shaders/sampling.wgsl').read_text()
source = source.split('// BEGIN BOUNDED BILINEAR\n', 1)[1].split('// END BOUNDED BILINEAR', 1)[0]
source = source.replace('bitcast<vec4<u32>>(', 'floatBitsToUint(')
destination = ROOT / 'frontend/design-client/src/kernel/gpu/sampling.glsl'
block = 'uint sbSelect(uint a,uint b,bool s){return s?b:a;}\nint sbSelect(int a,int b,bool s){return s?b:a;}\nfloat sbSelect(float a,float b,bool s){return s?b:a;}\n' + generator.translate(source).replace('rfSelect(', 'sbSelect(')
text = destination.read_text()
expected = generator.replace_block(text, 'BOUNDED BILINEAR', block)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
if args.check:
    if text != expected: raise SystemExit('Generated bounded sampler is stale')
else: destination.write_text(expected)
print('Bounded exact WGSL/GLSL samplers match')
