"""Builds site-public/index.html (the only file deployed) from template.html and the exported listing data.

    git fetch origin site-data && git show FETCH_HEAD:site-data.json > /tmp/site-data.json
    python3 site/build.py /tmp/site-data.json
"""
import json, pathlib, sys

here = pathlib.Path(__file__).parent
data = json.loads(pathlib.Path(sys.argv[1]).read_text())
blob = json.dumps(data, separators=(',', ':')).replace('</', '<\\/')
out = here.parent / 'site-public'
out.mkdir(exist_ok=True)
(out / 'index.html').write_text((here / 'template.html').read_text().replace('__SITE_DATA__', blob))
print('Wrote', out / 'index.html')
