#!/usr/bin/env python3
"""Builds the app icons from assets/logo-source.png (1254 px, transparent corners).

Outputs (committed):
  assets/icon.png         1024 px master on Apple's icon grid (tile 824 px, centred)
  assets/StickPilot.icns  macOS app icon (via iconutil)
  assets/icon.ico         Windows icon
  assets/icon-512.png     Linux icon
  src/renderer/logo.png   64 px logo for the app's header
Needs Pillow (pip install pillow) and, for .icns, macOS's iconutil.
"""
import os, shutil, subprocess, tempfile
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = lambda *p: os.path.join(root, *p)

src = Image.open(A('assets', 'logo-source.png')).convert('RGBA')
tile = src.crop(src.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox())

# Apple's grid: an 824 px tile centred on a 1024 px canvas
master = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
tile_sized = tile.resize((824, round(824 * tile.height / tile.width)), Image.LANCZOS)
master.alpha_composite(tile_sized, ((1024 - tile_sized.width) // 2, (1024 - tile_sized.height) // 2))
master.save(A('assets', 'icon.png'))
master.resize((512, 512), Image.LANCZOS).save(A('assets', 'icon-512.png'))

# Windows: the tile fills more of the square there
win = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
t = tile.resize((240, round(240 * tile.height / tile.width)), Image.LANCZOS)
win.alpha_composite(t, ((256 - t.width) // 2, (256 - t.height) // 2))
win.save(A('assets', 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# Header logo: the tile alone, small
tile.resize((64, round(64 * tile.height / tile.width)), Image.LANCZOS).save(A('src', 'renderer', 'logo.png'))

if shutil.which('iconutil'):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, 'StickPilot.iconset')
        os.mkdir(iconset)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                name = f'icon_{size}x{size}{"@2x" if scale == 2 else ""}.png'
                master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', A('assets', 'StickPilot.icns')], check=True)
print('icons written')
