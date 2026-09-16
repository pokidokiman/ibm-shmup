from PIL import Image
import os, sys

def report(path, thumb=12):
    im = Image.open(path).convert('RGBA')
    px = im.load()
    n = 0
    r = g = b = 0
    for y in range(im.height):
        for x in range(im.width):
            R, G, B, A = px[x, y]
            if A > 32:
                n += 1
                r += R
                g += G
                b += B
    tot = im.width * im.height
    print(path, im.size, 'cov=%.2f' % (n / tot), 'mean=(%d,%d,%d)' % (r / max(1, n), g / max(1, n), b / max(1, n)))
    step = max(1, im.width // thumb)
    chars = ' .:-=+*#%@'
    for y in range(0, im.height, step):
        row = ''
        for x in range(0, im.width, step):
            R, G, B, A = px[x, y]
            lum = (R * 0.3 + G * 0.6 + B * 0.1) * (A / 255)
            row += chars[min(9, int(lum / 25.6))]
        print('   ' + row)

for path in sys.argv[1:]:
    report(path)
