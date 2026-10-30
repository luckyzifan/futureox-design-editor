#!/usr/bin/env python3
"""Independent Fraction integration and RNE corpus for Q48 filter certification."""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import random
import struct
from fractions import Fraction as Q

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('filter_oracle', Path(__file__).with_name('generate-filter-vectors.py'))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
destination = ROOT / 'testing/fixtures/design/certified-filter-vectors.json'

def corpus():
    rng = random.Random(202610100648)
    kernels, cases = [], []
    for kind, radius in [('tent', r) for r in [2.**-150, .1, .5, math.nextafter(1., 2.), 1.1, 2.5, 8.125, 32.125, 511.125, 1024., 1224.3035888671875, math.nextafter(2048.,0.), 2048.]] + [('box', r) for r in [0, 1, 7, 32, 512]]:
        reach = math.ceil(radius)
        side = [oracle.integrate(Q.from_float(float(radius)), i) for i in range(reach+1)] if kind == 'tent' else [Q(1, 2*reach+1)]*(reach+1)
        kernel = len(kernels)
        kernels.append({'kind': kind, 'radiusBits': struct.pack('>d', float(radius)).hex(), 'q48': [str((w.numerator << 48)//w.denominator) for w in side], 'q64': [str((w.numerator << 64)//w.denominator) for w in side]})
        size = 2*reach+1
        for family in range(14 if reach > 512 else 12):
            values=[]
            for i in range(size):
                mantissa=rng.randrange(1, 0x800000)
                if family==0: bits=0
                elif family==1: bits=(i%2)<<31
                elif family==2: bits=mantissa | (rng.randrange(2)<<31)
                elif family in [3,4]: bits=(rng.randrange(124,130)<<23)|mantissa|((rng.randrange(2) if family==4 else 0)<<31)
                elif family in [5,6]: bits=((97 if i%2 else 137)<<23)|mantissa|((rng.randrange(2) if family==6 else 0)<<31)
                elif family==7: bits=((97 if i%2 else 138)<<23)|mantissa
                elif family==8: bits=rng.randrange(0x7f800000)|(rng.randrange(2)<<31)
                elif family==9: bits=0x7f7fffff
                elif family==10: bits=0x3f800000 | ((i%2)<<31)
                elif family in [12,13]: bits=((97 if i%2 else 97+family+26)<<23)|mantissa|((rng.randrange(2))<<31)
                else: bits=1 | ((i%2)<<31)
                values.append(bits)
            exact=sum(side[abs(i-reach)]*oracle.rounding.exact(v) for i,v in enumerate(values))
            cases.append({'kernel': kernel, 'family': family, 'values': values, 'expected': oracle.rounding.binary32(exact)})
    kernel=next(i for i,k in enumerate(kernels) if k['kind']=='tent' and k['radiusBits']==struct.pack('>d', .5).hex())
    # w_side=1/12: adding 6 ulps at one side creates a true half-ulp tie.
    for base in [0x3f800000, 0x3f800001, 0x00800000, 1]:
        for delta in [5,6,7]:
            for sign in [0,0x80000000]:
                values=[base|sign, base|sign, (base+delta)|sign]
                exact=sum(oracle.integrate(Q(1,2),abs(i-1))*oracle.rounding.exact(v) for i,v in enumerate(values))
                cases.append({'kernel': kernel, 'family': 'half-ulp-neighbor', 'values': values, 'expected': oracle.rounding.binary32(exact)})
    return {'contract': 'Independent Fraction piecewise integral coefficients, Q48 floor, exact signed binary32 tap sum, final ties-to-even rounding. An uncertain certificate must decline.', 'kernels': kernels, 'cases': cases}

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args=parser.parse_args()
encoded=json.dumps(corpus(), separators=(',', ':'))+'\n'
if args.check:
    if destination.read_text()!=encoded: raise SystemExit('Certified filter oracle corpus is stale')
else: destination.write_text(encoded)
print('Q48 independent filter vectors match')
