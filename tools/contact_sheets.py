"""One-off helper: download every floor plan image and tile them 2x2 into
labeled contact sheets, so plans can be labeled (kitchen shape, bathroom)
without opening each one. Reads plan image URLs from site-data.json."""
import io, json, sys, time, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

data = json.load(open(sys.argv[1]))
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
bname = {b['id']: b['name'] for b in data['buildings']}
plans = sorted(data['floorPlans'], key=lambda p: (int(p['building_id']), p['name']))
W, H, CAP = 760, 640, 44
font = ImageFont.load_default(size=26)

def tile(p):
    canvas = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W, CAP], fill=(235, 232, 225))
    d.text((12, 8), f"#{p['id']}  {p['name']}  ({bname[p['building_id']]})", fill='black', font=font)
    try:
        req = urllib.request.Request(p['image_url'], headers={'User-Agent': 'HadEnough-labeling/1.0'})
        img = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert('RGBA')
        bg = Image.new('RGBA', img.size, 'white'); bg.alpha_composite(img); img = bg.convert('RGB')
        img.thumbnail((W - 16, H - CAP - 16))
        canvas.paste(img, ((W - img.width) // 2, CAP + 8))
    except Exception as e:
        d.text((12, CAP + 20), f"image failed: {e}", fill='red', font=font)
    time.sleep(0.5)
    return canvas

for i in range(0, len(plans), 4):
    sheet = Image.new('RGB', (W * 2 + 8, H * 2 + 8), (200, 200, 200))
    for j, p in enumerate(plans[i:i + 4]):
        sheet.paste(tile(p), ((j % 2) * (W + 8), (j // 2) * (H + 8)))
    sheet.save(out / f'sheet-{i // 4 + 1:02d}.jpg', quality=82)
print('sheets:', (len(plans) + 3) // 4)
