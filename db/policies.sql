-- Row-level security for Supabase. Run after schema.sql.
--
-- Access model (no login needed to use the site):
--   * Listing data (buildings, floor plans, units, availability, labels, fees,
--     location scores): anyone can read it, including visitors who never sign in.
--   * Visitors' own data (watchlist, notes, ratings, household, destinations):
--     the site gives each visitor a Supabase anonymous session in the background,
--     with no login screen. auth.uid() identifies that visitor, so each visitor
--     sees and changes only their own rows. Clearing browser data starts a new
--     anonymous visitor; a later "save across devices" option can link an email.
--   * Writing listing data: only the scraper (service-role key bypasses RLS)
--     and admins (rows in the admins table).

-- Turn RLS on for every table. With RLS on and no matching policy, access is denied.
do $$
declare t text;
begin
  foreach t in array array[
    'users','admins','buildings','floor_plans','units','scrape_runs','availability_snapshots',
    'availability_windows','attribute_defs','labels','fees','destinations','location_scores',
    'household','watches','notifications','criteria','ratings','notes']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

create function is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from admins where user_id = auth.uid()) $$;

-- Listing data: public read; admins may also write.
do $$
declare t text;
begin
  foreach t in array array[
    'buildings','floor_plans','units','availability_snapshots','availability_windows',
    'attribute_defs','fees','location_scores','labels']
  loop
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('create policy %I on %I for all to authenticated using (is_admin()) with check (is_admin())', t || '_admin', t);
  end loop;
end $$;

-- Scraper health is for admins only.
create policy scrape_runs_admin on scrape_runs for select to authenticated using (is_admin());

-- Admin list: admins can see it; nobody can add themselves.
create policy admins_read on admins for select to authenticated using (is_admin());

-- Each visitor's own profile row.
create policy users_self on users for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Per-visitor tables: owner only.
do $$
declare t text;
begin
  foreach t in array array['household','watches','criteria','ratings','notes','destinations']
  loop
    execute format(
      'create policy %I on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner', t);
  end loop;
end $$;

-- Notifications: each visitor sees and marks read only their own. Only the scraper creates them.
create policy notifications_read on notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_mark_seen on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Views run with the caller's permissions, so they follow the rules above.
alter view current_labels        set (security_invoker = true);
alter view floor_plan_history    set (security_invoker = true);
alter view building_monthly_fees set (security_invoker = true);

-- ─────────────────────────────────────────────────────────────
-- Explicit grants. The project is set up with "Automatically expose new tables"
-- turned off, so the web roles can only reach what is listed here. Row-level
-- security above still decides which rows each role sees.
-- ─────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;

-- Listing data: anyone can read; logged-in admins can write (RLS enforces admin).
grant select on buildings, floor_plans, units, availability_snapshots, availability_windows,
               attribute_defs, fees, location_scores, labels
  to anon, authenticated;
grant insert, update, delete on buildings, floor_plans, units, availability_snapshots,
               availability_windows, attribute_defs, fees, location_scores, labels
  to authenticated;

-- Views over listing data.
grant select on current_labels, floor_plan_history to anon, authenticated;
grant select on building_monthly_fees to authenticated;

-- Per-visitor tables: only signed-in sessions (anonymous ones included).
grant select, insert, update, delete on users, household, watches, criteria, ratings, notes, destinations
  to authenticated;
grant select on scrape_runs, admins to authenticated;
grant select on notifications to authenticated;
grant update (seen_at) on notifications to authenticated;   -- marking read is the only change allowed

-- Identity columns need sequence access for inserts.
grant usage on all sequences in schema public to authenticated;

grant execute on function is_admin() to anon, authenticated;
