#!/usr/bin/env python3
"""Generate PNG icons from SVG for the PWA manifest.
Run: python3 static/generate_icons.py
Requires: cairosvg   (pip install cairosvg)
      OR: Pillow + cairosvg
"""
import os, sys

SIZES = [96, 192, 512]
SRC   = os.path.join(os.path.dirname(__file__), 'icons', 'icon.svg')
OUT   = os.path.join(os.path.dirname(__file__), 'icons')

def _with_cairosvg():
    import cairosvg
    for size in SIZES:
        out = os.path.join(OUT, f'icon-{size}.png')
        cairosvg.svg2png(url=SRC, write_to=out, output_width=size, output_height=size)
        print(f'  {out}')
    # maskable: same icon (cairosvg)
    cairosvg.svg2png(url=SRC, write_to=os.path.join(OUT, 'icon-maskable.png'),
                     output_width=512, output_height=512)
    print(f'  {os.path.join(OUT, "icon-maskable.png")}')

def _with_inkscape():
    """Fallback: use system inkscape if available."""
    import subprocess
    for size in SIZES:
        out = os.path.join(OUT, f'icon-{size}.png')
        result = subprocess.run(
            ['inkscape', '--export-type=png', f'--export-width={size}',
             f'--export-height={size}', f'--export-filename={out}', SRC],
            capture_output=True
        )
        if result.returncode == 0:
            print(f'  {out} (inkscape)')
        else:
            print(f'  FAILED {out}: {result.stderr.decode()[:200]}')

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    print('Generating PNG icons...')
    try:
        _with_cairosvg()
        print('Done via cairosvg.')
    except ImportError:
        print('cairosvg not found, trying inkscape...')
        try:
            _with_inkscape()
            print('Done via inkscape.')
        except FileNotFoundError:
            print('No SVG renderer found. Install cairosvg: pip install cairosvg')
            print('Copying SVG as fallback for icon-192.png and icon-512.png...')
            # Last resort: just copy SVG bytes (browsers that support SVG icons still work)
            for size in SIZES:
                dst = os.path.join(OUT, f'icon-{size}.png')
                if not os.path.exists(dst):
                    import shutil
                    shutil.copy(SRC, dst)
            print('Warning: PNG files are actually SVG data — install cairosvg for real PNGs.')
