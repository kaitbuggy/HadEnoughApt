// Entry point. Checks every building that has a supported platform and an
// availability page, then records the results.
//
//   DATABASE_URL=postgres://... node src/run.js        # scrape and save
//   node src/run.js --dry-run [url]                     # scrape and print, no database
//
// DATABASE_URL must be the Supabase connection string for a role that bypasses
// row-level security (the service role). Keep it in GitHub Actions secrets only.

import pg from 'pg';
import griffis from './adapters/griffis.js';
import { politeFetch } from './fetch.js';
import { recordScrape, recordFailure } from './store.js';

const ADAPTERS = { [griffis.platform]: griffis };
const PAUSE_MS = 5_000; // between buildings, to stay gentle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dryRun(url) {
  const target = url || 'https://griffisresidential.com/property/the-domain/pricing-availability/';
  const parsed = griffis.parse(await politeFetch(target));
  const available = parsed.plans.filter((p) => p.available);
  console.log(`${parsed.plans.length} floor plans (${available.length} available), ${parsed.units.length} available units`);
  for (const p of parsed.plans) {
    const status = p.available ? `${p.availableCount} available from $${p.baseRent}` : 'unavailable';
    console.log(`  ${p.name.padEnd(22)} ${String(p.beds ?? '?')}bd/${p.baths ?? '?'}ba  ${p.sqftMin ?? '?'}-${p.sqftMax ?? '?'} sqft  ${status}`);
  }
  if (parsed.problems.length) console.log('Problems:', parsed.problems);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) return dryRun(args.find((a) => a.startsWith('http')));

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  await client.connect();
  let failures = 0;
  try {
    const { rows: buildings } = await client.query(
      `select id, name, platform, availability_url from buildings
       where availability_url is not null and platform = any($1) order by id`,
      [Object.keys(ADAPTERS)],
    );
    for (const [i, b] of buildings.entries()) {
      if (i) await sleep(PAUSE_MS);
      try {
        const parsed = ADAPTERS[b.platform].parse(await politeFetch(b.availability_url));
        const r = await recordScrape(client, b, parsed);
        console.log(`${b.name}: ${r.plans} plans, ${r.units} units, ${r.opened.length} newly available, ${r.closed.length} gone${r.healthy ? '' : ' (layout check failed: windows left open)'}`);
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
