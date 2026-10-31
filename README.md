# Unit Tracker: Phase 1

A tool for tracking specific apartment **units and floor plans**, not just buildings. It records the layout details listing sites leave out (kitchen shape, walk-in shower, ADA, which way a unit faces, whether it faces the courtyard) and keeps a **history of when each unit or plan was on the market**.

## What's here

| File | What it is |
|---|---|
| `db/schema.sql` | Postgres/Supabase schema. Tested on Postgres 16. |
| `db/policies.sql` | Row-level security: anyone can read listing data, each visitor's watchlist and notes are private to them, and only admins can write labels. |
| `db/seed.sql` | The attributes screened on, plus 4 Austin buildings. |
| `scraper/` | Node scraper: reads each building's availability page and records plans, units, prices and history. |
| `.github/workflows/` | `scrape.yml` checks availability twice a day; `test.yml` runs tests on every pull request. |
| `shell/index.html` | Clickable prototype of the Phase 1 screens. Open it in a browser. |
| `SECURITY.md` | Repo, secrets and database security checklist. |

To load it on Supabase, open the SQL Editor and run, in order: `schema.sql`, `policies.sql`, `seed.sql`.
When adding Supabase Auth, make `users.id` match `auth.users(id)` so `auth.uid()` lines up with each row's owner.

## Data model in one picture

```
buildings ─┬─ floor_plans ─┬─ units
           │               │
           │               └─ labels (model proposes → admin accepts/corrects)
           ├─ fees              (true monthly + move-in cost)
           ├─ location_scores   (coffee within 10 min walk, trails, commute)
           └─ scrape_runs ── availability_snapshots ──► availability_windows
                                                         (opened / closed / rent seen)
watches ──► alerts_sent          ratings / criteria / notes  (weighted ranking)
```

- **availability_windows** is what makes the tool different. Each time a plan or unit shows up, it opens a window, and when it disappears, the window closes. From that you get "last listed 3 weeks ago, usually leases in 16 days, lowest rent seen $1,428."
- **labels** record where each answer came from: `model`, `user`, `crowd` or `scraped`. A reviewed label always beats a model's guess (see the `current_labels` view). Phase 2 crowdsourcing reuses this table unchanged.
- **scrape_runs.status** includes `failed` and `changed_layout`. When a building's site changes and the scraper breaks, an admin gets notified instead of alerts quietly stopping.

## Austin buildings: how their sites work

| Building | Site / availability | What the site shows | Scraper plan |
|---|---|---|---|
| Griffis at The Domain | griffisresidential.com/property/the-domain/pricing-availability/ (WordPress with Engrain's "Spaces" plugin) | 29 plan cards, including unavailable ones. Each available card lists its unit ids, and the page embeds per-unit move-in dates and prices for every lease length. Floor plan image for every plan. | **Adapter built** (`scraper/src/adapters/griffis.js`). Unit numbers aren't on the page; they're in the SightMap embed, which is a later step. |
| Solaris House at Uptown ATX | Official site not found yet | Built 2024. 1BR plans 570–1,075 sq ft. | Need the official URL. |
| The Grand at the Domain | Official site not found yet | Built 2019. Studio/1BR/2BR. | Need the official URL. |
| The Watson | Official site not found yet | Plan codes like A1.1, B2.3. A `WF` suffix appears to mean workforce-housing units. | Need the official URL. |

## Running the scraper

```bash
cd scraper
npm ci
npm test                    # parser tests (add TEST_DATABASE_URL for the database test)
npm run scrape:dry          # fetch Griffis and print what it found; no database needed
DATABASE_URL=... npm run scrape
```

### Turning on the scheduled job
1. Create a Supabase project and run `db/schema.sql`, `db/policies.sql`, `db/seed.sql` in the SQL Editor.
2. Copy the database connection string (Project Settings → Database → Connection string, "Session pooler").
3. In GitHub: Settings → Secrets and variables → Actions → New repository secret, name `DATABASE_URL`.
4. Actions tab → "Check availability" → Run workflow, to test it once.

Until the secret exists, the scheduled job skips itself instead of failing.

### How it stays polite and safe
- Checks twice a day, identifies itself with a clear user agent, and follows robots.txt.
- If a page stops looking like what the adapter expects, the run is recorded as `changed_layout`, nothing is marked as leased, and the job fails so GitHub emails the repo owner.

## Next steps
1. Official site links for Solaris House, The Grand and The Watson, then one adapter per platform.
2. Labeling job: new floor-plan image → vision model → pending `labels` → review queue.
3. Unit numbers and floors from the SightMap embed.
