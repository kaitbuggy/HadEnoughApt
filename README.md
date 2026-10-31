# Unit Tracker: Phase 1

A tool for tracking specific apartment **units and floor plans**, not just buildings. It records the layout details listing sites leave out (kitchen shape, walk-in shower, ADA, which way a unit faces, whether it faces the courtyard) and keeps a **history of when each unit or plan was on the market**.

## What's here

| File | What it is |
|---|---|
| `db/schema.sql` | Postgres/Supabase schema. Tested on Postgres 16. |
| `db/policies.sql` | Row-level security: anyone can read listing data, each visitor's watchlist and notes are private to them, and only admins can write labels. |
| `db/seed.sql` | The attributes screened on, plus 4 Austin buildings. |
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
| Griffis at The Domain | griffisresidential.com/property/the-domain/pricing-availability/ (site built by Engrain, the company behind SightMap) | 19 plan cards (Milan, Shanghai, London…): homes available, sq ft, "From" price, base rent, lease length. **Unavailable plans are still listed.** Floor Plan / Home / Map views. | First adapter. Plan-level history works right away. Check whether the Map view is a SightMap embed with unit numbers and floors. |
| Solaris House at Uptown ATX | Official site not found yet | Built 2024. 1BR plans 570–1,075 sq ft. | Need the official URL. |
| The Grand at the Domain | Official site not found yet | Built 2019. Studio/1BR/2BR. | Need the official URL. |
| The Watson | Official site not found yet | Plan codes like A1.1, B2.3. A `WF` suffix appears to mean workforce-housing units. | Need the official URL. |

## Next steps
1. Get the official site links for Solaris, The Grand and The Watson.
2. Write the Griffis adapter as a GitHub Actions cron job. It writes `scrape_runs`, `availability_snapshots` and `availability_windows`.
3. Labeling job: new floor-plan image → vision model → pending `labels` → review queue.
