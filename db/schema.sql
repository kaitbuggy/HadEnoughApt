-- Unit Tracker — Phase 1 schema (Postgres / Supabase)
-- Designed for one user now, but every user-owned row carries user_id so
-- Phase 2 (crowdsourcing) doesn't need a rebuild.

-- ─────────────────────────────────────────────────────────────
-- People
-- ─────────────────────────────────────────────────────────────
create table users (
  id           uuid primary key default gen_random_uuid(),  -- swap for auth.users(id) on Supabase
  email        text unique,                       -- null for anonymous visitors
  display_name text,
  created_at   timestamptz not null default now()
);

-- People allowed to review labels and run admin tasks.
create table admins (
  user_id uuid primary key references users(id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────
-- Buildings → floor plans → units
-- ─────────────────────────────────────────────────────────────
create table buildings (
  id               bigint generated always as identity primary key,
  name             text not null,
  address          text,
  city             text not null default 'Austin',
  lat              double precision,
  lng              double precision,
  website_url      text,
  availability_url text,                    -- the page the scraper reads
  platform         text,                    -- 'griffis-engrain', 'sightmap', 'rentcafe', 'entrata', 'manual', ...
  management       text,
  year_built       int,
  building_shape   text check (building_shape in ('closed_loop','u_shape','bar','tower','podium','other')),
  notes            text,
  created_at       timestamptz not null default now()
);

create table floor_plans (
  id            bigint generated always as identity primary key,
  building_id   bigint not null references buildings(id) on delete cascade,
  external_id   text,                       -- the site's own id for this plan
  name          text not null,              -- the building's own name, e.g. 'Milan'
  beds          numeric(3,1),               -- 0 = studio
  baths         numeric(3,1),
  sqft_min      int,
  sqft_max      int,
  image_url     text,
  image_sha256  text,                       -- detect when a plan image changes
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (building_id, name),
  unique (building_id, external_id)
);

create table units (
  id             bigint generated always as identity primary key,
  building_id    bigint not null references buildings(id) on delete cascade,
  floor_plan_id  bigint references floor_plans(id) on delete set null,
  external_id    text,                      -- the site's own id for this unit
  unit_number    text,                      -- null until a source reveals it
  floor          int,
  floor_ref      text,                      -- the site's floor tag when the number isn't known
  is_top_floor   boolean,
  facing         text check (facing in ('N','NE','E','SE','S','SW','W','NW')),
  faces_inward   boolean,                   -- courtyard side of a closed-loop building
  view_of        text,                      -- 'park', 'street', 'courtyard', 'another building', 'skyline'...
  sqft           int,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (building_id, unit_number),
  unique (building_id, external_id),
  check (unit_number is not null or external_id is not null)
);

-- ─────────────────────────────────────────────────────────────
-- Scraping + availability history  (the thing nobody else keeps)
-- ─────────────────────────────────────────────────────────────
create table scrape_runs (
  id           bigint generated always as identity primary key,
  building_id  bigint not null references buildings(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','failed','changed_layout')),
  items_found  int,
  error        text
);

-- One row per thing seen per run. Plan-level sites (like Griffis) fill floor_plan_id
-- and available_count; unit-level sites also fill unit_id.
create table availability_snapshots (
  id              bigint generated always as identity primary key,
  scrape_run_id   bigint not null references scrape_runs(id) on delete cascade,
  floor_plan_id   bigint references floor_plans(id) on delete cascade,
  unit_id         bigint references units(id) on delete cascade,
  available_count int,
  price_from      numeric(10,2),            -- advertised "from" price (often includes required fees)
  base_rent       numeric(10,2),
  lease_months    int,
  lease_prices    jsonb,                    -- e.g. {"12": 1831, "15": 1819}
  available_on    date,
  observed_at     timestamptz not null default now(),
  check (floor_plan_id is not null or unit_id is not null)
);
create index on availability_snapshots (floor_plan_id, observed_at);
create index on availability_snapshots (unit_id, observed_at);

-- Open/close windows, maintained by the scraper after each run.
-- Answers "when was this last available, for how long, at what price?"
create table availability_windows (
  id            bigint generated always as identity primary key,
  floor_plan_id bigint references floor_plans(id) on delete cascade,
  unit_id       bigint references units(id) on delete cascade,
  opened_at     timestamptz not null,
  closed_at     timestamptz,                -- null = available right now
  min_rent_seen numeric(10,2),
  max_rent_seen numeric(10,2),
  check ((floor_plan_id is null) <> (unit_id is null))
);

-- ─────────────────────────────────────────────────────────────
-- Attributes + labels  (model proposes, a human verifies)
-- ─────────────────────────────────────────────────────────────
create table attribute_defs (
  key         text primary key,             -- 'kitchen_shape'
  label       text not null,
  applies_to  text not null check (applies_to in ('floor_plan','unit','building')),
  value_type  text not null check (value_type in ('boolean','enum','number','text')),
  enum_values text[]                         -- for value_type = 'enum'
);

create table labels (
  id            bigint generated always as identity primary key,
  attribute_key text not null references attribute_defs(key),
  building_id   bigint references buildings(id) on delete cascade,
  floor_plan_id bigint references floor_plans(id) on delete cascade,
  unit_id       bigint references units(id) on delete cascade,
  value         jsonb not null,             -- true, "u_shape", 3, ...
  source        text not null check (source in ('model','user','crowd','scraped')),
  model_name    text,                       -- which vision model, for accuracy tracking
  confidence    real,
  evidence      text,                       -- model's one-line reason, shown in the review queue
  status        text not null default 'pending' check (status in ('pending','accepted','corrected','rejected')),
  created_by    uuid references users(id),
  reviewed_by   uuid references users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (num_nonnulls(building_id, floor_plan_id, unit_id) = 1)
);
create index on labels (status) where status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- True cost
-- ─────────────────────────────────────────────────────────────
create table fees (
  id          bigint generated always as identity primary key,
  building_id bigint not null references buildings(id) on delete cascade,
  name        text not null,                -- 'pet rent', 'parking (standard)', 'courtesy patrol'
  amount      numeric(10,2) not null,
  recurrence  text not null check (recurrence in ('one_time','monthly','yearly','refundable_deposit')),
  applies_if  text,                         -- 'pet', 'car', 'esa' ... null = always
  per_count   boolean not null default false, -- multiply by # of pets / cars
  notes       text
);

-- ─────────────────────────────────────────────────────────────
-- Location layer (auto-computed per building)
-- ─────────────────────────────────────────────────────────────
create table destinations (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references users(id) on delete cascade,
  name     text not null,                   -- "Husband's office"
  lat      double precision not null,
  lng      double precision not null,
  mode     text not null default 'drive' check (mode in ('drive','walk','bike','transit'))
);

create table location_scores (
  building_id    bigint not null references buildings(id) on delete cascade,
  metric         text not null,             -- 'coffee_10min_walk', 'trail_distance_m', 'commute_min:<dest id>', 'walk_score'
  value          numeric,
  source         text,                      -- 'osm', 'walkscore', 'routing'
  computed_at    timestamptz not null default now(),
  primary key (building_id, metric)
);

-- ─────────────────────────────────────────────────────────────
-- Per-visitor data: household, watchlist, ratings
-- ─────────────────────────────────────────────────────────────
create table household (
  user_id uuid primary key references users(id) on delete cascade,
  pets    int not null default 0,
  cars    int not null default 0,
  esa     boolean not null default false
);

create table watches (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references users(id) on delete cascade,
  building_id    bigint references buildings(id) on delete cascade,
  floor_plan_id  bigint references floor_plans(id) on delete cascade,
  unit_id        bigint references units(id) on delete cascade,
  max_base_rent  numeric(10,2),
  min_floor      int,
  require        jsonb,                     -- e.g. {"kitchen_shape":"u_shape","walk_in_shower":true,"faces_inward":false}
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  check (num_nonnulls(building_id, floor_plan_id, unit_id) = 1)
);

create table alerts_sent (
  id         bigint generated always as identity primary key,
  watch_id   bigint not null references watches(id) on delete cascade,
  window_id  bigint not null references availability_windows(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  unique (watch_id, window_id)              -- never alert twice for the same opening
);

create table criteria (
  user_id uuid not null references users(id) on delete cascade,
  key     text not null,                    -- 'price', 'first_impression', 'management', 'floor_plan', 'privacy', 'noise'
  weight  real not null,
  primary key (user_id, key)
);

create table ratings (
  user_id       uuid not null references users(id) on delete cascade,
  building_id   bigint references buildings(id) on delete cascade,
  unit_id       bigint references units(id) on delete cascade,
  criterion     text not null,
  score         smallint check (score between 1 and 5),
  note          text,
  rated_at      timestamptz not null default now(),
  check (num_nonnulls(building_id, unit_id) = 1)
);

create table notes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references users(id) on delete cascade,
  building_id bigint references buildings(id) on delete cascade,
  unit_id     bigint references units(id) on delete cascade,
  kind        text check (kind in ('tour','call','review','general','noise','management')),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Views
-- ─────────────────────────────────────────────────────────────

-- Best current label per (target, attribute): a human-reviewed label beats a model guess.
create view current_labels as
select distinct on (attribute_key, building_id, floor_plan_id, unit_id)
       attribute_key, building_id, floor_plan_id, unit_id, value, source, status, confidence
from labels
where status <> 'rejected'
order by attribute_key, building_id, floor_plan_id, unit_id,
         (status in ('accepted','corrected')) desc, created_at desc;

-- "When was this last on the market?"
create view floor_plan_history as
select fp.id as floor_plan_id, b.name as building, fp.name as floor_plan,
       count(w.id)                          as times_listed,
       max(w.opened_at)                     as last_opened,
       coalesce(bool_or(w.id is not null and w.closed_at is null), false)
                                            as available_now,
       avg(extract(epoch from (coalesce(w.closed_at, now()) - w.opened_at)) / 86400)::numeric(6,1)
                                            as avg_days_on_market,
       min(w.min_rent_seen)                 as lowest_rent_seen
from floor_plans fp
join buildings b on b.id = fp.building_id
left join availability_windows w on w.floor_plan_id = fp.id
group by fp.id, b.name, fp.name;

-- Monthly true cost for a household: base rent + every monthly fee that applies.
create view building_monthly_fees as
select f.building_id, h.user_id,
       sum(f.amount * case when f.per_count then
             case f.applies_if when 'pet' then h.pets when 'car' then h.cars else 1 end
           else 1 end) as monthly_fees
from fees f
cross join household h
where f.recurrence = 'monthly'
  and (f.applies_if is null
       or (f.applies_if = 'pet' and h.pets > 0)
       or (f.applies_if = 'car' and h.cars > 0)
       or (f.applies_if = 'esa' and h.esa))
group by f.building_id, h.user_id;
