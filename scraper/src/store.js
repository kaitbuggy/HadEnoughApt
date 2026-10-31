// Writes one parsed scrape into the database, keeps availability history, and
// creates in-site notifications for visitors watching the affected units.
//
// History works through availability_windows:
//   * a plan or unit that is available now and has no open window -> open one
//   * a plan or unit that is still available -> widen the window's rent range
//     (a new low is a price drop)
//   * an open window whose plan or unit is no longer listed -> close it
// Windows are only closed when the scrape looks healthy, so a broken page never
// makes everything look leased.

export async function recordScrape(client, building, parsed, { observedAt = new Date() } = {}) {
  const healthy = parsed.problems.length === 0;
  const summary = { plans: 0, units: 0, opened: [], closed: [], priceDrops: [], notifications: 0 };
  const unitEvents = []; // { kind, unitId, windowId, rent, previousRent, availableOn }

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
        `insert into units (building_id, external_id, floor_plan_id, floor_ref, unit_number, section, floor, sqft, view_image_url, first_seen_at, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         on conflict (building_id, external_id) do update set
           floor_plan_id = coalesce(excluded.floor_plan_id, units.floor_plan_id),
           floor_ref = coalesce(excluded.floor_ref, units.floor_ref),
           unit_number = coalesce(excluded.unit_number, units.unit_number),
           section = coalesce(excluded.section, units.section),
           floor = coalesce(excluded.floor, units.floor),
           sqft = coalesce(excluded.sqft, units.sqft),
           view_image_url = coalesce(excluded.view_image_url, units.view_image_url),
           last_seen_at = excluded.last_seen_at
         returning id`,
        [building.id, u.externalId, planIds.get(u.planExternalId) ?? null, u.floorRef ?? null,
          u.unitNumber ?? null, u.section ?? null, u.floor ?? null, u.sqft ?? null, u.viewImageUrl ?? null, observedAt],
      );
      unitIds.set(u.externalId, r.rows[0].id);
      await client.query(
        `insert into availability_snapshots (scrape_run_id, unit_id, floor_plan_id, base_rent, lease_months, lease_prices, available_on, observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [runId, r.rows[0].id, planIds.get(u.planExternalId) ?? null, u.lowestRent, u.lowestRentMonths,
          JSON.stringify(u.leasePrices || {}), u.availableOn, observedAt],
      );
      summary.units++;
    }

    // Availability windows: plans
    const availablePlans = parsed.plans.filter((p) => p.availableCount > 0);
    for (const p of availablePlans) {
      const w = await upsertWindow(client, 'floor_plan_id', planIds.get(p.externalId), p.baseRent, observedAt);
      if (w?.opened) summary.opened.push({ kind: 'plan', name: p.name, rent: p.baseRent });
    }
    // Availability windows: units
    for (const u of parsed.units) {
      const unitId = unitIds.get(u.externalId);
      const w = await upsertWindow(client, 'unit_id', unitId, u.lowestRent, observedAt);
      if (!w) continue;
      if (w.opened) {
        summary.opened.push({ kind: 'unit', id: u.externalId, plan: u.planExternalId, rent: u.lowestRent });
        unitEvents.push({ kind: 'listed', unitId, windowId: w.windowId, rent: u.lowestRent, availableOn: u.availableOn });
      } else if (w.priceDrop) {
        summary.priceDrops.push({ id: u.externalId, from: w.priceDrop.from, to: w.priceDrop.to });
        unitEvents.push({ kind: 'price_drop', unitId, windowId: w.windowId, rent: w.priceDrop.to, previousRent: w.priceDrop.from, availableOn: u.availableOn });
      }
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
         returning w.id as window_id, u.id as unit_id, u.external_id, w.min_rent_seen`,
        [building.id, observedAt, stillUnits],
      );
      summary.closed.push(
        ...closed.rows.map((r) => ({ kind: 'plan', name: r.name })),
        ...closedUnits.rows.map((r) => ({ kind: 'unit', id: r.external_id })),
      );
      for (const r of closedUnits.rows) {
        unitEvents.push({ kind: 'leased', unitId: r.unit_id, windowId: r.window_id, rent: r.min_rent_seen == null ? null : Number(r.min_rent_seen) });
      }
    }

    for (const e of unitEvents) summary.notifications += await notifyWatchers(client, e);

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

