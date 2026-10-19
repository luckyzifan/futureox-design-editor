#!/usr/bin/env python3
"""Independent Fraction oracle and domain boundaries for the exact 128-bit sampler."""
import argparse
import importlib.util
import json
from pathlib import Path
import random
from fractions import Fraction as Q

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rounding_oracle', Path(__file__).with_name('generate-precision-vectors.py'))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
destination = ROOT / 'testing/fixtures/design/bounded-sampling-vectors.json'

def corpus():
    rng = random.Random(20261010682)
    rows = []
    def add(p, u, v):
        values = list(map(oracle.exact, p)); x, y = oracle.exact(u), oracle.exact(v)
        exact = values[0]*(1-x)*(1-y)+values[1]*x*(1-y)+values[2]*(1-x)*y+values[3]*x*y
        ku, kv = x.denominator.bit_length()-1, y.denominator.bit_length()-1
        exponents = [max(1,(bits>>23)&255) for bits in p if bits&0x7fffffff]
        span=max(exponents)-min(exponents) if exponents else 0
        positive = ku<=31 and kv<=31 and span<=48 and span+ku+kv<=102
        if positive:
            # Check the integer bound independently with arbitrary precision,
            # rather than relying on a wrapping 128-bit implementation.
            minimum=min(exponents) if exponents else 1
            weights=[(x.denominator-x.numerator)*(y.denominator-y.numerator), x.numerator*(y.denominator-y.numerator), (x.denominator-x.numerator)*y.numerator, x.numerator*y.numerator]
            integer=0; total_abs=0
            for bits,weight in zip(p,weights):
                e=(bits>>23)&255; m=(bits&0x7fffff)|(0x800000 if e else 0)
                term=m*weight << (max(e,1)-minimum) if m else 0
                total_abs+=term; integer+=-term if bits>>31 else term
            assert total_abs < 1<<126 and -(1<<127)<integer<(1<<127)
            quantum=minimum-150-ku-kv
            reconstructed=Q(integer*(1<<quantum)) if quantum>=0 else Q(integer,1<<-quantum)
            assert reconstructed==exact
        # Independent reconstruction of the original nine signed monomials.
        one=0x3f800000
        terms=[]
        for sample,left,right,minus in [(p[0],one,one,False),(p[0],u,one,True),(p[0],v,one,True),(p[0],u,v,False),(p[1],u,one,False),(p[1],u,v,True),(p[2],v,one,False),(p[2],u,v,True),(p[3],u,v,False)]:
            components=[((bits&0x7fffff)|(0x800000 if (bits>>23)&255 else 0),max(1,(bits>>23)&255)) for bits in [sample,left,right]]
            product=components[0][0]*components[1][0]*components[2][0]
            if product: terms.append((product,sum(component[1] for component in components), bool(sample>>31)!=minus))
        sums=[term[1] for term in terms]
        windowed=not sums or max(sums)-min(sums)<=50
        if windowed and sums:
            minimum=min(sums);integer=0;total_abs=0
            for product,exponent,negative in terms:
                value=product<<(exponent-minimum);total_abs+=value;integer+=-value if negative else value
            assert total_abs<1<<126 and -(1<<127)<integer<(1<<127)
            quantum=minimum-450
            reconstructed=Q(integer*(1<<quantum)) if quantum>=0 else Q(integer,1<<-quantum)
            assert reconstructed==exact
        rows.append([*p,u,v,oracle.binary32(exact),int(positive or windowed)])
    weight_bits=[oracle.binary32(Q(0)), oracle.binary32(Q(1)), oracle.binary32(Q(1,2)), oracle.binary32(Q(1,1<<24)), oracle.binary32(Q((1<<24)-1,1<<24)), oracle.binary32(Q(1,1<<25)), oracle.binary32(Q((1<<24)-1,1<<25))]
    patterns=[
        [0,0x80000000,0,0x80000000], [1,2,0x80000003,0x7fffff],
        [0x3f800000,0x3f800001,0x3f800002,0x3f800003],
        [0x3f800000,0xbf800000,0xbf800000,0x3f800000],
        [(96<<23)|1,(144<<23)|0x7fffff,(120<<23)|0x100,0],
        [(96<<23)|1,(145<<23)|0x7fffff,(120<<23)|0x100,0],
        [0x7f7fffff,0xff7fffff,0x7f7ffffe,0xff7ffffe],
    ]
    for p in patterns:
        for u in weight_bits:
            for v in weight_bits: add(p,u,v)
    for _ in range(256):
        base=rng.randrange(1,206); span=rng.choice([0,1,24,47,48,49])
        p=[((base+rng.randrange(span+1))<<23)|rng.randrange(0x800000)|(rng.randrange(2)<<31) for _ in range(4)]
        p[0]=(p[0]&0x807fffff)|(base<<23);p[1]=(p[1]&0x807fffff)|((base+span)<<23)
        ku,kv=rng.choice([1,12,23,24,25]),rng.choice([1,12,23,24,25])
        u=oracle.binary32(Q(rng.randrange(1,1<<min(ku,24))|1,1<<ku));v=oracle.binary32(Q(rng.randrange(1,1<<min(kv,24))|1,1<<kv))
        add(p,u,v)
    for denominator in range(25,41):
        for _ in range(8):
            p=[(rng.randrange(122,132)<<23)|rng.randrange(0x800000)|(rng.randrange(2)<<31) for _ in range(4)]
            add(p,oracle.binary32(Q((1<<23)-1,1<<denominator)),oracle.binary32(Q((1<<23)-3,1<<denominator)))
    for u_power,v_power in [(25,25),(25,26),(50,0),(51,0)]:
        for p in patterns:
            add(p,oracle.binary32(Q(1,1<<u_power)),oracle.binary32(Q(1,1<<v_power)))
    # Coupled denominator/span limits, including the forbidden 32-bit shift.
    for ku,kv in [(24,31),(25,31),(26,31),(30,30),(31,31),(31,32),(32,31)]:
        for span in [max(0,102-ku-kv-1),max(0,102-ku-kv),max(0,102-ku-kv+1),48,49]:
            for _ in range(8):
                p=[((80+e)<<23)|rng.randrange(0x800000)|(rng.randrange(2)<<31) for e in [0,span,span//2,span]]
                u=oracle.binary32(Q((1<<23)+1,1<<ku));v=oracle.binary32(Q((1<<23)+3,1<<kv))
                add(p,u,v)
    # Explicit holdout outside both 128-bit domains: large samples can balance
    # very small interpolation weights and require the original wide program.
    for _ in range(64):
        p=[(exponent<<23)|rng.randrange(0x800000)|(rng.randrange(2)<<31) for exponent in [100,200,100,200]]
        add(p,oracle.binary32(Q(1,1<<100)),oracle.binary32(Q(1,2)))
    return {'contract': 'four finite binary32 samples, exact dyadic bilinear, one final RNE; column 7 is direct 4-positive-or-9-windowed helper acceptance, not outer same/corner dispatch', 'vectors': rows}

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
encoded=json.dumps(corpus(),separators=(',',':'))+'\n'
if args.check:
    if destination.read_text()!=encoded:raise SystemExit('Bounded sampler corpus is stale')
else:destination.write_text(encoded)
print(f'{len(json.loads(encoded)["vectors"])} independent bounded-sampler vectors verified')
