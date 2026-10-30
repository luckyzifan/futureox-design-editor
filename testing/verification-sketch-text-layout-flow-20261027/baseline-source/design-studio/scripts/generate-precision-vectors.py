#!/usr/bin/env python3
"""Independent binary32 RNE oracle: exact integers/Fraction, never host float math.

Goldberg (1991), Exactly Rounded Operations: round the exact result once.
This is test data generation, not a second implementation of the shader algorithm.
"""
import argparse
from fractions import Fraction
from decimal import Decimal, localcontext
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / 'testing/fixtures/design/arithmetic-vectors.json'


def power(exponent):
    return Fraction(2 ** exponent) if exponent >= 0 else Fraction(1, 2 ** -exponent)


def exact(bits):
    exponent, mantissa = (bits >> 23) & 255, bits & 0x7fffff
    assert exponent != 255
    value = mantissa * power(-149) if exponent == 0 else (mantissa + 2 ** 23) * power(exponent - 150)
    return -value if bits & 0x80000000 else value


def nearest_integer(value):
    q, r = divmod(value.numerator, value.denominator)
    return q + (2 * r > value.denominator or (2 * r == value.denominator and q % 2 == 1))


def binary32(value):
    sign = 0x80000000 if value < 0 else 0
    value = abs(value)
    if not value:
        return sign
    exponent = value.numerator.bit_length() - value.denominator.bit_length()
    if value < power(exponent):
        exponent -= 1
    if exponent < -126:
        return sign | nearest_integer(value / power(-149))
    mantissa = nearest_integer(value / power(exponent - 23))
    if mantissa == 2 ** 24:
        exponent += 1
        mantissa //= 2
    if exponent > 127:
        return sign | 0x7f800000
    return sign | ((exponent + 127) << 23) | (mantissa - 2 ** 23)


def square_root(bits):
    value = exact(bits)
    if not value:
        return bits
    lo, hi = 0, 0x7f800000
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if exact(mid) ** 2 <= value:
            lo = mid
        else:
            hi = mid
    midpoint = (exact(lo) + exact(hi)) / 2
    return lo + (value > midpoint ** 2 or (value == midpoint ** 2 and lo % 2 == 1))


def fused_multiply_add(a, b, c):
    """Exact Fraction product+sum, with explicit IEEE signed-zero/nonfinite rules."""
    av, bv, cv = (v & 0x7fffffff for v in (a, b, c))
    product_sign, addend_sign = (a ^ b) & 0x80000000, c & 0x80000000
    if any(v > 0x7f800000 for v in (av, bv, cv)):
        return 0x7fc00000
    if av == 0x7f800000 or bv == 0x7f800000:
        if av == 0 or bv == 0 or (cv == 0x7f800000 and product_sign != addend_sign):
            return 0x7fc00000
        return product_sign | 0x7f800000
    if cv == 0x7f800000:
        return c
    value = exact(a) * exact(b) + exact(c)
    if value == 0 and (av == 0 or bv == 0) and cv == 0:
        return product_sign & addend_sign
    return binary32(value)