// Returns { windowId, opened, priceDrop } or null when there is nothing to track.
async function upsertWindow(client, column, id, rent, observedAt) {
  if (id == null) return null;
  const open = await client.query(
    `select id, min_rent_seen from availability_windows where ${column} = $1 and closed_at is null`,
    [id],
  );
  if (open.rows.length) {
    const w = open.rows[0];
    const prevMin = w.min_rent_seen == null ? null : Number(w.min_rent_seen);
    if (rent != null) {
      await client.query(
        `update availability_windows set
           min_rent_seen = least(coalesce(min_rent_seen, $2), $2),
           max_rent_seen = greatest(coalesce(max_rent_seen, $2), $2)
         where id = $1`,
        [w.id, rent],
      );
    }
    const priceDrop = rent != null && prevMin != null && rent < prevMin ? { from: prevMin, to: rent } : null;
    return { windowId: w.id, opened: false, priceDrop };
  }
  const ins = await client.query(
    `insert into availability_windows (${column}, opened_at, min_rent_seen, max_rent_seen) values ($1,$2,$3,$3) returning id`,
    [id, observedAt, rent],
  );
  return { windowId: ins.rows[0].id, opened: true, priceDrop: null };
}

// Creates one notification per matching watch. Rules:
//   * a watch on the unit itself hears about listed, price drops and leased
//   * a watch on its floor plan or building hears about listed and price drops
//   * max_base_rent and min_floor filters apply when the values are known
// The dedupe key makes re-running a scrape safe.
async function notifyWatchers(client, e) {
  const dedupe = e.kind === 'price_drop' ? `${e.kind}:${e.windowId}:${e.rent}` : `${e.kind}:${e.windowId}`;
  const res = await client.query(
    `insert into notifications (user_id, watch_id, kind, building_id, floor_plan_id, unit_id, window_id, title, detail, dedupe_key)
     select w.user_id, w.id, $2, u.building_id, u.floor_plan_id, u.id, $3,
            concat_ws(' · ',
              coalesce('Unit ' || u.unit_number, fp.name || ' home'),
              case when u.unit_number is not null then fp.name end,
              b.name,
              case $2 when 'listed' then 'available' when 'price_drop' then 'price dropped' else 'leased' end),
            jsonb_strip_nulls(jsonb_build_object('rent', $4::numeric, 'previous_rent', $5::numeric, 'available_on', $6::date)),
            $7
     from units u
     join buildings b on b.id = u.building_id
     left join floor_plans fp on fp.id = u.floor_plan_id
     join watches w on w.active and (
          w.unit_id = u.id
       or ($2 <> 'leased' and (w.floor_plan_id = u.floor_plan_id or w.building_id = u.building_id)))
     where u.id = $1
       and (w.max_base_rent is null or $4::numeric is null or $2 = 'leased' or $4::numeric <= w.max_base_rent)
       and (w.min_floor is null or u.floor is null or u.floor >= w.min_floor)
     on conflict (watch_id, dedupe_key) do nothing`,
    [e.unitId, e.kind, e.windowId, e.rent ?? null, e.previousRent ?? null, e.availableOn ?? null, dedupe],
  );
  return res.rowCount;
}

export async function recordFailure(client, building, error) {
  await client.query(
    `insert into scrape_runs (building_id, finished_at, status, error) values ($1, now(), 'failed', $2)`,
    [building.id, String(error?.message || error).slice(0, 2000)],
  );
}
