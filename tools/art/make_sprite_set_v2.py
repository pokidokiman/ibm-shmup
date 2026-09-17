#!/usr/bin/env python3
"""Sprite set v2: same subjects, but the shape is never allowed to run off the frame.

v1 post-processing cropped each render tight to its bounding box, so any shape whose
extremities crossed the source frame kept a FLAT CUT - every sprite in the shipped set
had a "pizza slice" taken out of it. v2 asks for a small centred subject with wide
margins, detects a clipped render (bbox touching the source frame) and re-rolls it with
a fresh seed, then fits the art inside 86% of the cell so it can never touch an edge.
"""
import ast
import json
import os
import sys
import time
import urllib.request

from PIL import Image, ImageDraw

COMFY = "http://127.0.0.1:8188"
GAME = r"C:\Users\Jeffry\git\ibm-shmup\assets"
RAW_ROOT = r"C:\Users\Jeffry\Documents\comfy\ComfyUI\output"
SHEET = r"C:\Users\Jeffry\shots\sprites_v2_sheet.png"
SEED0 = 424242
ATTEMPTS = 4
FIT = 0.86

MARGIN = (", the subject is small and perfectly centred, occupying only about one third of the "
          "image, surrounded by wide empty pure white space on every side, nothing touching or "
          "crossing the image border, the complete shape fully visible")
NEG = ("cropped, cut off at the edge, clipped, shape touching the frame border, cut flat edge, "
       "partial shape, zoomed in, oversized, off-centre, blurry, soft shading, gradient "
       "background, text, watermark, 3d render, photorealistic")

src = open(r"C:\Users\Jeffry\make_sprite_set.py", encoding="utf-8").read()
SPRITES = None
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "SPRITES":
        SPRITES = ast.literal_eval(node.value)
assert SPRITES


def workflow(prompt, seed, lora, canvas):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": lora + ".safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["3", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["3", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": canvas, "height": canvas, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["2", 0], "positive": ["4", 0], "negative": ["5", 0],
                                                   "latent_image": ["6", 0], "seed": seed, "steps": 8, "cfg": 1.0,
                                                   "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "sprites_v2/gen"}},
    }


def generate(prompt, seed, lora, canvas):
    body = json.dumps({"prompt": workflow(prompt, seed, lora, canvas), "client_id": "spritesv2"}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=body, headers={"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req, timeout=60))["prompt_id"]
    for _ in range(200):
        time.sleep(2)
        try:
            hist = json.load(urllib.request.urlopen(COMFY + "/history/" + pid, timeout=30))
        except Exception:
            continue
        if pid in hist and hist[pid].get("outputs"):
            imgs = hist[pid]["outputs"].get("10", {}).get("images") or []
            if imgs:
                info = imgs[0]
                return os.path.join(RAW_ROOT, info.get("subfolder", ""), info["filename"])
    return None


def post(raw_path, target):
    """Returns (image, 'ok') or (None, reason) when the render is unusable."""
    im = Image.open(raw_path).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 236 and g > 236 and b > 236:
                px[x, y] = (r, g, b, 0)
    bbox = im.getbbox()
    if not bbox:
        return None, "empty"
    # a shape touching the SOURCE frame is clipped: no post-processing can restore it
    if bbox[0] <= 2 or bbox[1] <= 2 or bbox[2] >= w - 2 or bbox[3] >= h - 2:
        return None, "clipped"
    sub = im.crop(bbox)
    fit = target * FIT
    scale = min(fit / sub.width, fit / sub.height)
    nw = max(1, int(round(sub.width * scale)))
    nh = max(1, int(round(sub.height * scale)))
    sub = sub.resize((nw, nh), Image.NEAREST)
    canvas = Image.new("RGBA", (target, target), (0, 0, 0, 0))
    canvas.paste(sub, ((target - nw) // 2, (target - nh) // 2))
    return canvas, "ok"


ok, clipped_out, failed = [], [], []
for i, (name, prompt, target, canvas, lora) in enumerate(SPRITES):
    full = prompt + MARGIN
    done = False
    for attempt in range(ATTEMPTS):
        seed = SEED0 + i * 7919 + attempt * 104729
        raw = generate(full, seed, lora, canvas)
        if not raw:
            continue
        img, why = post(raw, target)
        if img is not None:
            img.save(os.path.join(GAME, name + ".png"))
            ok.append(name)
            print("[%d/%d] %s: ok (attempt %d, %dpx)" % (i + 1, len(SPRITES), name, attempt + 1, target), flush=True)
            done = True
            break
        print("[%d/%d] %s: %s -> re-roll" % (i + 1, len(SPRITES), name, why), flush=True)
    if not done:
        failed.append(name)
        clipped_out.append(name)
        print("[%d/%d] %s: GAVE UP (kept v1 art)" % (i + 1, len(SPRITES), name), flush=True)

# contact sheet
cols = 8
Z = 3
cell = 128
rows = (len(SPRITES) + cols - 1) // cols
sheet = Image.new("RGBA", (cols * cell * Z, rows * (cell * Z + 20)), (14, 16, 22, 255))
d = ImageDraw.Draw(sheet)
for i, (name, *_rest) in enumerate(SPRITES):
    p = os.path.join(GAME, name + ".png")
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert("RGBA")
    im = im.resize((cell * Z, cell * Z), Image.NEAREST)
    x = (i % cols) * cell * Z
    y = (i // cols) * (cell * Z + 20)
    sheet.alpha_composite(im, (x, y))
    d.text((x + 6, y + cell * Z + 3), name, fill=(210, 220, 230, 255))
sheet.convert("RGB").save(SHEET)
print("sheet -> " + SHEET)
print("done: %d ok, %d gave up %s" % (len(ok), len(failed), failed))
