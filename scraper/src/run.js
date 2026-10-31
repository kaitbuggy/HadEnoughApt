// Entry point. Checks every building that has a supported platform and an
// availability page, then records the results.
//
//   DATABASE_URL=postgres://... node src/run.js        # scrape and save
//   node src/run.js --dry-run [url]                     # Griffis page: scrape and print, no database
//   node src/run.js --dry-run-sightmap <embed url>      # SightMap embed: scrape and print
//
// DATABASE_URL must be the Supabase connection string for a role that bypasses
// row-level security. Keep it in GitHub Actions secrets only.

import pg from 'pg';
import griffis from './adapters/griffis.js';
import sightmap, { fetchFeed, parseData, enrichUnits } from './adapters/sightmap.js';
import { politeFetch } from './fetch.js';
import { recordScrape, recordFailure } from './store.js';

const ADAPTERS = { [griffis.platform]: griffis, [sightmap.platform]: sightmap };
const PAUSE_MS = 5_000; // between requests to different sites, to stay gentle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printParsed(parsed) {
  const available = parsed.plans.filter((p) => p.available);
  console.log(`${parsed.plans.length} floor plans (${available.length} available), ${parsed.units.length} available units`);
  for (const p of parsed.plans) {
    const status = p.available ? `${p.availableCount} available from $${p.baseRent}` : 'unavailable';
    console.log(`  ${p.name.padEnd(22)} ${String(p.beds ?? '?')}bd/${p.baths ?? '?'}ba  ${p.sqftMin ?? '?'}-${p.sqftMax ?? '?'} sqft  ${status}`);
  }
  const numbered = parsed.units.filter((u) => u.unitNumber).length;
  console.log(`${numbered} of ${parsed.units.length} units have unit numbers`);
  if (parsed.problems.length) console.log('Problems:', parsed.problems);
}

async function scrapeBuilding(b) {
  const parsed = await ADAPTERS[b.platform].scrape(b, politeFetch);
  // Add unit numbers and floors from SightMap when the main source lacks them.
  if (b.sightmap_url && b.platform !== 'sightmap') {
    try {
      await sleep(PAUSE_MS);
      const extra = parseData(await fetchFeed(b.sightmap_url, politeFetch));
      const matched = enrichUnits(parsed, extra);
      if (parsed.units.length && matched === 0) console.warn(`${b.name}: SightMap matched no units`);
    } catch (err) {
      // Unit numbers are a bonus; never fail the main scrape over them.
      console.warn(`${b.name}: SightMap enrichment skipped: ${err.message}`);
    }
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run-sightmap')) {
    const url = args.find((a) => a.startsWith('http'));
    return printParsed(parseData(await fetchFeed(url, politeFetch)));
  }
  if (args.includes('--dry-run')) {
    const url = args.find((a) => a.startsWith('http')) || 'https://griffisresidential.com/property/the-domain/pricing-availability/';
    return printParsed(await scrapeBuilding({ name: 'dry run', platform: griffis.platform, availability_url: url, sightmap_url: 'https://sightmap.com/embed/60p7krjnw7n' }));
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  await client.connect();
  let failures = 0;
  try {
    const { rows: buildings } = await client.query(
      `select id, name, platform, availability_url, sightmap_url from buildings
       where availability_url is not null and platform = any($1) order by id`,
      [Object.keys(ADAPTERS)],
    );
    for (const [i, b] of buildings.entries()) {
      if (i) await sleep(PAUSE_MS);
      try {
        const parsed = await scrapeBuilding(b);
        const r = await recordScrape(client, b, parsed);
        const numbered = parsed.units.filter((u) => u.unitNumber).length;
        console.log(`${b.name}: ${r.plans} plans, ${r.units} units (${numbered} with numbers), ${r.opened.length} newly available, ${r.priceDrops.length} price drops, ${r.closed.length} gone, ${r.notifications} notifications${r.healthy ? '' : ' (layout check failed: windows left open)'}`);
        if (!r.healthy) failures++;
      } catch (err) {
        failures++;
        console.error(`${b.name}: failed: ${err.message}`);
        await recordFailure(client, b, err).catch(() => {});
      }
    }
  } finally {
    await client.end();
  }
  // A non-zero exit makes GitHub email the repo owner, so a broken scraper is noticed.
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
