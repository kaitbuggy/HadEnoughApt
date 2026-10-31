// Writes one parsed scrape into the database and keeps availability history.
//
// History works through availability_windows:
//   * a plan or unit that is available now and has no open window -> open one
//   * a plan or unit that is still available -> widen the window's rent range
//   * an open window whose plan or unit is no longer listed -> close it
// Windows are only closed when the scrape looks healthy, so a broken page never
// makes everything look leased.

export async function recordScrape(client, building, parsed, { observedAt = new Date() } = {}) {
  const healthy = parsed.problems.length === 0;
  const summary = { plans: 0, units: 0, opened: [], closed: [] };

  await client.query('begin');
  try {
    const run = await client.query(
      `insert into scrape_runs (building_id, started_at, status) values ($1, $2, 'running') returning id`,
      [building.id, observedAt],
    );
    const runId = run.rows[0].id;

    // Floor plans
    const planIds = new Map(); // externalId -> db id
    for (const p of parsed.plans) {
      const r = await client.query(
        `insert into floor_plans (building_id, external_id, name, beds, baths, sqft_min, sqft_max, image_url, first_seen_at, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         on conflict (building_id, external_id) do update set
           name = excluded.name,
           beds = coalesce(excluded.beds, floor_plans.beds),
           baths = coalesce(excluded.baths, floor_plans.baths),
           sqft_min = coalesce(excluded.sqft_min, floor_plans.sqft_min),
           sqft_max = coalesce(excluded.sqft_max, floor_plans.sqft_max),
           -- a new image means labels may need another look
           image_sha256 = case when floor_plans.image_url is distinct from excluded.image_url then null else floor_plans.image_sha256 end,
           image_url = coalesce(excluded.image_url, floor_plans.image_url),
           last_seen_at = excluded.last_seen_at
         returning id`,
        [building.id, p.externalId, p.name, p.beds, p.baths, p.sqftMin, p.sqftMax, p.imageUrl, observedAt],
      );
      planIds.set(p.externalId, r.rows[0].id);
      await client.query(
        `insert into availability_snapshots (scrape_run_id, floor_plan_id, available_count, price_from, base_rent, lease_months, available_on, observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [runId, r.rows[0].id, p.availableCount, p.priceFrom, p.baseRent, p.leaseMonths, p.soonest || null, observedAt],
      );
      summary.plans++;
    }

    // Units
    const unitIds = new Map();
    for (const u of parsed.units) {
      const r = await client.query(
        `insert into units (building_id, external_id, floor_plan_id, floor_ref, first_seen_at, last_seen_at)
         values ($1,$2,$3,$4,$5,$5)
         on conflict (building_id, external_id) do update set
           floor_plan_id = coalesce(excluded.floor_plan_id, units.floor_plan_id),
           floor_ref = coalesce(excluded.floor_ref, units.floor_ref),
           last_seen_at = excluded.last_seen_at
         returning id`,
        [building.id, u.externalId, planIds.get(u.planExternalId) ?? null, u.floorRef, observedAt],
      );
      unitIds.set(u.externalId, r.rows[0].id);
      await client.query(
        `insert into availability_snapshots (scrape_run_id, unit_id, floor_plan_id, base_rent, lease_months, lease_prices, available_on, observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [runId, r.rows[0].id, planIds.get(u.planExternalId) ?? null, u.lowestRent, u.lowestRentMonths,
          JSON.stringify(u.leasePrices), u.availableOn, observedAt],
      );
      summary.units++;
    }

    // Availability windows: plans
    const availablePlans = parsed.plans.filter((p) => p.availableCount > 0);
    for (const p of availablePlans) {
      const opened = await upsertWindow(client, 'floor_plan_id', planIds.get(p.externalId), p.baseRent, observedAt);
      if (opened) summary.opened.push({ kind: 'plan', name: p.name, rent: p.baseRent });
    }
    // Availability windows: units
    for (const u of parsed.units) {
      const opened = await upsertWindow(client, 'unit_id', unitIds.get(u.externalId), u.lowestRent, observedAt);
      if (opened) summary.opened.push({ kind: 'unit', id: u.externalId, plan: u.planExternalId, rent: u.lowestRent });
    }

    if (healthy) {
      const stillPlans = availablePlans.map((p) => planIds.get(p.externalId));
      const stillUnits = parsed.units.map((u) => unitIds.get(u.externalId));
      const closed = await client.query(
        `update availability_windows w set closed_at = $2
         from floor_plans fp
         where w.closed_at is null and w.floor_plan_id = fp.id and fp.building_id = $1
           and not (w.floor_plan_id = any($3::bigint[]))
         returning fp.name`,
        [building.id, observedAt, stillPlans],
      );
      const closedUnits = await client.query(
        `update availability_windows w set closed_at = $2
         from units u
         where w.closed_at is null and w.unit_id = u.id and u.building_id = $1
           and not (w.unit_id = any($3::bigint[]))
         returning u.external_id`,
        [building.id, observedAt, stillUnits],
      );
      summary.closed.push(
        ...closed.rows.map((r) => ({ kind: 'plan', name: r.name })),
        ...closedUnits.rows.map((r) => ({ kind: 'unit', id: r.external_id })),
      );
    }

    await client.query(
      `update scrape_runs set finished_at = now(), status = $2, items_found = $3, error = $4 where id = $1`,
      [runId, healthy ? 'ok' : 'changed_layout', summary.plans + summary.units, healthy ? null : parsed.problems.join(' ')],
    );
    await client.query('commit');
    return { runId, healthy, ...summary };
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

// Returns true when a new window was opened.
async function upsertWindow(client, column, id, rent, observedAt) {
  if (id == null) return false;
  const open = await client.query(
    `select id from availability_windows where ${column} = $1 and closed_at is null`,
    [id],
  );
  if (open.rows.length) {
    if (rent != null) {
      await client.query(
        `update availability_windows set
           min_rent_seen = least(coalesce(min_rent_seen, $2), $2),
           max_rent_seen = greatest(coalesce(max_rent_seen, $2), $2)
         where id = $1`,
        [open.rows[0].id, rent],
      );
    }
    return false;
  }
  await client.query(
    `insert into availability_windows (${column}, opened_at, min_rent_seen, max_rent_seen) values ($1,$2,$3,$3)`,
    [id, observedAt, rent],
  );
  return true;
}

export async function recordFailure(client, building, error) {
  await client.query(
    `insert into scrape_runs (building_id, finished_at, status, error) values ($1, now(), 'failed', $2)`,
    [building.id, String(error?.message || error).slice(0, 2000)],
  );
}