def vectors():
    # Independent published binary32 anchors and both even/odd halfway cases.
    assert binary32(Fraction(1, 10)) == 0x3dcccccd
    assert binary32(Fraction(1) + power(-24)) == 0x3f800000
    assert binary32(Fraction(1) + 3 * power(-24)) == 0x3f800002
    assert binary32(power(-150)) == 0
    assert binary32(3 * power(-150)) == 2
    rng = random.Random(20261007)
    rows = []
    def division(a, b):
        value = exact(a) / exact(b)
        expected = binary32(value)
        if not exact(a):
            expected = (a ^ b) & 0x80000000
        rows.append([0, a, b, 0, expected])
    anchors = [1, 0x007fffff, 0x00800000, 0x00800001, 0x3eaaaaab, 0x3f000000,
               0x3f7fffff, 0x3f800000, 0x3f800001, 0x40000000, 0x7f7fffff]
    for a in anchors:
        for b in anchors:
            for sign in [0, 0x80000000]:
                division(a | sign, b)
    for _ in range(6000):
        division(rng.randrange(0x7f800000), rng.randrange(1, 0x7f800000))
    times = [0, 1, 0x007fffff, 0x00800000, 0x00800001, 0x2f000000,
             0x2f7fffff, 0x30000000, 0x3dcccccd, 0x3eaaaaab,
             0x3effffff, 0x3f000000, 0x3f000001, 0x3f7fffff, 0x3f800000]
    for a in range(256):
        for b in sorted({0, 1, 127, 128, 254, 255, a}):
            for t in times:
                rows.append([1, a, b, t, binary32(Fraction(a) + (b - a) * exact(t))])
    for _ in range(6000):
        a, b, t = rng.randrange(256), rng.randrange(256), rng.randrange(0x3f800001)
        rows.append([1, a, b, t, binary32(Fraction(a) + (b - a) * exact(t))])
    for bits in [24, 27, 31, 32, 33, 40, 52, 55, 63]:
        for value in [0, 1, 2 ** 23 - 1, 2 ** 24 + 1, 2 ** 24 + 3,
                      2 ** 55 - 1, 2 ** 56 + 1, 2 ** 63 - 1]:
            rows.append([2, value & 0xffffffff, value >> 32, bits, binary32(Fraction(value, 2 ** bits))])
    limits = [0, 1, 0x007fffff, 0x00800000, 0x00800001, 0x3f000000,
              0x3f7fffff, 0x3f800000, 0x3f800001, 0x7f7fffff]
    pairs = [(a | sa, b | sb) for a in limits for b in limits for sa in [0, 0x80000000] for sb in [0, 0x80000000]]
    pairs += [(rng.randrange(0x7f800000) | (rng.randrange(2) << 31),
               rng.randrange(0x7f800000) | (rng.randrange(2) << 31)) for _ in range(10000)]
    for a, b in pairs:
        sum_bits = binary32(exact(a) + exact(b))
        if a == b == 0x80000000:
            sum_bits = 0x80000000
        product_bits = binary32(exact(a) * exact(b))
        if not exact(a) or not exact(b):
            product_bits = (a ^ b) & 0x80000000
        rows.append([3, a, b, 0, sum_bits])
        rows.append([4, a, b, 0, product_bits])
    for a in limits + [rng.randrange(0x7f800000) for _ in range(6000)]:
        rows.append([5, a, 0, 0, square_root(a)])
    # Independently integrate the tent against the neighboring pixel footprint:
    # integral_0^r t*(r-t)/r^2 dt = r/6. No cubic cancellation in the oracle.
    small_radii = [1, 2, 3, 0x007fffff, 0x00800000, 0x00800001,
                   0x21800000, 0x3e000000, 0x3f000000, 0x3f800000]
    small_radii += [rng.randrange(1, 0x3f800001) for _ in range(512)]
    for radius in small_radii:
        rows.append([6, radius, 1, 0, binary32(exact(radius) / 6)])
        rows.append([6, radius, 2, 0, 0])
    roots = [0, 1, 2, 3, 0x7fffff, 0x800000, 0x800001, 0x3f7fffff, 0x3f800000]
    roots += [binary32(Fraction(i,255)) for i in range(1,255)]
    roots += [rng.randrange(1,0x3f800001) for _ in range(1024)]
    with localcontext() as context:
        context.prec = 160
        for a in roots:
            value = exact(a)
            result = (Decimal(value.numerator)/Decimal(value.denominator)) ** (Decimal(1)/Decimal(5))
            bits = binary32(Fraction(result))
            if a:
                lower = ((exact(bits-1)+exact(bits))/2)**5
                upper = ((exact(bits+1)+exact(bits))/2)**5
                assert lower <= value <= upper
                assert value not in (lower,upper) or bits % 2 == 0
            rows.append([7,a,0,0,bits])
    # Positive fused multiply-add: exact rational product and sum, one RNE.
    # Include subnormal products, widely separated magnitudes and blend ties.
    fma_rng = random.Random(2026100803)
    for a,b,c in ([fma_rng.randrange(0x3f800001) for _ in range(3)] for _ in range(4096)):
        rows.append([8,a,b,c,binary32(exact(a)*exact(b)+exact(c))])
    for value in range(256):
        a=binary32(Fraction(value,255))
        for alpha in (Fraction(1,10),Fraction(1,4),Fraction(1,2),Fraction(1,255)):
            c=binary32(alpha);b=binary32(1-exact(c))
            rows.append([8,a,b,c,binary32(exact(a)*exact(b)+exact(c))])
    # GL_CONSTANT_COLOR interpolation, distinct from source-over. The rounded
    # subtraction is explicit; the following product+sum is one exact RNE.
    blend_rng = random.Random(2026100804)
    weights = [binary32(Fraction(1,n)) for n in (2,3,4)]
    def color_blend(source,destination,weight):
        delta = binary32(exact(source)-exact(destination))
        rows.append([9,source,destination,weight,
                     binary32(exact(delta)*exact(weight)+exact(destination))])
    for _ in range(4096):
        color_blend(blend_rng.randrange(0x3f800001),blend_rng.randrange(0x3f800001),blend_rng.choice(weights))
    for destination in range(256):
        for shift in (-2,-1,0,1,2):
            source = binary32(Fraction(min(1020,max(0,destination*4+shift)),1020))
            for weight in weights:
                color_blend(source,binary32(Fraction(destination,255)),weight)
    # Full signed FMA: all sign combinations of strategically chosen anchors,
    # finite random exponents, and three neighbours around exact cancellation.
    # This oracle does not share the shader's 64-bit alignment/packing algorithm.
    fma_signed_rng = random.Random(2026100901)
    signed_anchors = [a | sign for a in (
        0, 1, 2, 0x007fffff, 0x00800000, 0x00800001, 0x3f000000,
        0x3f7ffffe, 0x3f7fffff, 0x3f800000, 0x3f800001, 0x40000000, 0x7f7fffff,
    ) for sign in (0, 0x80000000)]
    def signed_fma(a, b, c):
        rows.append([10, a, b, c, fused_multiply_add(a, b, c)])
    for a in signed_anchors:
        for b in signed_anchors:
            for c in signed_anchors:
                signed_fma(a, b, c)
    def finite_signed():
        return fma_signed_rng.randrange(0x7f800000) | (fma_signed_rng.randrange(2) << 31)
    for _ in range(4096):
        signed_fma(finite_signed(), finite_signed(), finite_signed())
    families = 0
    while families < 2048:
        a, b = finite_signed(), finite_signed()
        product = binary32(exact(a) * exact(b))
        magnitude = product & 0x7fffffff
        if not 1 <= magnitude <= 0x7f7ffffe:
            continue
        sign = (a ^ b ^ 0x80000000) & 0x80000000
        for neighbour in (magnitude - 1, magnitude, magnitude + 1):
            signed_fma(a, b, sign | neighbour)
        families += 1
    nonfinite_anchors = [0, 0x80000000, 0x3f800000, 0xbf800000,
                        0x7f800000, 0xff800000, 0x7fc12345, 0xffc54321]
    for a in nonfinite_anchors:
        for b in nonfinite_anchors:
            for c in nonfinite_anchors:
                signed_fma(a, b, c)
    return {'version': 1, 'rounding': 'nearest-ties-even',
            'scope': '0: finite binary32 division with nonzero divisor; 1: exact byte-endpoint lerp including subnormal t; 2: positive u64 / 2^bits; 3/4: finite binary32 addition/multiplication including gradual underflow, signed zero, overflow; 5: square root with exact rational squared-midpoint oracle; 6: integrated tent side/support coefficients at binary32 radii in (0,1], independently integrated then rounded once; 7: fifth root on [0,1], Decimal160 candidate certified by exact rational fifth-power midpoint bounds',
            'fmaScope': '8: nonnegative finite binary32 a*b+c with a single exact-rational rounding; includes gradual underflow and source-over blend boundaries',
            'constantColorScope': '9: RN32(RN32(source-destination)*weight+destination); weights 1/2,1/3,1/4; includes both signs, near cancellation and subnormals',
            'signedFmaScope': '10: full signed binary32 exact Fraction a*b+c rounded once; 17576 signed-anchor triples,4096 finite random triples,6144 cancellation-neighbour triples,512 explicit zero/Inf/NaN triples. Gradual underflow,signed zero,overflow; canonical positive quietNaN for NaN/invalid infinity arithmetic.',
            'vectors': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = json.dumps(vectors(), separators=(',', ':')) + '\n'
    if args.check:
        if DESTINATION.read_text() != data:
            raise SystemExit('Arithmetic oracle fixtures are stale')
    else:
        DESTINATION.write_text(data)
    print(f'{len(json.loads(data)["vectors"])} exact arithmetic vectors')
