"""Generate a 'mech FrogAI' avatar from the FrogTalk logo.

Loads static/icons/icon-512.png, overlays a chromed visor across both
eyes with cyan glow + tracking reticles, drops a riveted plate on the
forehead, and adds a single antenna with an LED tip. Output goes to
static/icons/frogai-avatar.png (and a smaller 256 copy used as the bot
avatar). Re-run after icon-512 changes.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "static/icons/icon-512.png")
OUT  = os.path.join(ROOT, "static/icons/frogai-avatar.png")
OUT_SMALL = os.path.join(ROOT, "static/icons/frogai-avatar-256.png")

base = Image.open(SRC).convert("RGBA")
W, H = base.size  # 512

# Layer for mech parts so we can blur the glow separately.
mech = Image.new("RGBA", (W, H), (0, 0, 0, 0))
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(mech)
g = ImageDraw.Draw(glow)

# --- Visor strap across the eyes ----------------------------------------
visor_top, visor_bot = 150, 245
# Dark chrome plate
d.rounded_rectangle((40, visor_top, W - 40, visor_bot),
                    radius=28, fill=(28, 34, 38, 235),
                    outline=(140, 150, 160, 255), width=4)
# Inner highlight strip
d.rounded_rectangle((52, visor_top + 10, W - 52, visor_top + 30),
                    radius=10, fill=(70, 82, 92, 180))
# Cyan glow lens
lens_top, lens_bot = visor_top + 32, visor_bot - 18
d.rounded_rectangle((70, lens_top, W - 70, lens_bot),
                    radius=14, fill=(8, 18, 22, 255),
                    outline=(0, 230, 255, 255), width=3)
g.rounded_rectangle((70, lens_top, W - 70, lens_bot),
                    radius=14, fill=(0, 230, 255, 110))

# Reticles (left + right) inside the lens
for cx in (150, 362):
    cy = (lens_top + lens_bot) // 2
    d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22),
              outline=(0, 255, 220, 255), width=3)
    d.line((cx - 30, cy, cx + 30, cy), fill=(0, 255, 220, 220), width=2)
    d.line((cx, cy - 30, cx, cy + 30), fill=(0, 255, 220, 220), width=2)
    d.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=(255, 255, 255, 255))

# Rivets on the visor corners
for (x, y) in ((58, visor_top + 12), (W - 58, visor_top + 12),
               (58, visor_bot - 12), (W - 58, visor_bot - 12)):
    d.ellipse((x - 5, y - 5, x + 5, y + 5),
              fill=(180, 190, 200, 255),
              outline=(40, 46, 52, 255), width=1)

# --- Forehead plate -----------------------------------------------------
plate_top = 80
d.rounded_rectangle((180, plate_top, W - 180, plate_top + 50),
                    radius=10, fill=(50, 58, 66, 240),
                    outline=(150, 160, 170, 255), width=3)
for x in (200, 256, 312):
    d.ellipse((x - 4, plate_top + 22, x + 4, plate_top + 30),
              fill=(180, 190, 200, 255))

# --- Antenna -------------------------------------------------------------
ant_x = W // 2
d.line((ant_x, plate_top + 4, ant_x, 14), fill=(160, 170, 180, 255), width=5)
# LED tip glow + core
g.ellipse((ant_x - 16, -2, ant_x + 16, 30), fill=(255, 80, 80, 180))
d.ellipse((ant_x - 8, 4, ant_x + 8, 20), fill=(255, 220, 220, 255),
          outline=(180, 30, 30, 255), width=2)

# --- Side jaw bolts -----------------------------------------------------
for (x, y) in ((40, 320), (W - 40, 320)):
    d.ellipse((x - 10, y - 10, x + 10, y + 10),
              fill=(80, 90, 100, 240), outline=(160, 170, 180, 255), width=2)
    d.line((x - 4, y - 4, x + 4, y + 4), fill=(30, 34, 38, 255), width=2)
    d.line((x - 4, y + 4, x + 4, y - 4), fill=(30, 34, 38, 255), width=2)

# Compose: base frog -> glow (blurred) -> mech parts
glow_blur = glow.filter(ImageFilter.GaussianBlur(radius=12))
out = base.copy()
out.alpha_composite(glow_blur)
out.alpha_composite(mech)

out.save(OUT, "PNG", optimize=True)
out.resize((256, 256), Image.LANCZOS).save(OUT_SMALL, "PNG", optimize=True)
print("wrote", OUT, "and", OUT_SMALL)
