# Security

This repo holds code for an apartment unit tracker. Visitor data (household, notes, ratings, watchlist, commute destinations) lives **only in the database**, never in the repo.

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
| Database password | Password manager | Repo owner |

- Never commit `.env` files. `.gitignore` excludes them.
- If a key leaks, revoke it first, then clean the history.

## Database

- Row-level security is on for every table (`db/policies.sql`). With no matching rule, access is denied.
- Listing data is public to read. Only the scraper and admins can write it.
- Visitor tables (watchlist, notes, ratings, household, destinations) are visible only to the visitor who created them.
- Admins are listed in the `admins` table, which can only be changed from the Supabase dashboard.
- Store only what the tool needs. For example, a commute destination can be an approximate point.

## Website

- No login is needed to browse or keep a watchlist. Each visitor gets a Supabase anonymous session in the background, so their saved items stay private to them.
- Turn on rate limiting for anonymous sign-ins (Supabase Auth settings) and consider a CAPTCHA, so bots can't create sessions in bulk.
- Admin pages (label review, scraper health) require a real sign-in with a magic link or passkey, plus a row in `admins`.
- HTTPS is provided by the host.
- The domain registrar account has 2FA and registrar lock turned on.

## Scraper

- Text and images scraped from building sites are untrusted. Escape all text before showing it on a page, and never insert scraped HTML directly.
- Be polite: check at most a few times a day, identify the scraper with a clear user agent, and respect robots.txt.
- Scraper runs log to `scrape_runs`, so a site change shows up as a failed run instead of silence.
