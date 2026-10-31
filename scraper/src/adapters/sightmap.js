// Adapter for SightMap (sightmap.com) embeds, used by many large complexes.
//
// The embed page (https://sightmap.com/embed/<code>) contains a link to a JSON
// feed (https://sightmap.com/app/api/v1/<key>/sightmaps/<id>) listing:
//   * floor_plans: every plan, including ones with nothing available
//   * floors: floor ids and labels
//   * units: currently available units with unit number, floor, sq ft, price,
//     lease length and move-in date
//
// Two uses:
//   * platform 'sightmap': SightMap is the building's whole source.
//   * enrichment: another adapter (e.g. Griffis) finds the units; SightMap adds
//     unit numbers and floors, matched by the same unit ids.

const API_RE = /https:(?:\\?\/){2}sightmap\.com(?:\\?\/)app(?:\\?\/)api(?:\\?\/)v1(?:\\?\/)[a-z0-9]+(?:\\?\/)sightmaps(?:\\?\/)\d+/i;

export function findApiUrl(embedHtml) {
  const m = embedHtml.match(API_RE);
  return m ? m[0].replace(/\\\//g, '/') : null;
}

// Plan names sometimes arrive as a JSON string: {"name":"Milan","provider_id":"12"}
export function planName(plan) {
  const raw = plan.filter_label || plan.name || '';
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw).name || raw; } catch { return raw; }
  }
  return typeof raw === 'object' && raw ? raw.name || '' : String(raw);
}

const months = (s) => {
  const m = String(s || '').match(/(\d+)\s*Month/i);
  return m ? Number(m[1]) : null;
};
const toInt = (s) => {
  const m = String(s ?? '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

export function parseData(json) {
  const d = json?.data ?? json ?? {};
  const floors = new Map((d.floors || []).map((f) => [String(f.id), f]));
  const rawUnits = Array.isArray(d.units) ? d.units : null;
  const sections = new Set((rawUnits || []).map((u) => u.building).filter(Boolean));

  const units = (rawUnits || []).map((u) => {
    const floor = floors.get(String(u.floor_id));
    const leaseMonths = months(u.display_lease_term);
    const price = Number(u.price) > 0 ? Number(u.price) : null;
    return {
      externalId: String(u.id),
      planExternalId: u.floor_plan_id != null ? String(u.floor_plan_id) : null,
      unitNumber: u.unit_number ? String(u.unit_number) : u.label ? String(u.label) : null,
      section: sections.size > 1 && u.building ? String(u.building) : null,
      floor: floor ? toInt(floor.filter_short_label ?? floor.filter_label) : null,
      floorRef: u.floor_id != null ? `sightmap_floor_${u.floor_id}` : null,
      sqft: Number(u.area) > 0 ? Number(u.area) : null,
      availableOn: u.available_on || null,
      leasePrices: price && leaseMonths ? { [leaseMonths]: price } : {},
      lowestRent: price,
      lowestRentMonths: leaseMonths,
      viewImageUrl: u.view_image_url ? String(u.view_image_url).split('?')[0] : null,
    };
  });

  const byPlan = new Map();
  for (const u of units) {
    if (!byPlan.has(u.planExternalId)) byPlan.set(u.planExternalId, []);
    byPlan.get(u.planExternalId).push(u);
  }

  const plans = (d.floor_plans || []).map((p) => {
    const mine = byPlan.get(String(p.id)) || [];
    const sizes = mine.map((u) => u.sqft).filter(Boolean);
    const rents = mine.map((u) => u.lowestRent).filter(Boolean);
    const cheapest = mine.filter((u) => u.lowestRent).sort((a, b) => a.lowestRent - b.lowestRent)[0];
    return {
      externalId: String(p.id),
      name: planName(p),
      beds: p.bedroom_count != null ? Number(p.bedroom_count) : null,
      baths: p.bathroom_count != null ? Number(p.bathroom_count) : null,
      sqftMin: sizes.length ? Math.min(...sizes) : null,
      sqftMax: sizes.length ? Math.max(...sizes) : null,
      available: mine.length > 0,
      availableCount: mine.length,
      priceFrom: rents.length ? Math.min(...rents) : null,
      baseRent: rents.length ? Math.min(...rents) : null,
      leaseMonths: cheapest ? cheapest.lowestRentMonths : null,
      soonest: mine.map((u) => u.availableOn).filter(Boolean).sort()[0] || null,
      imageUrl: p.image_url ? String(p.image_url).split('?')[0] : null,
      unitIds: mine.map((u) => u.externalId),
    };
  }).filter((p) => p.externalId && p.name);

  const problems = [];
  if (!plans.length) problems.push('SightMap feed has no floor plans. The feed format may have changed.');
  if (rawUnits === null) problems.push('SightMap feed has no units list.');
  const orphans = units.filter((u) => !plans.some((p) => p.externalId === u.planExternalId)).length;
  if (orphans) problems.push(`${orphans} SightMap units could not be matched to a floor plan.`);

  return { plans, units, problems };
}

export async function fetchFeed(embedUrl, fetchText) {
  const html = await fetchText(embedUrl);
  const api = findApiUrl(html);
  if (!api) throw new Error(`No SightMap data link found on ${embedUrl}`);
  return JSON.parse(await fetchText(api, 'application/json'));
}

// Adds unit numbers, floors and sizes from SightMap to units another adapter found.
export function enrichUnits(parsed, sightmapParsed) {
  const byId = new Map(sightmapParsed.units.map((u) => [u.externalId, u]));
  let matched = 0;
  for (const u of parsed.units) {
    const s = byId.get(u.externalId);
    if (!s) continue;
    matched++;
    u.unitNumber = s.unitNumber;
    u.section = s.section;
    u.floor = s.floor;
    u.sqft = s.sqft;
    u.viewImageUrl = s.viewImageUrl;
  }
  return matched;
}

export default {
  platform: 'sightmap',
  async scrape(building, fetchText) {
    return parseData(await fetchFeed(building.availability_url, fetchText));
  },
};
