"""Noise and walking data around each building, for the "Around this unit" section.

Runs in GitHub Actions (it needs the open internet). Usage:
    python3 tools/area_data.py <site-data.json> <out area.json>

Sources:
  - Noise level: U.S. DOT / BTS National Transportation Noise Map 2020
    (road + rail + aviation, 24-hour average, LAeq). Read from the map's tiles
    by matching the pixel color to the map legend.
  - Nearby noise sources: OpenStreetMap (major roads, rail lines) via Overpass.
  - Complaints: Austin 311 "APD - Non Emergency Noise/Alarm" requests within
    400 m in the past 12 months.
  - Walking: OpenStreetMap paths and streets, routed here (shortest walk on
    mapped ways), to the nearest named parks and trails. A route counts as lit
    where its ways are tagged lit=yes or run within 25 m of a mapped streetlight.
"""
import base64, datetime as dt, heapq, io, json, math, sys, time, urllib.parse, urllib.request

from PIL import Image

UA = 'HadEnoughApt/1.0 (github.com/kaitbuggy/HadEnoughApt)'
NOISE = 'https://geo.dot.gov/server/rest/services/Hosted/NTAD_Noise_2020_CONUS_Aviation_Road_Rail/MapServer'
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
WALK_M_PER_MIN = 80  # about 3 mph

# Building locations checked against OpenStreetMap. Others are geocoded from their address.
KNOWN = {
    'Griffis at The Domain': (30.39860, -97.72216),
    'Solaris House at Uptown ATX': (30.40030, -97.71748),
    'The Grand at the Domain': (30.39521, -97.72133),
    'The Watson': (30.40511, -97.71467),
}


