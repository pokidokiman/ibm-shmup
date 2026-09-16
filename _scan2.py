from PIL import Image
import os

for d in ['assets/scenery']:
    for f in sorted(os.listdir(d)):
        if not f.endswith('.png'):
            continue
        im = Image.open(os.path.join(d, f)).convert('RGBA')
        px = im.load()
        alphas = set()
        lums = []
        for y in range(im.height):
            for x in range(im.width):
                R, G, B, A = px[x, y]
                alphas.add(A)
                lums.append(max(R, G, B))
        lums.sort()
        n = len(lums)
        print('%s a=%s max=%d p50=%d p90=%d p99=%d' % (
            f, sorted(alphas)[:4], lums[-1], lums[n // 2], lums[int(n * 0.9)], lums[int(n * 0.99)]))
