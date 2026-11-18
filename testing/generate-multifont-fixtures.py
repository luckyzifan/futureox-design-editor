#!/usr/bin/env python3
"""Original synthetic test outlines, dedicated to the public domain (CC0-1.0).
No source font, system font, network, or copyrighted outlines are read.
Usage: python3 testing/generate-multifont-fixtures.py OUTPUT_DIRECTORY
"""
import json, pathlib, sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
manifest = []
for i, (family, chars, advance) in enumerate([
    ('Core Test Narrow', ' ABC', 400),
    ('Core Test Wide', ' ABC', 850),
    ('Core Test Unicode', ' 中文Ω', 1000),
]):
    fb = FontBuilder(1000, isTTF=True)
    order = ['.notdef'] + [f'uni{ord(c):04X}' for c in chars]
    fb.setupGlyphOrder(order); fb.setupCharacterMap({ord(c): f'uni{ord(c):04X}' for c in chars})
    glyphs = {}
    for j, name in enumerate(order):
        pen = TTGlyphPen(None)
        if name != 'uni0020':
            pen.moveTo((40, 0)); pen.lineTo((advance-40, 0))
            pen.lineTo((advance-40 if i == 0 else advance//2, 500 + 50*(j%3)))
            pen.lineTo((40, 600)); pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs); fb.setupHorizontalMetrics({name: (advance, 0) for name in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family+'-1', 'fullName': family+' Regular', 'psName': family.replace(' ', '')+'-Regular', 'version': 'Version 1.0', 'licenseDescription': 'Original synthetic test font. CC0-1.0 public-domain dedication.'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, fsType=0)
    fb.setupPost(); fb.setupMaxp(); fb.font['head'].created = fb.font['head'].modified = 3406620153
    path = out / f'font-{i}.ttf'; fb.save(path)
    manifest.append({'file': path.name, 'family': family, 'advance': advance, 'license': 'CC0-1.0', 'codepoints': list(map(ord, chars))})
(out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest))
