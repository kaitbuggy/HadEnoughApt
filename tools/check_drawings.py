"""Lists floor plans that need a drawing: plans with no drawing yet, and plans
whose image changed since they were drawn. Prints Markdown (empty if none).

    python3 tools/check_drawings.py site-data.json labels/plan-drawings.json
"""
import json, sys

# Compare file names, not full URLs: Griffis re-files the same image under a new
# month folder (/2026/10/ -> /2026/11/), which isn't a real change.
name = lambda u: (u or '').split('?')[0].rsplit('/', 1)[-1]

site = json.load(open(sys.argv[1]))
drawn = {(p['building'], p['plan']): p for p in json.load(open(sys.argv[2]))['plans']}
bname = {b['id']: b['name'] for b in site['buildings']}

new, changed = [], []
for p in site['floorPlans']:
    key = (bname[p['building_id']], p['name'])
    d = drawn.get(key)
    if d is None:
        new.append((key, p.get('image_url')))
    elif d.get('image_url') and p.get('image_url') and name(d['image_url']) != name(p['image_url']):
        changed.append((key, p.get('image_url')))

lines = []
if new:
    lines.append(f'**{len(new)} new floor plan{"s" if len(new) > 1 else ""} with no drawing yet** (the site shows the original image meanwhile):')
    lines += [f'- {b} · {n} — [plan image]({u})' if u else f'- {b} · {n}' for (b, n), u in new]
if changed:
    lines.append(f'**{len(changed)} plan image{"s" if len(changed) > 1 else ""} changed since drawn** (check the drawing still matches):')
    lines += [f'- {b} · {n} — [new image]({u})' for (b, n), u in changed]
print('\n'.join(lines))
