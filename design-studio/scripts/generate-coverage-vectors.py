#!/usr/bin/env python3
"""Independent binary64-operation -> binary32 coverage oracle (exact Fraction)."""
import argparse
from fractions import Fraction as Q
import importlib.util
import json
import math
from pathlib import Path
import random
import struct

ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'testing/fixtures/design/coverage-vectors.json'
spec=importlib.util.spec_from_file_location('rounding',Path(__file__).with_name('generate-precision-vectors.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

def exact64(bits):
    e=(bits>>52)&2047;m=bits&((1<<52)-1)
    assert e!=2047
    value=Q(m)*r.power(-1074) if e==0 else Q(m+(1<<52))*r.power(e-1075)
    return -value if bits>>63 else value

def rounded64(value):
    assert value>=0
    if not value:return 0
    e=value.numerator.bit_length()-value.denominator.bit_length()
    if value<r.power(e):e-=1
    if e < -1022:return r.nearest_integer(value/r.power(-1074))
    m=r.nearest_integer(value/r.power(e-52))
    if m==1<<53:m>>=1;e+=1
    return ((e+1023)<<52)|(m-(1<<52))

def corpus():
    assert rounded64(Q(1,10))==0x3fb999999999999a
    rng=random.Random(202610072)
    anchors=[0,1,0x000fffffffffffff,0x0010000000000000,0x3680000000000000,
             0x3e70000000000000,0x3fdfffffffffffff,0x3fe0000000000000,
             0x3fe0000000000001,0x3fefffffffffffff,0x3ff0000000000000]
    pairs=[(max(a,b),min(a,b))for a in anchors for b in anchors]
    pairs += [(max(a,b),min(a,b))for a,b in [(rng.randrange(0x3ff0000000000001),rng.randrange(0x3ff0000000000001))for _ in range(700)]]
    for _ in range(700):
        a,b=sorted([rng.random(),rng.random()],reverse=True)
        pairs.append(tuple(struct.unpack('>Q',struct.pack('>d',v))[0]for v in (a,b)))
    rows=[]
    for i,(right,left) in enumerate(pairs):
        yright,yleft=pairs[(i*127+19)%len(pairs)]
        x=exact64(rounded64(exact64(right)-exact64(left)))
        y=exact64(rounded64(exact64(yright)-exact64(yleft)))
        for operation in [0,1]:
            value=exact64(rounded64(x/8)) if operation==0 else exact64(rounded64(x*y))
            words=[operation]
            for b in [right,left,yright,yleft]:words.extend([b&0xffffffff,b>>32])
            words.extend([0]*(16-len(words)))
            rows.append({'words':words,'expected':r.binary32(value)})
    originals=[(-1e-20,-2e-20),(-1e-300,-2e-300),(.7,.2),(.5,-.5),(.5,.5),(math.nextafter(1.,0.),0.)]
    for _ in range(300):
        cell=rng.randrange(-10,11);a,b=sorted([rng.random()+cell,rng.random()+cell],reverse=True);originals.append((a,b))
    for original_right,original_left in originals:
        kr,kl=round(original_right),round(original_left)
        bias=kr-kl
        a,b=(struct.unpack('>Q',struct.pack('>d',v))[0]for v in (original_right-kr,original_left-kl))
        raw_a,raw_b=(struct.unpack('>Q',struct.pack('>d',v))[0]for v in (original_right,original_left))
        assert exact64(raw_a)-exact64(raw_b)==bias+exact64(a)-exact64(b)
        x=exact64(rounded64(exact64(raw_a)-exact64(raw_b)))
        for operation in [0,1]:
            value=exact64(rounded64(x/8)) if operation==0 else x
            words=[operation,a&0xffffffff,a>>32,b&0xffffffff,b>>32,0,0x3ff00000,0,0,bias,0,0,0,0,0,0]
            rows.append({'words':words,'raw':[f'{raw_a:016x}',f'{raw_b:016x}'],'expected':r.binary32(value)})
    return {'contract':'Binary64 endpoint remainders and integer bias define a width in [0,1]; binary64 RN difference then divide-by-eight or binary64 RN width*height; binary32 RNE output','cases':rows}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check',action='store_true');args=p.parse_args()
    data=json.dumps(corpus(),separators=(',',':'))+'\n'
    if args.check:
        if DEST.read_text()!=data:raise SystemExit('Coverage oracle is stale')
    else:DEST.write_text(data)
    print(len(json.loads(data)['cases']),'binary64 coverage vectors')
