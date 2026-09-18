#!/usr/bin/env python3
"""Re-process the raw renders with a BORDER-CONNECTED background key.

The previous key (alpha = 255 - min(r,g,b)) made every white pixel transparent - which
is right for the background, but it also deleted the light pixels INSIDE each sprite:
bright cores, highlights, light plating. Every sprite came back with black rectangular
holes punched through it, worst on the right where the lit detail sits. That is the
"pizza slice" the user kept seeing, and no amount of re-rolling art could fix it.

The background is the white region CONNECTED TO THE IMAGE BORDER. Flood-fill it from
the edges and key only that; interior whites stay opaque.
"""
import ast
import glob
import os

from PIL import Image, ImageDraw

GAME = r"C:\Users\Jeffry\git\ibm-shmup\assets"
RAW = r"C:\Users\Jeffry\Documents\comfy\ComfyUI\output\sprites_v2"
SHEET = r"C:\Users\Jeffry\shots\sprites_v2_sheet.png"
FIT = 0.86
WHITE = 200          # a pixel is "background white" if min(r,g,b) >= this

src = open(r"C:\Users\Jeffry\make_sprite_set.py", encoding="utf-8").read()
SPRITES = None
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "SPRITES":
        SPRITES = ast.literal_eval(node.value)

files = sorted(glob.glob(os.path.join(RAW, "**", "*.png"), recursive=True))
print("raw renders:", len(files))


def post(path, target):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    rgb = im.load()

    # 1. mask of candidate background pixels
    mask = Image.new("L", (w, h), 0)
    mk = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = rgb[x, y]
            if min(r, g, b) >= WHITE:
                mk[x, y] = 255

    # 2. flood the truly-background region starting from every border pixel
    seeds = []
    for x in range(w):
        seeds.append((x, 0)); seeds.append((x, h - 1))
    for y in range(h):
        seeds.append((0, y)); seeds.append((w - 1, y))
    for sx, sy in seeds:
        if mk[sx, sy] == 255:
            ImageDraw.floodfill(mask, (sx, sy), 128, thresh=0)
    mk = mask.load()

    # 3. alpha: background transparent, EVERYTHING else opaque (interior whites included)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            if mk[x, y] == 128:
                continue
            r, g, b = rgb[x, y]
            op[x, y] = (r, g, b, 255)

    bbox = out.getbbox()
    if not bbox:
        return None, "empty"
    if bbox[0] <= 2 or bbox[1] <= 2 or bbox[2] >= w - 2 or bbox[3] >= h - 2:
        return None, "clipped"
    sub = out.crop(bbox)
    fit = target * FIT
    sc = min(fit / sub.width, fit / sub.height)
    nw, nh = max(1, int(round(sub.width * sc))), max(1, int(round(sub.height * sc)))
    sub = sub.resize((nw, nh), Image.LANCZOS).resize((nw, nh), Image.NEAREST)
    c = Image.new("RGBA", (target, target), (0, 0, 0, 0))
    c.paste(sub, ((target - nw) // 2, (target - nh) // 2))
    return c, "ok"


ok = skipped = 0
for i, (name, _p, target, _c, _l) in enumerate(SPRITES):
    if i >= len(files):
        break
    img, why = post(files[i], target)
    if img is None:
        print("  %s: %s (kept current)" % (name, why)); skipped += 1; continue
    img.save(os.path.join(GAME, name + ".png")); ok += 1
print("reprocessed: %d ok, %d skipped" % (ok, skipped))

cols, Z, cell = 8, 3, 128
rows = (len(SPRITES) + cols - 1) // cols
sheet = Image.new("RGBA", (cols * cell * Z, rows * (cell * Z + 20)), (14, 16, 22, 255))
d = ImageDraw.Draw(sheet)
for i, (name, *_r) in enumerate(SPRITES):
    p = os.path.join(GAME, name + ".png")
    if not os.path.exists(p):
        continue
    im2 = Image.open(p).convert("RGBA").resize((cell * Z, cell * Z), Image.NEAREST)
    x, y = (i % cols) * cell * Z, (i // cols) * (cell * Z + 20)
    sheet.alpha_composite(im2, (x, y))
    d.text((x + 6, y + cell * Z + 3), name, fill=(210, 220, 230, 255))
sheet.convert("RGB").save(SHEET)
print("sheet -> " + SHEET)
