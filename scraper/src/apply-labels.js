// Loads layout labels from labels/plan-labels.json into the labels table, so
// the website can filter floor plans by kitchen shape and bathroom.
//
//   DATABASE_URL=postgres://... node src/apply-labels.js ../labels/plan-labels.json
//
// Safe to run on every export: a label is only added when that plan has no
// label for that attribute yet, so reviews and corrections are never overwritten.
// New labels arrive as status 'pending' until someone checks them.

import pg from 'pg';
import { readFile } from 'node:fs/promises';

const file = process.argv[2] ?? '../labels/plan-labels.json';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const { labeled_by: by, plans } = JSON.parse(await readFile(file, 'utf8'));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let added = 0, unmatched = [];
  try {
    await client.query('begin');
    await client.query(`insert into attribute_defs (key, label, applies_to, value_type)
      values ('has_tub', 'Bathtub', 'floor_plan', 'boolean'), ('kitchen_island', 'Kitchen island', 'floor_plan', 'boolean'),
             ('bedroom_sizes', 'Bedroom sizes', 'floor_plan', 'text')
      on conflict (key) do nothing`);
    for (const p of plans) {
      const { rows } = await client.query(
        `select fp.id from floor_plans fp join buildings b on b.id = fp.building_id where b.name = $1 and fp.name = $2`,
        [p.building, p.plan]);
      if (!rows.length) { unmatched.push(`${p.building} / ${p.plan}`); continue; }
      const id = rows[0].id;
      const values = [
        ['kitchen_shape', p.kitchen_shape, p.kitchen_confidence],
        ['kitchen_island', p.kitchen_island, p.kitchen_confidence],
        ['walk_in_shower', p.walk_in_shower, p.bath_confidence],
        ['has_tub', p.has_tub, p.bath_confidence],
        ['bedroom_sizes', p.bedrooms, p.bedrooms_confidence],
      ];
      for (const [key, value, conf] of values) {
        if (value === null || value === undefined) continue;
        const r = await client.query(
          `insert into labels (attribute_key, floor_plan_id, value, source, model_name, confidence, evidence, status)
           select $1, $2, $3::jsonb, 'model', $4, $5, $6, 'pending'
           where not exists (select 1 from labels where attribute_key = $1 and floor_plan_id = $2)`,
          [key, id, JSON.stringify(value), by, conf, key === 'bedroom_sizes' ? (p.bedrooms_note ?? null) : p.note]);
        added += r.rowCount;
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback'); throw e;
  } finally {
    await client.end();
  }
  console.log(`Labels added: ${added}.`, unmatched.length ? `No matching plan for: ${unmatched.join('; ')}` : 'Every plan matched.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
