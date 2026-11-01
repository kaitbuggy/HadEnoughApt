// Exports the public listing data (buildings, floor plans, units, availability
// history) to one JSON file for the website. Visitor data (users, watches,
// notifications, notes, ratings, household, destinations) is never read here.
//
//   DATABASE_URL=postgres://... node src/export.js [out-file]
//
// Read-only: every query runs inside a READ ONLY transaction.

import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const out = process.argv[2] ?? 'out/site-data.json';

const QUERIES = {
  buildings: `
    select id, name, address, city, website_url, availability_url, platform
    from buildings order by id`,
  floorPlans: `
    select id, building_id, external_id, name, beds, baths, sqft_min, sqft_max, image_url,
           first_seen_at, last_seen_at
    from floor_plans order by building_id, name`,
  units: `
    select id, building_id, floor_plan_id, unit_number, floor, floor_ref, is_top_floor,
           facing, view_of, sqft, first_seen_at, last_seen_at
    from units order by building_id, unit_number nulls last, id`,
  // Latest observation for each unit and each plan.
  latestUnit: `
    select distinct on (s.unit_id) s.unit_id, s.base_rent, s.price_from, s.lease_months,
           s.lease_prices, s.available_on, s.observed_at
    from availability_snapshots s where s.unit_id is not null
    order by s.unit_id, s.observed_at desc`,
  latestPlan: `
    select distinct on (s.floor_plan_id) s.floor_plan_id, s.available_count, s.base_rent,
           s.price_from, s.lease_months, s.available_on, s.observed_at
    from availability_snapshots s where s.floor_plan_id is not null and s.unit_id is null
    order by s.floor_plan_id, s.observed_at desc`,
  windows: `
    select id, floor_plan_id, unit_id, opened_at, closed_at, min_rent_seen, max_rent_seen
    from availability_windows order by opened_at`,
  // Layout labels for floor plans (kitchen shape, bathroom). Pending labels are
  // included and marked, so the site can say they haven't been checked yet.
  labels: `
    select floor_plan_id, attribute_key, value, status, confidence
    from current_labels where floor_plan_id is not null
    order by floor_plan_id, attribute_key`,
  // Every layout review answer and the model's first guess, so the site can show
  // how often the model matches the reviewer (and auto-approve once it's reliable).
  reviews: `
    select floor_plan_id, attribute_key, value, status, created_at
    from labels where source = 'user' and floor_plan_id is not null
    order by created_at`,
  modelGuesses: `
    select distinct on (floor_plan_id, attribute_key) floor_plan_id, attribute_key, value, confidence
    from labels where source = 'model' and floor_plan_id is not null
    order by floor_plan_id, attribute_key, created_at`,
  lastRuns: `
    select distinct on (building_id) building_id, status, started_at, finished_at, items_found
    from scrape_runs order by building_id, started_at desc`,
};

const num = (v) => (v == null ? null : Number(v));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const data = { exportedAt: new Date().toISOString() };
  try {
    await client.query('begin read only');
    for (const [key, sql] of Object.entries(QUERIES)) {
      data[key] = (await client.query(sql)).rows;
    }
    await client.query('commit');
  } finally {
    await client.end();
  }
  // Postgres numerics arrive as strings; send numbers.
  for (const p of data.floorPlans) { p.beds = num(p.beds); p.baths = num(p.baths); }
  for (const r of [...data.latestUnit, ...data.latestPlan]) { r.base_rent = num(r.base_rent); r.price_from = num(r.price_from); }
  for (const w of data.windows) { w.min_rent_seen = num(w.min_rent_seen); w.max_rent_seen = num(w.max_rent_seen); }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data));
  const counts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  console.log('Exported', counts, 'to', out);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
