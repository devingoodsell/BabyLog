# Builds the README images: phone screenshots side by side with rounded corners and a soft shadow.
import sys
from PIL import Image, ImageDraw, ImageFilter
SRC, OUT = sys.argv[1], sys.argv[2]
PW, PH, PAD, GAP, R = 540, 1040, 36, 80, 44

def panel(name, top=0):
    im = Image.open(f'{SRC}/{name}.png').convert('RGBA')
    s = PW / im.width
    im = im.resize((PW, round(im.height * s)), Image.LANCZOS)
    top = round(top * s)
    return im.crop((0, top, PW, top + PH))

def compose(out, names):
    n = len(names)
    W, H = PAD * 2 + PW * n + GAP * (n - 1), PAD * 2 + PH
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for i in range(n):
        x = PAD + i * (PW + GAP)
        sd.rounded_rectangle((x, PAD + 6, x + PW, PAD + PH + 6), R, fill=(20, 30, 50, 60))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(14)))
    for i, spec in enumerate(names):
        name, top = spec if isinstance(spec, tuple) else (spec, 0)
        p = panel(name, top)
        mask = Image.new('L', (PW, PH), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, PW - 1, PH - 1), R, fill=255)
        x = PAD + i * (PW + GAP)
        canvas.paste(p, (x, PAD), mask)
    canvas.save(f'{OUT}/{out}.png', optimize=True)
    print('wrote', out, canvas.size)

compose('overview', ['home', 'breastfeed', 'stats'])
compose('sleep-and-weight', ['sleep', 'weight', 'stats-sleep-weight'])
compose('logging', ['bottle', 'pump', 'timeline'])
compose('health-and-editing', ['health', 'activity', 'edit'])
compose('night-and-sharing', ['home-dark', 'people'])
