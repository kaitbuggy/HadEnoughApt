// Adapter for Griffis Residential sites (WordPress + Engrain "Spaces" plugin).
//
// The availability page's HTML already contains everything we need, so no browser
// is required:
//   * <article data-spaces-obj="plan"> cards: one per floor plan, including plans
//     that are currently unavailable.
//   * Each available card has a "View on Map" link whose data-spaces-sightmap-filter
//     lists the site's ids for the available units in that plan.
//   * An inline script defines `const spacesUnitJSON = [...]` with each available
//     unit's move-in date, floor tag and price for every lease length.
//
// parse(html) returns plain data. It never touches the database.

import * as cheerio from 'cheerio';

const num = (s) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(s).match(/\d/) ? n : null;
};

// "673 - 741 Sq. Ft." -> [673, 741]; "644 Sq. Ft." -> [644, 644]
export function parseSqft(text) {
  const nums = (text.match(/[\d,]+/g) || []).map((x) => Number(x.replace(/,/g, '')));
  if (!nums.length) return [null, null];
  return [nums[0], nums[nums.length - 1]];
}

// Pull a top-level `const NAME = <json>` out of script text, respecting strings.
export function extractJsConst(scriptText, name) {
  const marker = `const ${name} = `;
  const k = scriptText.indexOf(marker);
  if (k < 0) return null;
  const start = k + marker.length;
  const open = scriptText[start];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < scriptText.length; i++) {
    const ch = scriptText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(scriptText.slice(start, i + 1));
  }
  return null;
}

function parsePlanCard($, el) {
  const card = $(el);
  const texts = card
    .find('span')
    .map((_, s) => $(s).text().trim().replace(/\s+/g, ' '))
    .get()
    .filter(Boolean);

  const bedText = texts.find((t) => /^(Studio|\d+(\.\d+)? Bed)/i.test(t)) || null;
  const bathText = texts.find((t) => /^\d+(\.\d+)? Bath/i.test(t)) || null;
  const sqftText = texts.find((t) => /Sq\. ?Ft/i.test(t)) || null;
  const baseRentText = texts.find((t) => /Base Rent/i.test(t)) || null;
  const leaseText = texts.find((t) => /^\d+ Mo\.$/i.test(t)) || null;
  const fromIdx = texts.findIndex((t) => t === 'From');
  const fromText = fromIdx >= 0 ? texts[fromIdx + 1] : null;
  const countText = card.find('.spaces-plan-overview-available-unit-count-number').first().text();

  const available = card.attr('data-spaces-available') === 'true';
  const [sqftMin, sqftMax] = sqftText ? parseSqft(sqftText) : [null, null];
  const filter = card.find('[data-spaces-sightmap-filter]').first().attr('data-spaces-sightmap-filter');
  const img = card.find('img.spaces-plan-image').first().attr('src') || null;

  return {
    externalId: card.attr('data-spaces-plan'),
    name: (card.attr('title') || '').trim(),
    beds: bedText ? (/^studio/i.test(bedText) ? 0 : num(bedText)) : null,
    baths: bathText ? num(bathText) : null,
    sqftMin,
    sqftMax,
    available,
    availableCount: available ? num(countText) ?? 0 : 0,
    priceFrom: available ? num(fromText) : null,
    baseRent: available ? num(baseRentText) : null,
    leaseMonths: available ? num(leaseText) : null,
    soonest: card.attr('data-spaces-soonest') || null,
    // Drop query strings: they carry resizing or tracking params, not identity.
    imageUrl: img ? img.split('?')[0] : null,
    unitIds: filter ? filter.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

function parseUnit(u, planByUnit) {
  const prices = {};
  for (const t of u.lease_terms || []) {
    const months = Number(t.lease_term);
    const price = Number(t.price);
    if (Number.isFinite(months) && Number.isFinite(price) && price > 0) prices[months] = price;
  }
  const entries = Object.entries(prices).map(([m, p]) => [Number(m), p]);
  const best = entries.length ? entries.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  const floorTag = (u.css || []).find((c) => /^floor_\d+$/.test(c)) || null;
  return {
    externalId: String(u.id),
    planExternalId: planByUnit.get(String(u.id)) || null,
    availableOn: u.available_on || null,
    floorRef: floorTag,
    leasePrices: prices,
    lowestRent: best ? best[1] : null,
    lowestRentMonths: best ? best[0] : null,
  };
}

export function parse(html) {
  const $ = cheerio.load(html);
  const plans = $('article[data-spaces-obj="plan"]')
    .map((_, el) => parsePlanCard($, el))
    .get()
    .filter((p) => p.externalId && p.name);

  const planByUnit = new Map();
  for (const p of plans) for (const id of p.unitIds) planByUnit.set(id, p.externalId);

  let rawUnits = null;
  $('script').each((_, s) => {
    const text = $(s).text();
    if (!rawUnits && text.includes('const spacesUnitJSON')) rawUnits = extractJsConst(text, 'spacesUnitJSON');
  });
  const units = (rawUnits || []).map((u) => parseUnit(u, planByUnit));

  const problems = [];
  if (!plans.length) problems.push('No floor plan cards found. The page layout may have changed.');
  if (rawUnits === null) problems.push('Unit data (spacesUnitJSON) not found.');
  const listed = plans.reduce((n, p) => n + p.availableCount, 0);
  if (rawUnits && listed !== units.length) {
    problems.push(`Plan cards list ${listed} available homes but unit data has ${units.length}.`);
  }
  const orphans = units.filter((u) => !u.planExternalId).length;
  if (orphans) problems.push(`${orphans} units could not be matched to a floor plan.`);

  return { plans, units, problems };
}

export default { platform: 'griffis-engrain', parse };
