// Runs only when TEST_DATABASE_URL points at a scratch Postgres database that
// already has db/schema.sql (and db/seed.sql) loaded. Never point it at production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parse } from '../src/adapters/griffis.js';
import { recordScrape } from '../src/store.js';

const url = process.env.TEST_DATABASE_URL;
const html = readFileSync(new URL('./fixtures/griffis-sample.html', import.meta.url), 'utf8');

test('history: open, stay open, close, and survive a broken page', { skip: !url && 'set TEST_DATABASE_URL to run' }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [b] } = await client.query(`select id from buildings where name = 'Griffis at The Domain'`);
    const building = { id: b.id };
    const t0 = new Date('2026-11-01T13:00:00Z');
    const t1 = new Date('2026-11-01T23:00:00Z');
    const t2 = new Date('2026-11-02T13:00:00Z');

    // Run 1: everything on the page opens a window.
    const r1 = await recordScrape(client, building, parse(html), { observedAt: t0 });
    assert.equal(r1.healthy, true);
    assert.equal(r1.plans, 3);
    assert.equal(r1.units, 8);
    assert.equal(r1.opened.filter((o) => o.kind === 'plan').length, 2); // Shanghai, Milan (London unavailable)
    assert.equal(r1.opened.filter((o) => o.kind === 'unit').length, 8);

    // Run 2: one Milan unit leased. Remove it from both the card and the unit data.
    const gone = '3085371';
    const html2 = html
      .replace(`,${gone}"`, '"')
      .replace('>7</span>', '>6</span>')
      .replace(/const spacesUnitJSON = (.*)\n/, (_, json) =>
        `const spacesUnitJSON = ${JSON.stringify(JSON.parse(json).filter((u) => u.id !== gone))}\n`);
    const p2 = parse(html2);
    assert.deepEqual(p2.problems, [], 'edited fixture should still be consistent');
    const r2 = await recordScrape(client, building, p2, { observedAt: t1 });
    assert.equal(r2.opened.length, 0);
    assert.deepEqual(r2.closed, [{ kind: 'unit', id: gone }]);

    // Run 3: the page breaks. Nothing should be closed.
    const r3 = await recordScrape(client, building, parse('<html><body>Maintenance</body></html>'), { observedAt: t2 });
    assert.equal(r3.healthy, false);
    assert.equal(r3.closed.length, 0);
    const { rows: [run] } = await client.query(`select status, error from scrape_runs where id = $1`, [r3.runId]);
    assert.equal(run.status, 'changed_layout');

    // History view: Milan listed once, still available.
    const { rows: [milan] } = await client.query(
      `select times_listed, available_now, lowest_rent_seen from floor_plan_history where floor_plan = 'Milan'`,
    );
    assert.equal(Number(milan.times_listed), 1);
    assert.equal(milan.available_now, true);
    assert.equal(Number(milan.lowest_rent_seen), 1428);

    // The leased unit's window is closed with its open/close times.
    const { rows: [w] } = await client.query(
      `select w.opened_at, w.closed_at from availability_windows w join units u on u.id = w.unit_id where u.external_id = $1`,
      [gone],
    );
    assert.equal(w.opened_at.toISOString(), t0.toISOString());
    assert.equal(w.closed_at.toISOString(), t1.toISOString());

    // Unavailable plan London was recorded, with no window.
    const { rows: [london] } = await client.query(
      `select fp.sqft_min, count(w.id)::int as windows from floor_plans fp left join availability_windows w on w.floor_plan_id = fp.id
       where fp.name = 'London' group by fp.sqft_min`,
    );
    assert.equal(london.sqft_min, 644);
    assert.equal(london.windows, 0);
  } finally {
    await client.end();
  }
});
