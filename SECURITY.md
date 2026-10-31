# Security

This repo holds code for a personal apartment tracker. Personal data (household, notes, ratings, watchlist, places you commute to) lives **only in the database**, never in the repo.

## Repo settings checklist

- [ ] Two-factor authentication is on for the GitHub account
- [ ] The Claude GitHub app has access to **only this repository**
- [ ] `main` is protected: changes arrive through pull requests, reviewed before merging
- [ ] Settings → Code security: **Secret scanning** and **Push protection** are on
- [ ] Settings → Code security: **Dependabot alerts** are on
- [ ] Before making the repo public: search the history for personal details and keys

## Secrets

| Secret | Where it lives | Who uses it |
|---|---|---|
| Supabase public (anon) key | Website environment variable | Browser; limited by row-level security |
| Supabase service-role key | GitHub Actions secret | Scraper only; never sent to a browser |
| Vision model API key | GitHub Actions secret | Labeling job only; has a monthly spending limit |
| Database password | Password manager | You |

- Never commit `.env` files. `.gitignore` excludes them.
- If a key leaks, revoke it first, then clean the history.

## Database

- Row-level security is on for every table (`db/policies.sql`). With no matching rule, access is denied.
- Listing data is read-only for logged-in users. Only the scraper writes it.
- Personal tables are visible only to their owner.
- Store only what the tool needs. For example, a commute destination can be an approximate point.

## Website

- Login is required. Use Supabase Auth with a magic link or passkey, so there's no password to leak.
- HTTPS is provided by the host.
- The domain registrar account has 2FA and registrar lock turned on.

## Scraper

- Text and images scraped from building sites are untrusted. Escape all text before showing it on a page, and never insert scraped HTML directly.
- Be polite: check at most a few times a day, identify the scraper with a clear user agent, and respect robots.txt.
- Scraper runs log to `scrape_runs`, so a site change shows up as a failed run instead of silence.
