#!/usr/bin/env python3
"""Generate the app icon (build/icon.png + build/icon.ico) with Pillow.
A blue rounded square with a white terminal prompt '>_' — SSH/terminal motif.
Reproducible: python3 scripts/make-icon.py
"""
from PIL import Image, ImageDraw
import os

S = 512
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

mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
white = (255, 255, 255, 255)

# chevron '>'
pts = [(150, 168), (238, 256), (150, 344)]
d.line(pts, fill=white, width=36, joint="curve")
for p in (pts[0], pts[2]):
    d.ellipse([p[0] - 18, p[1] - 18, p[0] + 18, p[1] + 18], fill=white)

# underscore cursor '_'
d.rounded_rectangle([276, 322, 388, 356], radius=17, fill=white)

img.save(os.path.join(build, "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(build, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote build/icon.png and build/icon.ico")
