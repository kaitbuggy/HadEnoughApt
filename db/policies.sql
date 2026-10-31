-- Row-level security for Supabase. Run after schema.sql.
--
-- Rules:
--   * Nobody who isn't logged in can read or write anything.
--   * Building, floor plan, unit and availability data: logged-in users can read it;
--     only the scraper writes it (it uses the service-role key, which bypasses RLS).
--   * Personal tables (household, watches, ratings, notes, criteria, destinations):
--     each user can only see and change their own rows.
--   * Labels: logged-in users can read them, add their own, and review them.

-- Turn RLS on for every table. With RLS on and no policy, access is denied by default.
do $$
declare t text;
begin
  foreach t in array array[
    'users','buildings','floor_plans','units','scrape_runs','availability_snapshots',
    'availability_windows','attribute_defs','labels','fees','destinations','location_scores',
    'household','watches','alerts_sent','criteria','ratings','notes']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- Shared listing data: read-only for logged-in users.
do $$
declare t text;
begin
  foreach t in array array[
    'buildings','floor_plans','units','availability_snapshots','availability_windows',
    'attribute_defs','fees','location_scores','scrape_runs']
  loop
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- Your own profile row.
create policy users_self on users for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Personal tables: owner only.
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

-- Alerts: visible only to the owner of the watch.
create policy alerts_owner on alerts_sent for select to authenticated
  using (exists (select 1 from watches w where w.id = watch_id and w.user_id = auth.uid()));

-- Labels.
create policy labels_read on labels for select to authenticated using (true);
create policy labels_add  on labels for insert to authenticated
  with check (created_by = auth.uid() and source in ('user','crowd') and status = 'pending');
-- Phase 1: you are the only reviewer. In Phase 2, narrow this to a reviewers role.
create policy labels_review on labels for update to authenticated
  using (true) with check (reviewed_by = auth.uid());

-- Views run with the caller's permissions, so they respect the rules above.
alter view current_labels        set (security_invoker = true);
alter view floor_plan_history    set (security_invoker = true);
alter view building_monthly_fees set (security_invoker = true);
