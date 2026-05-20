#!/usr/bin/env python3
"""Generate FrogTalk PNG icons from the frog emoji using Pillow."""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(__file__)
ICONS_DIR = os.path.join(BASE, 'icons')
ANDROID_MIPMAPS = [
    ('mipmap-mdpi',    48),
    ('mipmap-hdpi',    72),
    ('mipmap-xhdpi',   96),
    ('mipmap-xxhdpi',  144),
    ('mipmap-xxxhdpi', 192),
]
ANDROID_ADAPTIVE_FOREGROUND = [
    ('mipmap-mdpi',    108),
    ('mipmap-hdpi',    162),
    ('mipmap-xhdpi',   216),
    ('mipmap-xxhdpi',  324),
    ('mipmap-xxxhdpi', 432),
]
ANDROID_RES = os.path.join(BASE, '..', 'android', 'app', 'src', 'main', 'res')
EMOJI_FONT = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'
EMOJI = '🐸'
EMOJI_PIXEL_SIZE = 109


def render_frog_emoji(size: int, background='transparent') -> Image.Image:
    """Render the frog emoji using the font's native bitmap strike and scale it."""
    source_size = 128
    bg_color = (255, 255, 255, 255) if background == 'white' else (0, 0, 0, 0)
    img = Image.new('RGBA', (source_size, source_size), bg_color)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(EMOJI_FONT, EMOJI_PIXEL_SIZE)
    d.text((source_size / 2, source_size / 2), EMOJI, font=font, anchor='mm', embedded_color=True)
    return img.resize((size, size), Image.LANCZOS)


def save_icon(img: Image.Image, path: str, size: int):
    resized = img.resize((size, size), Image.LANCZOS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    resized.save(path)
    print(f'  {path}')


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    base_web = render_frog_emoji(512, background='transparent')
    base_android_legacy = render_frog_emoji(512, background='transparent')
    base_android_foreground = render_frog_emoji(512, background='transparent')

    # PWA icons (transparent background)
    for sz in [96, 192, 512]:
        save_icon(base_web, os.path.join(ICONS_DIR, f'icon-{sz}.png'), sz)
    save_icon(base_web, os.path.join(ICONS_DIR, 'icon-maskable.png'), 512)

    # favicon.ico (multi-size, transparent)
    favicon_sizes = [16, 32, 48]
    frames = [base_web.resize((sz, sz), Image.LANCZOS).convert('RGBA') for sz in favicon_sizes]
    frames[0].save(
        os.path.join(ICONS_DIR, 'favicon.ico'),
        format='ICO',
        sizes=[(sz, sz) for sz in favicon_sizes],
        append_images=frames[1:]
    )
    print(f'  {os.path.join(ICONS_DIR, "favicon.ico")}')

    # Android legacy launcher icons
    for folder, sz in ANDROID_MIPMAPS:
        res_dir = os.path.join(ANDROID_RES, folder)
        save_icon(base_android_legacy, os.path.join(res_dir, 'ic_launcher.png'), sz)
        save_icon(base_android_legacy, os.path.join(res_dir, 'ic_launcher_round.png'), sz)

    # Android adaptive icon foreground assets
    for folder, sz in ANDROID_ADAPTIVE_FOREGROUND:
        res_dir = os.path.join(ANDROID_RES, folder)
        save_icon(base_android_foreground, os.path.join(res_dir, 'ic_launcher_foreground.png'), sz)

    print('Done.')


if __name__ == '__main__':
    main()
