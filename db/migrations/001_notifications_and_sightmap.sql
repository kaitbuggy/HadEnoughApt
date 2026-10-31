-- Migration 001: in-site notifications, SightMap links, building websites.
-- For databases created before this change. Fresh installs get all of this from
-- schema.sql, policies.sql and seed.sql, so skip this file there.
-- Run once in the Supabase SQL Editor.

begin;

-- 1. Replace email-style alerts with in-site notifications.
drop table if exists alerts_sent;

create table notifications (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references users(id) on delete cascade,
  watch_id      bigint references watches(id) on delete cascade,
  kind          text not null check (kind in ('listed','price_drop','leased')),
  building_id   bigint references buildings(id) on delete cascade,
  floor_plan_id bigint references floor_plans(id) on delete cascade,
  unit_id       bigint references units(id) on delete cascade,
  window_id     bigint references availability_windows(id) on delete set null,
  title         text not null,
  detail        jsonb,
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  seen_at       timestamptz,
  unique (watch_id, dedupe_key)
);
create index on notifications (user_id, created_at desc);

alter table notifications enable row level security;
alter table notifications force row level security;
create policy notifications_read on notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_mark_seen on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on notifications to authenticated;
grant update (seen_at) on notifications to authenticated;
grant usage on all sequences in schema public to authenticated;

-- 2. SightMap embed per building (unit numbers and floors), and unit details it provides.
alter table buildings add column if not exists sightmap_url text;
alter table units add column if not exists section text;
alter table units add column if not exists view_image_url text;
-- Unit numbers can repeat across sub-buildings of one complex; the site's own id stays unique.
alter table units drop constraint if exists units_building_id_unit_number_key;

-- 3. Building websites and platforms found on Oct 30, 2026.
update buildings set sightmap_url = 'https://sightmap.com/embed/60p7krjnw7n'
  where name = 'Griffis at The Domain';

update buildings set
  website_url = 'https://www.thewatson.com/austin/the-watson/conventional/',
  availability_url = 'https://sightmap.com/embed/x1p8jg4rvd6',
  sightmap_url = 'https://sightmap.com/embed/x1p8jg4rvd6',
  platform = 'sightmap'
  where name = 'The Watson';

update buildings set
  website_url = 'https://www.solarishouseapartments.com/',
  platform = 'rentcafe'
  where name = 'Solaris House at Uptown ATX';

update buildings set website_url = 'https://thegrandatdomain.com/'
  where name = 'The Grand at the Domain';

commit;
