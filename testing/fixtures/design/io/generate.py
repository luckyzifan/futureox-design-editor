"""Rebuild small owned I/O fixtures; requires Pillow, uses no user/system media."""
from pathlib import Path
import hashlib
import json
import PIL
from PIL import Image

output = Path(__file__).resolve().parent
root = output.parents[3]
image = Image.new('RGB', (8, 4))
image.putdata([(255, 0, 0) if x < 4 else (0, 255, 0) for y in range(4) for x in range(8)])
exif = Image.Exif()
exif[274] = 6
image.save(output / 'orientation-6.jpg', quality=100, subsampling=0, exif=exif)
profile_source = root / 'frontend/design-client/public/color-fixtures/p3-red-icc.png'
profile = Image.open(profile_source).info['icc_profile']
Image.new('RGBA', (4, 4), (64, 128, 192, 255)).save(output / 'display-p3-mid-icc.png', icc_profile=profile)
Image.new('RGBA', (3, 2), (31, 93, 157, 255)).save(output / 'lossless.webp', lossless=True)
report = {
    'source': 'Locally generated synthetic pixels; no user images or Figma reference pixels.',
    'generator': 'generate.py', 'pillowVersion': PIL.__version__,
    'gifTiffGenerator': 'design-studio/crates/design-kernel/tests/gif_tiff_import.rs encodes two-frame-64x48.gif and red-64x48.tiff. This script does not rewrite them.',
    'iccSource': str(profile_source.relative_to(root)),
    'iccGenerator': 'design-studio/crates/design-kernel/examples/color_assets.rs (moxcms canonical Display P3 profile)',
    'iccSourceSha256': hashlib.sha256(profile_source.read_bytes()).hexdigest(),
    'images': [{'file': f.name, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'bytes': f.stat().st_size}
               for f in sorted(output.iterdir()) if f.suffix in ['.gif', '.jpg', '.png', '.tiff', '.webp']],
}
(output / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')
