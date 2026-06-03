# CLAUDE.md — Whitestone Dealer Portal (repo)

**Last updated:** 2026-06-03

Longer session handoff and sprint notes may also live at `~/Desktop/CLAUDE.md` on Ben's Mac.

---

## Known issues (cleanup / hardening)

1. _(add other tracked items here as cleanup sections land)_

2. **[RESOLVED]** `api/stripe-webhook.js` key selection. Previously documented as preferring the anon key with a hardcoded JWT fallback. Current code requires `SUPABASE_SERVICE_KEY` (the env var that actually exists in Vercel — note: `SERVICE_KEY`, not `SERVICE_ROLE_KEY`), uses it as the only key, and fails loud (HTTP 500) if missing. No hardcoded key remains. No `SUPABASE_ANON_KEY` fallback in key selection. Verified 2026-06-03.

---

## Critical env / gotchas

- **Env var is `SUPABASE_SERVICE_KEY`** — not `SUPABASE_SERVICE_ROLE_KEY`.
- Stripe webhook (`api/stripe-webhook.js`) must use the service role key only (privileged contract activation writes).
