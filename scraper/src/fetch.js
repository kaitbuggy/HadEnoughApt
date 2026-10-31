// Polite fetching: identify ourselves, honor robots.txt, and keep requests few.

export const USER_AGENT =
  'HadEnoughApt/0.1 (apartment availability tracker; checks a few times a day; +https://github.com/kaitbuggy/HadEnoughApt)';

const robotsCache = new Map();

// Minimal robots.txt check for the "*" group and our own name. Good enough for a
// handful of known pages; not a full implementation of the spec.
export function isAllowedByRobots(robotsTxt, path) {
  const groups = [];
  let current = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a.includes('hadenoughapt')));
  const group = mine || groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.path === '' ) continue;
    const prefix = r.path.replace(/\*.*$/, '').replace(/\$$/, '');
    if (path.startsWith(prefix) && (!best || prefix.length > best.len || (prefix.length === best.len && r.allow))) {
      best = { len: prefix.length, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

async function robotsAllows(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let txt = '';
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
      if (r.ok) txt = await r.text();
    } catch {
      // Unreachable robots.txt: treat as no rules.
    }
    robotsCache.set(u.origin, txt);
  }
  return isAllowedByRobots(robotsCache.get(u.origin), u.pathname);
}

export async function politeFetch(url, accept = 'text/html') {
  if (!(await robotsAllows(url))) {
    throw new Error(`robots.txt disallows ${url}`);
  }
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
