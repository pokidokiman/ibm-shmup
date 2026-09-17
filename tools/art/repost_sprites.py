#!/usr/bin/env python3
"""Re-process the existing raw renders with a proper alpha key.
No GPU: the raws are already on disk. White becomes transparent by LUMINANCE
(alpha = 255 - min(r,g,b)) so the black outline stays fully opaque and anti-aliased
edge pixels get partial alpha instead of being deleted into white speckles."""
import ast, glob, os
from PIL import Image, ImageDraw

GAME = r"C:\Users\Jeffry\git\ibm-shmup\assets"
RAW = r"C:\Users\Jeffry\Documents\comfy\ComfyUI\output\sprites_v2"
SHEET = r"C:\Users\Jeffry\shots\sprites_v2_sheet.png"
FIT = 0.86

src = open(r"C:\Users\Jeffry\make_sprite_set.py", encoding="utf-8").read()
SPRITES = None
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "SPRITES":
        SPRITES = ast.literal_eval(node.value)

files = sorted(glob.glob(os.path.join(RAW, "**", "*.png"), recursive=True))
if not files:
    raise SystemExit("no raw renders found")
print("raw renders:", len(files))


def post(path, target):
    im = Image.open(path).convert("RGB").convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            a = 255 - min(r, g, b)
            # BINARY alpha, not partial: partial-alpha edge pixels are what showed up
            # as white dashes/specks along every silhouette the moment the sprite was
            # lifted for contrast. A hard silhouette is what pixel art wants.
            px[x, y] = (r, g, b, 255 if a >= 112 else 0)
    bbox = im.getbbox()
    if not bbox:
        return None, "empty"
    if bbox[0] <= 2 or bbox[1] <= 2 or bbox[2] >= w - 2 or bbox[3] >= h - 2:
        return None, "clipped"
    sub = im.crop(bbox)
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
    im = Image.open(p).convert("RGBA").resize((cell * Z, cell * Z), Image.NEAREST)
    x, y = (i % cols) * cell * Z, (i // cols) * (cell * Z + 20)
    sheet.alpha_composite(im, (x, y))
    d.text((x + 6, y + cell * Z + 3), name, fill=(210, 220, 230, 255))
sheet.convert("RGB").save(SHEET)
print("sheet -> " + SHEET)
