# CLAUDE.md — Whitestone Dealer Portal (repo)

**Last updated:** 2026-06-03

Longer session handoff and sprint notes may also live at `~/Desktop/CLAUDE.md` on Ben's Mac.

---

## Known issues (cleanup / hardening)

**Audited 2026-06-03 against live code.** Several items below were found already-fixed and are marked RESOLVED. The pricing-UI duplication (#13) and `dealers.password` write remain. A possible `dealer_pricing` dropped-but-referenced issue is under investigation — see master to-do.

1. **[PARTIAL 2026-06-03]** paySelectedCard blind ok-only (was #1). paySelectedCard now parses the charge response, checks `chargeJson.success`, and uses `paymentMethodType`. Activation is still client-driven (intentional for ACH-processing + webhook convergence). No longer the "marks paid on HTTP 200 alone" bug originally documented.

2. **[RESOLVED 2026-06-03]** Webhook key (was #2). Webhook now uses `process.env.SUPABASE_SERVICE_KEY` only, fails loud (500) if missing, no anon fallback, no hardcoded JWT. Real env var is `SUPABASE_SERVICE_KEY` (NOT `SERVICE_ROLE_KEY`). Verified by audit.

3. **[RESOLVED]** send-email.js no auth (was #3). send-email.js now requires an Authorization header and verifies via Supabase `/auth/v1/user` before sending. Verified by audit 2026-06-03.

4. **[RESOLVED]** charge-enrollment.js + create-stripe-customer.js no auth (was #4). Both now require a Bearer JWT, verify the user via Supabase, and check the Stripe customer belongs to the calling dealer (or admin). Verified by audit 2026-06-03.

5. **[RESOLVED]** generate-enrollment-pdf.py no auth (was #4 sub). Now calls `_verify_caller_owns_contract` with 401/403 paths before generating. Verified by audit 2026-06-03.

6. _(add other tracked items here as cleanup sections land)_

10. **[CORRECTED 2026-06-03]** Reimbursement hardcoded $150 (was #10). Ticket APPROVAL uses `requested_amount`, not a hardcoded 150. Remaining 150s are pricing-model defaults + display fallbacks, not the payout amount.

13–15. **[RESOLVED 2026-06-03, Section B]** Dead code: legacy enroll-btn + LEGACY_UNUSED + orphaned add-dealer handler (parts of #13/#14/#15). Legacy `#enroll-btn` handler and `pricingInitOnTab_LEGACY_UNUSED` removed (commit 5ba013f). Orphaned `new-username` add-dealer handler no longer present.

**Still open (not resolved by audit):**

- **#13 pricing-UI duplication** — Live admin tab is `pd-*` margin dashboard; orphaned `pricing-*` JS in `dealer-portal.js` (no matching DOM ids); `ws-*` configure-pricing JS in `index.html` references elements with no `id="ws-*"` markup in repo. Needs live check whether per-dealer pricing config still works in browser.
- **`dealers.password` write** — Approve flow still POSTs `password: tempPassword` to `dealers`; enroll flow uses `password: 'supabase-auth'`. Column may be dead in DB but client still writes it.
- **`dealer_pricing` table** — Migration `20260529120000_drop_dealer_pricing.sql` exists; JS still queries `dealer_pricing`. NEEDS LIVE CHECK (Supabase) whether table was dropped.

---

## Critical env / gotchas

- **Env var is `SUPABASE_SERVICE_KEY`** — not `SUPABASE_SERVICE_ROLE_KEY`.
- Stripe webhook (`api/stripe-webhook.js`) must use the service role key only (privileged contract activation writes).