def get(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print('  retry', url[:80], e, file=sys.stderr)
            time.sleep(5 * (i + 1))


def jget(url, data=None):
    return json.loads(get(url, data))


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def geocode(b):
    if b['name'] in KNOWN:
        return KNOWN[b['name']]
    q = b.get('address') or (b['name'] + ', ' + (b.get('city') or 'Austin') + ', TX')
    r = jget('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + urllib.parse.quote(q))
    time.sleep(1.1)
    return (float(r[0]['lat']), float(r[0]['lon'])) if r else None


# ---------- noise level from the DOT map tiles ----------
class NoiseMap:
    def __init__(self):
        info = jget(NOISE + '?f=json')
        ti = info['tileInfo']
        self.origin = (ti['origin']['x'], ti['origin']['y'])
        self.size = ti['rows']
        # Finest cached level (the map's data is on a ~30 m grid).
        max_lod = info.get('maxLOD', 12)
        self.lod = next(l for l in ti['lods'] if l['level'] == max_lod)
        legend = next(l for l in jget(NOISE + '/legend?f=json')['layers'] if l['legend'] and l['legend'][0].get('label'))
        self.bands = []
        for item in legend['legend']:
            img = Image.open(io.BytesIO(base64.b64decode(item['imageData']))).convert('RGBA')
            c = img.getpixel((img.width // 2, img.height // 2))
            lo, hi = parse_band(item['label'])
            self.bands.append((c[:3], lo, hi, item['label']))
        self.cache = {}

    def sample(self, lat, lng):
        x = lng * 20037508.342789244 / 180
        y = math.log(math.tan((90 + lat) * math.pi / 360)) * 20037508.342789244 / math.pi
        res = self.lod['resolution']
        px = (x - self.origin[0]) / res
        py = (self.origin[1] - y) / res
        col, row = int(px // self.size), int(py // self.size)
        key = (self.lod['level'], row, col)
        if key not in self.cache:
            try:
                self.cache[key] = Image.open(io.BytesIO(get(f"{NOISE}/tile/{key[0]}/{row}/{col}"))).convert('RGBA')
            except Exception as e:  # noqa: BLE001
                print('  noise tile missing', key, e, file=sys.stderr)
                self.cache[key] = None
        img = self.cache[key]
        if img is None:
            return None
        r, g, b, a = img.getpixel((int(px % self.size), int(py % self.size)))
        if a < 40:
            return (0, 45, 'under 45')  # no color = below the map's lowest band
        best = min(self.bands, key=lambda bd: sum((p - q) ** 2 for p, q in zip(bd[0], (r, g, b))))
        return (best[1], best[2], best[3])


def parse_band(label):
    s = label.replace('≤', '<=').replace('>', '').strip()
    if '-' in s:
        lo, hi = [float(v) for v in s.split('-')]
        return lo, hi + 0.1
    if s.startswith('<='):
        hi = float(s[2:])
        return hi - 5, hi
    v = float(s.replace('=', ''))
    return v, v + 10


def noise_level(nm, lat, lng, radius=70):
    """Loudest band within ~70 m of the building point (its street-facing side), and the quietest."""
    step = 30
    pts = []
    for dy in range(-radius, radius + 1, step):
        for dx in range(-radius, radius + 1, step):
            if dx * dx + dy * dy <= radius * radius:
                pts.append((lat + dy / 111320, lng + dx / (111320 * math.cos(math.radians(lat)))))
    samples = [s for s in (nm.sample(*p) for p in pts) if s]
    if not samples:
        return None
    loud = max(samples, key=lambda s: s[1])
    quiet = min(samples, key=lambda s: s[1])
    mid = lambda s: round((s[0] + s[1]) / 2) if s[0] else 42  # noqa: E731
    return {'low': loud[0], 'high': loud[1], 'db': mid(loud), 'quietDb': mid(quiet)}


def level_name(db):
    return 'Quiet' if db < 50 else 'Moderate' if db < 60 else 'Loud' if db < 70 else 'Very loud'


# ---------- OpenStreetMap ----------
def overpass(q):
    for url in OVERPASS:
        try:
            return jget(url, urllib.parse.urlencode({'data': q}).encode())
        except Exception as e:  # noqa: BLE001
            print('  overpass failed', url, e, file=sys.stderr)
            time.sleep(10)
    raise RuntimeError('Overpass unavailable')


def nearest_on_way(p, geom):
    return min(hav(p, (g['lat'], g['lon'])) for g in geom)


def noise_sources(lat, lng):
    d = overpass(f"""[out:json][timeout:90];
(way(around:1200,{lat},{lng})[highway~"^(motorway|trunk|primary|secondary)$"][name];
 way(around:1600,{lat},{lng})[railway~"^(rail|light_rail)$"][!construction];);out geom tags;""")
    roads, rails = {}, {}
    for w in d['elements']:
        t = w.get('tags', {})
        dist = nearest_on_way((lat, lng), w['geometry'])
        if 'highway' in t:
            n = t['name']
            rank = {'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3}[t['highway']]
            if n not in roads or dist < roads[n][0]:
                roads[n] = (dist, rank)
        else:
            ops = ' '.join(t.get(k, '') for k in ('name', 'alt_name', 'operator')).lower()
            n = ('Red Line rail' if 'capmetro' in ops or 'capital metro' in ops
                 else 'Union Pacific freight rail' if 'union pacific' in ops else 'Rail line')
            if n not in rails or dist < rails[n]:
                rails[n] = dist
    out = sorted(([n, v[0], v[1]] for n, v in roads.items()), key=lambda r: (r[1] > 400, r[2], r[1]))[:2]
    items = [{'name': n, 'meters': round(m)} for n, m, _ in out]
    if rails:
        n, m = min(rails.items(), key=lambda kv: kv[1])
        items.append({'name': n, 'meters': round(m)})
    return items


WALKABLE = 'footway|path|pedestrian|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|steps|cycleway|track|crossing|corridor'


def walking(lat, lng):
    r = 2000
    d = overpass(f"""[out:json][timeout:120];
(way(around:{r},{lat},{lng})[highway~"^({WALKABLE})$"][foot!~"^(no|private)$"][access!~"^(no|private)$"];)->.w;
.w out geom tags;
node(around:{r},{lat},{lng})[highway=street_lamp];out skel;
(way(around:{r},{lat},{lng})[leisure=park][name];relation(around:{r},{lat},{lng})[leisure=park][name];
 way(around:{r},{lat},{lng})[highway~"^(path|footway|cycleway)$"][name~"Trail|Greenbelt|Loop",i];);out geom tags;""")
    lamps, ways, dests = [], [], []
    for e in d['elements']:
        if e['type'] == 'node':
            lamps.append((e['lat'], e['lon']))
        elif e['type'] == 'way' and e.get('tags', {}).get('highway'):
            ways.append(e)
        if e.get('tags', {}).get('leisure') == 'park' or (e['type'] == 'way' and _is_trail(e)):
            dests.append(e)
    # Graph: node key = rounded coordinate.
    graph = {}
    lamp_grid = {}
    for la, lo in lamps:
        lamp_grid.setdefault((round(la, 3), round(lo, 3)), []).append((la, lo))

    def near_lamp(p):
        ka, ko = round(p[0], 3), round(p[1], 3)
        for da in (-0.001, 0, 0.001):
            for do in (-0.001, 0, 0.001):
                for q in lamp_grid.get((round(ka + da, 3), round(ko + do, 3)), ()):
                    if hav(p, q) <= 25:
                        return True
        return False

    def key(g):
        return (round(g['lat'], 6), round(g['lon'], 6))

    for w in ways:
        tagged = w.get('tags', {}).get('lit')
        g = w['geometry']
        for a, b in zip(g, g[1:]):
            ka, kb = key(a), key(b)
            m = hav(ka, kb)
            mid = ((ka[0] + kb[0]) / 2, (ka[1] + kb[1]) / 2)
            lit = True if tagged == 'yes' else False if tagged == 'no' else near_lamp(mid)
            graph.setdefault(ka, []).append((kb, m, lit))
            graph.setdefault(kb, []).append((ka, m, lit))
    if not graph:
        return None
    nodes = list(graph)
    start = min(nodes, key=lambda n: hav(n, (lat, lng)))
    dist, prev = {start: 0.0}, {}
    pq = [(0.0, start)]
    while pq:
        dd, n = heapq.heappop(pq)
        if dd > dist.get(n, 1e18) or dd > 3000:
            continue
        for m, w, lit in graph[n]:
            nd = dd + w
            if nd < dist.get(m, 1e18):
                dist[m], prev[m] = nd, (n, w, lit)
                heapq.heappush(pq, (nd, m))
    seen, results = set(), []
    for e in dests:
        name = e['tags']['name']
        if name in seen:
            continue
        pts = []
        for g in e.get('geometry') or []:
            pts.append(key(g))
        for mem in e.get('members') or []:
            for g in mem.get('geometry') or []:
                pts.append(key(g))
        # Reach the destination at any of its points that are on (or within 30 m of) the walk graph.
        best = None
        for p in pts:
            if p in dist:
                cand = (dist[p], p)
            else:
                continue
            if best is None or cand < best:
                best = cand
        if best is None:
            near = [(hav(p, n), n) for p in pts[::max(1, len(pts) // 40)] for n in _grid_near(graph, p)]
            near = [x for x in near if x[0] <= 30 and x[1] in dist]
            if near:
                best = min((dist[n] + dd, n) for dd, n in near)
        if best is None:
            continue
        meters, end = best
        lit_m = tot = 0.0
        n = end
        while n in prev:
            p, w, lit = prev[n]
            tot += w
            lit_m += w if lit else 0
            n = p
        frac = lit_m / tot if tot > 50 else (1.0 if near_lamp((lat, lng)) else 0.0)
        seen.add(name)
        results.append({'name': name, 'kind': 'park' if e['tags'].get('leisure') == 'park' else 'trail',
                        'meters': round(meters), 'minutes': max(1, round(meters / WALK_M_PER_MIN)) if meters > 60 else 0,
                        'litShare': round(frac, 2)})
    results.sort(key=lambda r: r['meters'])
    return results[:3]


_grid_cache = {}


def _grid_near(graph, p):
    gid = id(graph)
    if gid not in _grid_cache:
        grid = {}
        for n in graph:
            grid.setdefault((round(n[0], 3), round(n[1], 3)), []).append(n)
        _grid_cache[gid] = grid
    grid = _grid_cache[gid]
    out = []
    for da in (-0.001, 0, 0.001):
        for do in (-0.001, 0, 0.001):
            out += grid.get((round(round(p[0], 3) + da, 3), round(round(p[1], 3) + do, 3)), [])
    return out


def _is_trail(e):
    t = e.get('tags', {})
    return t.get('highway') in ('path', 'footway', 'cycleway') and any(w in (t.get('name') or '').lower() for w in ('trail', 'greenbelt', 'loop'))


# ---------- Austin 311 ----------
# Police noise requests left 311 in Oct 2025, so this averages the last 3 years of
# every noise-type request (police noise/alarm, outdoor venue music) within 400 m.
COMPLAINT_YEARS = 3


def complaints(lat, lng):
    since = (dt.date.today() - dt.timedelta(days=365 * COMPLAINT_YEARS)).isoformat()
    where = (f"(lower(sr_type_desc) like '%noise%' OR lower(sr_type_desc) like '%music complaint%') "
             f"AND within_circle(sr_location_lat_long,{lat},{lng},400) AND sr_created_date>'{since}'")
    rows = jget('https://data.austintexas.gov/resource/xwdj-i9he.json?' + urllib.parse.urlencode(
        {'$select': 'sr_created_date', '$where': where, '$limit': 50000}))
    late = 0
    for r in rows:
        h = int(r['sr_created_date'][11:13])
        late += h >= 22 or h < 6
    return {'perYear': round(len(rows) / COMPLAINT_YEARS), 'lateNightPerYear': round(late / COMPLAINT_YEARS),
            'meters': 400, 'years': COMPLAINT_YEARS}


def main(site_data, out):
    data = json.load(open(site_data))
    nm = NoiseMap()
    print('noise bands:', [(b[3], b[0]) for b in nm.bands], file=sys.stderr)
    for name, p in (('on Burnet Rd', (30.4040, -97.7166)), ('on MoPac', (30.4020, -97.7290)), ('beside MoPac 60m', (30.4020, -97.7283))):
        print('  check', name, nm.sample(*p), file=sys.stderr)
    result = {'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'buildings': {}}
    for b in data['buildings']:
        loc = geocode(b)
        print('==', b['name'], loc, file=sys.stderr)
        if not loc:
            continue
        entry = {'lat': loc[0], 'lng': loc[1]}
        for k, fn in (('noise', lambda: noise_level(nm, *loc)), ('sources', lambda: noise_sources(*loc)),
                      ('complaints', lambda: complaints(*loc)), ('walks', lambda: walking(*loc))):
            try:
                entry[k] = fn()
            except Exception as e:  # noqa: BLE001
                print('  failed', k, repr(e), file=sys.stderr)
                entry[k] = None
            time.sleep(2)
        if entry.get('noise'):
            entry['noise']['level'] = level_name(entry['noise']['db'])
        print(json.dumps(entry, indent=1), file=sys.stderr)
        result['buildings'][b['id']] = entry
    json.dump(result, open(out, 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
