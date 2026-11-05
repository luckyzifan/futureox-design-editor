#!/usr/bin/env python3
"""Regenerate committed icon resources from a verified MCP export.

The 2026-11-02 letter-F rasters are produced by render-brand-mark.mjs instead.
This script still requires Pillow and matching MCP SVG exports. No network required.
"""
from pathlib import Path
import argparse
import shutil
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / 'frontend/design-client/public/branding'
ASSETS = ROOT / 'frontend/design-desktop/assets/branding'
parser = argparse.ArgumentParser()
parser.add_argument('--native-export-dir', required=True, type=Path, help='Output of the real MCP branding example')
parser.add_argument('--mac-native-export-dir', required=True, type=Path, help='Selected own-MCP clean macOS export')
parser.add_argument('--contact-sheet', type=Path)
args = parser.parse_args()
ASSETS.mkdir(parents=True, exist_ok=True)
master = PUBLIC / 'futureox-desgin.svg'
if master.read_bytes() != (args.native_export_dir / 'futureox-desgin.svg').read_bytes():
    raise SystemExit('SVG master must match the verified MCP export before packaging icons')
shutil.copyfile(args.native_export_dir / 'futureox-desgin@2x.png', ASSETS / 'futureox-desgin.png')
with Image.open(ASSETS / 'futureox-desgin.png') as image:
    image = image.convert('RGBA')
    # macOS uses its own rounded-square artwork; never the standalone Windows mark.
    image.save(ASSETS / 'futureox-desgin.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    for size in (16,32,64,128,256,512):
        native = args.native_export_dir / f'futureox-desgin-{size}.png'
        if native.exists():
            shutil.copyfile(native, ASSETS / f'futureox-desgin-{size}.png')
        else:
            image.resize((size,size), Image.Resampling.LANCZOS).save(ASSETS / f'futureox-desgin-{size}.png')
    for size in (192,512):
        image.resize((size,size), Image.Resampling.LANCZOS).save(PUBLIC / f'futureox-desgin-{size}.png')
    image.resize((180,180), Image.Resampling.LANCZOS).save(PUBLIC / 'apple-touch-icon.png')
    image.save(PUBLIC / 'favicon.ico', sizes=[(16,16),(32,32),(48,48)])
    # QA output is outside the source tree and not shipped in the app.
    if args.contact_sheet:
        sheet = Image.new('RGB', (900,670), '#f3f5f7')
        draw = ImageDraw.Draw(sheet)
        draw.rectangle((0,335,900,670), fill='#101821')
        for row, fg in ((0,'#172B3A'),(335,'#e5edf2')):
            draw.text((28,row+20), 'futureox-desgin | original F | 16 / 32 / 64 / 256 px', fill=fg)
            for x,size in ((70,16),(180,32),(300,64),(510,256)):
                icon=image.resize((size,size), Image.Resampling.LANCZOS)
                sheet.paste(icon, (x,row+60), icon)
                draw.text((x,row+320), f'{size} px', fill=fg)
        args.contact_sheet.parent.mkdir(parents=True,exist_ok=True)
        sheet.save(args.contact_sheet)

mac_master = ASSETS / 'futureox-desgin-macos.svg'
if mac_master.read_bytes() != (args.mac_native_export_dir / 'futureox-desgin.svg').read_bytes():
    raise SystemExit('Mac master must match the selected MCP export')
shutil.copyfile(args.mac_native_export_dir / 'futureox-desgin@2x.png', ASSETS / 'futureox-desgin-macos.png')
with Image.open(ASSETS / 'futureox-desgin-macos.png') as mac:
    mac.convert('RGBA').save(ASSETS / 'futureox-desgin.icns', sizes=[(16,16),(32,32),(64,64),(128,128),(256,256),(512,512),(1024,1024)])
