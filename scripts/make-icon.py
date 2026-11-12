#!/usr/bin/env python3
"""Generate the app icon (build/icon.png + build/icon.ico) with Pillow.

1024x1024 PNG (macOS .icns / retina friendly) plus a multi-size Windows .ico.
A blue rounded square with a white terminal prompt '>_' — SSH/terminal motif.
Reproducible: python3 scripts/make-icon.py
"""
from PIL import Image, ImageDraw
import os

S = 1024
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
build = os.path.join(here, "build")
os.makedirs(build, exist_ok=True)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# vertical gradient background
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
top = (96, 150, 252)
bot = (37, 99, 235)
for y in range(S):
    t = y / S
    c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (S, y)], fill=c)

# rounded square mask (all coords scale from the original 512 design by 2x)
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([32, 32, S - 32, S - 32], radius=224, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
white = (255, 255, 255, 255)

# chevron '>'
pts = [(300, 336), (476, 512), (300, 688)]
d.line(pts, fill=white, width=72, joint="curve")
for p in pts[::2]:
    d.ellipse([p[0] - 36, p[1] - 36, p[0] + 36, p[1] + 36], fill=white)

# underscore cursor '_'
d.rounded_rectangle([552, 644, 776, 712], radius=34, fill=white)

img.save(os.path.join(build, "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(build, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote build/icon.png (1024x1024) and build/icon.ico")
