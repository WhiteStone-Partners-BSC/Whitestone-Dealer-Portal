# Whitestone Dealer Portal — Working Reference

This file is a grounding document for future Claude sessions working on this repo. Read it before touching code.

> **Workspace context:** the public marketing site lives in a separate GitHub repo, `WhiteStone-Partners-BSC/whitestone-partners` (deployed at `whitestone-partners.com`). It is NOT a sibling folder on disk — do not assume relative paths to it work. Anything authenticated, transactional, or data-bearing belongs in THIS repo. The marketing repo is static HTML only, no backend, no Supabase client.

---

## 1. What this repo is

The dealer portal for **Whitestone Partners LLC**, a marine prepaid-maintenance program. Enrolled boat dealers log in here to enroll boat owners into prepaid annual service contracts, submit service tickets for reimbursement, and manage a "billing cart" of contracts owed to Whitestone. Whitestone admins use the same app (with `is_admin=true`) to review tickets, approve/decline dealer applications, configure per-dealer pricing, process cancellations, and run the network. Live deployment: `whitestone-dealer-portal.vercel.app`. The public marketing site lives in the separate `WhiteStone-Partners-BSC/whitestone-partners` GitHub repo — do not put marketing-site logic here.

## 2. Stack

- **Frontend:** vanilla JavaScript (no framework), HTML, CSS. No build step. No bundler. Loaded straight from `assets/`.
- **Hosting:** Vercel.
- **Serverless functions:** Vercel Functions in `/api/` (Node.js for `.js`, Python for `.py`).
- **Database + auth:** Supabase (Postgres + Auth + RLS). Project ref: `ypuohmiynnmbnlqfctlg`.
- **Payments:** Stripe (**LIVE MODE** — `pk_live_...` is hardcoded in [index.html:2141](index.html); real money flows through this code).
- **Email:** Resend (`RESEND_API_KEY` env var).
- **Forms (marketing site only, not here):** Formspree. A `FORMSPREE_CONTACT` URL is also hardcoded in [assets/js/dealer-portal.js:8](assets/js/dealer-portal.js) and used for the dealer support contact form and the welcome-message send during admin approval.
- **Charts:** Chart.js (CDN, loaded from [index.html:1493](index.html)).
- **Supabase JS SDK:** `@supabase/supabase-js@2` listed in [package.json](package.json) and loaded via CDN at [index.html:22](index.html).

## 3. File map (the critical one)

The application's JavaScript is split between **two large files** that future sessions must grep individually:

- **[`index.html`](index.html) (3,772 lines)** — HTML shell PLUS several inline `<script>` blocks. Contains:
  - The login screen, dealer sidebar, all dealer-facing tab panels (dashboard, customers, ticket, history, enroll, billing-cart, faq, resources, support), the admin sidebar and admin panels (dashboard, dealers, customers, claims, cancellations, billing, financials, pricing, messages, settings), and several modals (cancel contract, cancellation request, dealer detail, add dealer, pricing confirm/unlock, settings, Stripe setup).
  - **Inline scripts** (lines 1495–3573) define a large set of admin and enrollment functions including `loadAdminBilling`, `sendOverdueReminder`, `adminLoadDealerTable`, `renderDealers`, `renderApplications`, `openDealerPanel`, `deactivateDealer`, `approveApplication`, `submitAddDealer`, `wsPricingLoadDealers`, `wsBuildServiceTable`, `wsRender`, `wsLoadDealerPricing`, `dealerLoadRateCard`, `loadDealerPricingForEnrollment`, `selectContractLength`, `showEnrollConfirmModal`, `showEnrollSuccess`, `downloadEnrollmentForm`, `refreshBillingCartBadge`, `loadBillingCart`, `toggleSelectAll`, `updateCartSelection`, `cancelCartItem`, **`paySelectedCard`** (the broken cart payment flow — see Section 8), `chargeEnrollmentCardOnFile`, `chargeEnrollmentNow`, `enrollAnotherCustomer`, `checkDealerPaymentMethod`, `showStripeSetupBanner`, `showStripeSetupModal`. When grepping for any of these, look HERE.

- **[`assets/js/dealer-portal.js`](assets/js/dealer-portal.js) (6,992 lines)** — the bulk of the application. Contains:
  - Hardcoded Supabase URL/anon key, `authHeaders()`, the auth flow (`doLogin`, `onLoginSuccess`, `doLogout`, `supabase.auth.onAuthStateChange` PASSWORD_RECOVERY handler at line 4515), `fetchDealerByAuthId`, `buildDealerSession`, `createDetachedSupabaseClient`.
  - Email helpers (`sendResendEmail`, `sendOverdueNotificationEmail`), the overdue banner check (`checkOverdueBanners`).
  - Reimbursement history (`loadReimbursementHistory`, `loadDealerChargebacks`), messages admin (`adminLoadMessages`, `messagesRender`, `messagesUpdateStatus`, `messagesSaveNote`).
  - HIN logic (`normalizeHin`, `verifyHINForEnrollment`, `verifyHINForTicket`, `logHINConflict`, `loadAdminHinConflicts`).
  - Audit log writer (`writeAuditLog`).
  - Cancellations (`openCancellationModal`, `submitCancellationRequest`, `loadCancellations`, `approveCancellation`, `denyCancellation`, `addCancellationNote`, `markChargebackApplied`, plus the admin-only `openCancelModal` / `confirmCancelContract` immediate-cancel path).
  - Customer cards / contract rendering (`buildCustomerCardsHtml`, `renderAdminMasterTable`, `renderAdminContractRows`, `toggleCustomerHistory`, `adminExpandCustomer`).
  - Renewal pipeline (`renewalSetFilter`, `renewalPipelineRender`, `adminLoadRenewalPipeline`).
  - Onboarding checklist (`loadOnboardingChecklist`, `onboardingMarkStep`, `onboardingMarkComplete`, `checkOnboardingStatus`).
  - Pricing model (the SECOND, more complete pricing UI: `pricingLoadFromSupabase`, `pricingLoadDealers`, `pricingLoadDealerRates`, `pricingRenderServicesTable`, `pricingRenderProfitChart`, `pricingUpdateAll`, `pricingInitOnTab`, `generateDealerContractPDF`, `downloadCustomerContract`).
  - Admin dashboard / leaderboard / financials (`adminLoadDashboard`, `adminRefreshNetworkCaches`, `adminRenderStats`, `adminRenderChart`, `adminRenderLeaderboard`, `adminRenderFlags`, `adminRenderRenewalsNetwork`, `adminRenderFinancialHealth`, `financialsLoad`, `financialsShowSection`).
  - Dealer dashboard (`loadDashboard`, `updateDashboardStats`, `renderRenewalsUI`, `loadCustomersTab`).
  - Tab routing (`switchTab`, `adminShowPanel`).
  - **Service ticket submission** (the click handler bound to `#ticket-btn` at line 5791) and a legacy `#enroll-btn` path at line 5929 (likely dead code — the active enrollment path is the modal in `index.html`).
  - Past-tickets list (`loadTickets`).
  - Claims admin (`claimsApprove`, `rejectTicket`, `claimsMarkDealerPaid`, `claimsLoadPending`, `claimsLoadUnpaid`, `claimsLoadHistory`, `claimsLoadTab`).
  - Applications admin (`applicationsLoadPanel`, `applicationsDoApprove`, `applicationsDoDecline`).
  - Support form, contact form, and an admin "add dealer" handler at line 6939 that targets DOM IDs (`new-username`, `new-password`, `new-name`, `add-ok`, `add-err`) which **do not appear in `index.html`** — this is dead/orphaned code distinct from the live "Add Dealer Modal" (`add-dealer-modal` / `submitAddDealer`) defined inline in `index.html`.

  When grepping for `loadBillingCart`, `paySelectedCard`, `chargeEnrollmentNow`, `showEnrollConfirmModal`, `wsRender`, `loadAdminBilling`, `submitAddDealer`, `approveApplication`, `openDealerPanel`, look in **`index.html`**. When grepping for `loadDashboard`, `loadCustomersTab`, `loadTickets`, `writeAuditLog`, `verifyHINForTicket`, `loadCancellations`, `claimsLoadPending`, `applicationsLoadPanel`, `pricingInitOnTab`, `generateDealerContractPDF`, `doLogin`, `onLoginSuccess`, look in **`assets/js/dealer-portal.js`**.

  **Future sessions must grep BOTH files.** Do not assume a function is in one file or the other.

- **[`assets/css/dealer-portal.css`](assets/css/dealer-portal.css) (694 lines)** — single stylesheet. CSS variables (navy/gold palette) at top.
- **[`assets/documents/whitestone-partners-dealer-rate-sheet.pdf`](assets/documents/whitestone-partners-dealer-rate-sheet.pdf)** — universal dealer rate sheet downloaded from the Service Ticket and Resources tabs.
- **[`assets/images/logo.png`](assets/images/logo.png)** — only image asset.
- **[`public/enrollment-form-template.pdf`](public/enrollment-form-template.pdf)** + **[`public/README.md`](public/README.md)** — blank PDF template the Python function fills in.
- **[`package.json`](package.json)** — declares only `@supabase/supabase-js` (used at runtime via CDN, not bundled). No npm scripts. No dev deps.
- **[`vercel.json`](vercel.json)** — only configures `includeFiles` for the PDF function (so the template PDF ships with the deploy). No headers, no rewrites, no SPA routing.
- **[`.gitignore`](.gitignore)** — present (not read in detail).

### `/api/` — Vercel serverless functions

- **[`charge-enrollment.js`](api/charge-enrollment.js)** (Node, 74 lines) — POST. Accepts `{ stripeCustomerId, amount, dealerName, customerName, contractType, contractId }`, fetches the customer's default payment method from Stripe, creates a Stripe `payment_intent` with `confirm=true` + `off_session=true`, and embeds `metadata[contract_id]` so the webhook can map the charge back. Returns `{ success: true, paymentIntentId, amount }` on success. **No auth.**
- **[`create-stripe-customer.js`](api/create-stripe-customer.js)** (Node, 64 lines) — POST. Accepts `{ dealerName, email, paymentMethodId, dealerId }`, creates a Stripe customer, attaches the payment method, and sets it as `invoice_settings.default_payment_method`. Returns `{ success: true, customerId, paymentMethodId }`. **No auth.**
- **[`send-email.js`](api/send-email.js)** (Node, 100 lines) — POST. Sends an email via Resend. Has two server-side templates (`type=overdue_day10`, `type=overdue_day20`); otherwise the caller passes `subject` + `html`. **No auth, and `to` is freely set by the caller** (defaults to `support@whitestone-partners.com` if omitted).
- **[`stripe-webhook.js`](api/stripe-webhook.js)** (Node, 243 lines) — POST. Reads raw body, **verifies Stripe signature properly** with timing-safe equal and 5-minute timestamp tolerance. On `payment_intent.succeeded` and a present `metadata.contract_id`, PATCHes the contract to `{ status: 'active', stripe_payment_id, paid_at, ... }`, then sends a customer welcome email via Resend. **Uses `SUPABASE_ANON_KEY` first, falls back to `SUPABASE_SERVICE_ROLE_KEY`, then to a hardcoded JWT** (see Section 8 #2).
- **[`generate-enrollment-pdf.py`](api/generate-enrollment-pdf.py)** (Python, 208 lines) — POST. Accepts `{ contractId }`, fetches the contract from Supabase, fills `enrollment-form-template.pdf` using `pypdf` + `reportlab`, returns the PDF as a download. **No auth.** Uses `SUPABASE_URL` + `SUPABASE_ANON_KEY` env vars (no fallbacks; will return empty/forbidden if missing).
- **[`requirements.txt`](api/requirements.txt)** — `pypdf==4.3.1`, `reportlab==4.2.2`.
- **[`enrollment-form-template.pdf`](api/enrollment-form-template.pdf)** — the source PDF that the Python function overlays text onto.

### `/supabase/`

- **[`hin_conflicts.sql`](supabase/hin_conflicts.sql)** — creates `hin_conflicts` table, enables RLS, and originally added a fully-open policy `using (true) with check (true)`. That policy was dropped and replaced on 2026-05-10 — see Section 12.
- **[`migrations/20260504000000_cancellations.sql`](supabase/migrations/20260504000000_cancellations.sql)** — creates `cancellations` table and adds 4 columns to `contracts` (`wholesale_price`, `stripe_charge_amount`, `cancelled_at`, `cancellation_id`). **The migration itself does not enable RLS or define policies.** RLS was enabled and proper policies were added to this table out-of-band on 2026-05-10 — see Section 12. This is the only file in `supabase/migrations/`.

## 4. Domain model

Tables actually referenced by the code (verified by grepping `/rest/v1/<table>` across `index.html` and `assets/js/dealer-portal.js`):

- **`audit_log`** — append-only event log written by `writeAuditLog()` ([assets/js/dealer-portal.js:845](assets/js/dealer-portal.js)). Records `{ entity_type, entity_id, action, old_value, new_value, dealer_name, customer_name, notes, performed_by }`. Drives admin activity feed and pricing history. **No migration in this repo.**
- **`cancellations`** — dealer-initiated cancellation requests with computed estimates (customer/dealer refund split, prorated value, grace-period flag, $100 dealer fee). Schema in [`supabase/migrations/20260504000000_cancellations.sql`](supabase/migrations/20260504000000_cancellations.sql).
- **`contracts`** — the primary record of an enrolled boat. Status values seen in code: `pending_payment`, `active`, `cancellation_pending`, `cancelled`, plus implicit `expired` (derived from `end_date`). Many columns: customer info, lienholder info, boat info, dual engines, agreement_number, retail_price, wholesale_price, stripe_payment_id, paid_at, start_date, end_date, contract_type (`1yr`/`2yr`/`3yr`), payment_method (`card_on_file`/`invoice`), notes. **No migration for the base table in this repo** — only the cancellation-related ALTERs.
- **`dealer_applications`** — public dealer-recruitment form submissions (originate from the marketing site). Status: `pending`/`approved`/`declined`. Approval triggers a Supabase Auth signUp + a row in `dealers`. **No migration in this repo.**
- **`dealer_messages`** — support / contact messages from dealers. Status: `new`/`in_progress`/`resolved`. **No migration in this repo.**
- **`dealer_pricing`** — per-dealer rate card. Columns observed: `dealer_id`, `dealership_name`, `service_name`, `reimbursement_rate`, `commission_pct`, `contract_retail_1yr`, `contract_retail_2yr`, `contract_retail_3yr`, `confirmed`, `locked`, `confirmed_at`, `confirmed_by`. One row per dealer. Created on first edit if missing. **No migration in this repo.**
- **`dealers`** — the dealer / admin account roster. Columns observed: `id`, `username`, `password` (string `"supabase-auth"` is stored as a placeholder for new dealers — actual auth lives in Supabase Auth, joined via `auth_id`), `dealership_name`, `contact_first_name/last_name`, `email`, `phone`, `address`, `city`, `state`, `zip`, `website`, `boat_brands`, `service_volume`, `location`, `auth_id`, `active`, `is_admin`, `joined_at`, `stripe_customer_id`, `onboarding_completed`, `onboarding_steps`. **No migration in this repo.**
- **`hin_conflicts`** — log of attempted enrollments where a HIN was already registered to another customer. Schema in [`supabase/hin_conflicts.sql`](supabase/hin_conflicts.sql). Surfaces in the admin Customers tab.
- **`invoice_items`** — the dealer "billing cart": each unpaid contract sits as an `invoice_items` row until the dealer pays (status flips to `paid`) or cancels (deleted). Columns observed: `dealer_id`, `contract_id`, `customer_name`, `dealership_name`, `contract_type`, `retail_price`, `wholesale_price`, `dealer_profit`, `due_date`, `status` (`unpaid`/`paid`/`invoiced`/`cancelled`), `payment_method`, `paid_at`, `added_to_cart_at`, `day10_notice_sent`, `day20_notice_sent`, `hin`, boat fields. **No migration in this repo.**
- **`reimbursements`** — one row per submitted ticket. Columns: `ticket_id`, `dealer_id`, `dealership_name`, `amount` (defaults to **$150 hardcoded**, see Section 8), `status` (`pending`/`approved`/`paid`/`rejected`), `paid_date`. **No migration in this repo.**
- **`services`** — service catalog (Pricing tab Stage 1 services). Columns observed: `name`, `retail_price`, `market_avg`, `hours_interval`, `is_yearly`, `active`, `sort_order`. **No migration in this repo and no purpose statement** — this is one of two parallel pricing UIs (the other uses an in-memory `WHOLESALE_SERVICES_DEFAULT` array hardcoded at [index.html:2144](index.html)). Purpose unclear from code: the `services` table appears to back the alternative `pricingInitOnTab` flow ([assets/js/dealer-portal.js:2939](assets/js/dealer-portal.js)) but the UI elements that flow targets (`pricing-services-tbody`, `pricing-slider-commission`, etc.) are NOT present in the current `index.html` — only the `ws-...`-prefixed Stage 1 elements are.
- **`tickets`** — service tickets submitted by dealers. Columns: `ticket_number`, `dealer_id`, `dealership_name`, `technician`, customer fields, boat fields, `hin`, `engine_hours`, `service_type` (comma-separated), `service_date`, `service_notes`, `status` (`pending`/`approved`/`rejected`), `rejection_reason`, `reimbursement_amount`. **No migration in this repo.**

### Domain glossary

- **Dealer** — a marine dealership account that logs into the portal. One `dealers` row per dealership today; technicians are represented only as a free-text name on each ticket. Identified by `id`, joined to Supabase Auth by `auth_id`. `is_admin=true` flips the same login into the Whitestone admin portal.
- **Customer** — the boat owner who buys a contract. Stored as columns on `contracts` (no separate `customers` table observed).
- **Contract** — one prepaid maintenance agreement for one boat, owned by one dealer. Has a term (`1yr`/`2yr`/`3yr`), a retail price (what the dealer charged the customer), and a wholesale price (what the dealer owes Whitestone). Status drives what dealers can do (e.g., no tickets allowed against `cancelled` or `cancellation_pending` contracts).
- **HIN (Hull Identification Number)** — the unique key for a boat. Normalized to uppercase (`normalizeHin`). Required on every enrollment and every ticket. A boat may not have two `active` contracts at once — attempts log to `hin_conflicts`.
- **Service Ticket** — a dealer's claim for work performed against an active contract. Posted directly to `/rest/v1/tickets` from the client (no API endpoint), reviewed by an admin in the Claims tab, then paid via the `reimbursements` table.
- **Reimbursement** — a row in `reimbursements` representing money owed (or paid) to a dealer for an approved ticket. Currently flat $150 per ticket regardless of service or rate sheet.
- **Rate Sheet / Dealer Pricing** — per-dealer pricing for the three contract terms (`contract_retail_1yr/2yr/3yr`), a `commission_pct`, and a `reimbursement_rate`. Stored in `dealer_pricing`. Set via the admin Pricing tab. Must be `confirmed` before a dealer can enroll customers (the enrollment UI gates on this).
- **Cart / Invoice Item** — when a dealer enrolls a customer with the "Add to Cart" path, a `contracts` row is created with status `pending_payment` AND an `invoice_items` row is created with status `unpaid` and a 10-day due date. The dealer later pays via "Charge Card on File" (`paySelectedCard` — broken, see Section 8) or by enrolling-and-paying-immediately (`chargeEnrollmentNow`, which routes through `/api/charge-enrollment` and the webhook).
- **Enrollment** — the act of signing a customer up for a contract. Two flows from the same modal: (a) "Add to Cart" → contract `pending_payment` + invoice item `unpaid`, paid later in batch; (b) "Pay Now" → contract created, then `/api/charge-enrollment` charges the dealer's card on file, then the client PATCHes the contract to `active`. The webhook also activates contracts that arrive with a `contract_id` in their PaymentIntent metadata.

## 5. Critical invariants (must never be violated)

These are non-negotiable rules for any future change:

- **Stripe is the source of truth for payment status.** The client must never mark a contract or invoice item as `paid` based on its own knowledge. Status changes to `paid` or `active` may only happen server-side, after the server has confirmed with Stripe that the charge succeeded. (The current `paySelectedCard` flow violates this — see Section 8.)
- **HIN uniqueness across active contracts.** A boat (identified by HIN) may not have two active contracts simultaneously. The `hin_conflicts` table exists to surface attempted violations.
- **Dealer data isolation via RLS.** Dealer A must never read or write dealer B's contracts, customers, tickets, or pricing. Row Level Security on Supabase tables enforces this. Any new table must have RLS enabled and dealer-isolated policies. (As of 2026-05-10, RLS lockdown has been applied to all tables — see Section 12 Change Log.)
- **Service role key never exposed to the client.** The `SUPABASE_SERVICE_ROLE_KEY` may only appear in Vercel Functions, never in `index.html` or `assets/js/`. The anon key is what the browser uses.
- **No hardcoded credentials in source.** All secrets come from environment variables. If a fallback is needed for local development, the fallback must fail loud (throw an error), not silently use a baked-in value. (`stripe-webhook.js` violates this — see Section 8.)
- **API endpoints in `/api/` must authenticate the caller.** Currently NOT enforced (see Section 8). Any new endpoint must require a valid Supabase JWT and verify the calling dealer's identity before performing actions on their behalf.

## 6. Key flows (with file:line references)

### Enrollment — "Pay Now" path (single contract, charges card on file)

1. Dealer fills the multi-section enrollment form ([index.html:309–432](index.html)) and clicks **REVIEW ENROLLMENT** ([index.html:429](index.html)).
2. `showEnrollConfirmModal` ([index.html:2464](index.html)) validates required fields, runs `verifyHINForEnrollment` ([assets/js/dealer-portal.js:750](assets/js/dealer-portal.js)) — which checks `contracts` for any same-HIN active contract and writes a `hin_conflicts` row if a different customer is found. Confirms pricing is `confirmed` for this dealer.
3. Modal opens; dealer clicks **Pay Now — Charge card on file** ([index.html:592](index.html)). `chargeEnrollmentNow` runs ([index.html:3419](index.html)).
4. Generates an agreement number via Supabase RPC `generate_agreement_number` ([index.html:3475](index.html)).
5. POSTs the full contract payload to `/rest/v1/contracts` with `status: 'pending_payment'`, `payment_method: 'card_on_file'` ([index.html:3529](index.html)).
6. Calls `chargeEnrollmentCardOnFile` ([index.html:3053](index.html)), which fetches the dealer's `stripe_customer_id` if not cached, then POSTs to `/api/charge-enrollment` ([index.html:3064](index.html)) with `contractId` set.
7. `api/charge-enrollment.js` looks up the customer's default payment method, creates a confirmed off-session PaymentIntent with `metadata[contract_id]`, and returns `{ success: true, paymentIntentId, amount }` on success.
8. **Client** then PATCHes the contract to `status: 'active', stripe_payment_id, paid_at, wholesale_price, stripe_charge_amount` ([index.html:3544](index.html)). (Reasonable: the API returned a confirmed Stripe success.)
9. **Webhook** also fires asynchronously: `api/stripe-webhook.js:64–95` re-PATCHes the contract on `payment_intent.succeeded`. Idempotent — both paths converge to the same state.
10. Webhook then sends a customer welcome email via Resend ([api/stripe-webhook.js:111–235](api/stripe-webhook.js)). PDF is NOT generated automatically — the dealer must click "Download Enrollment Form" on the success screen, which calls `/api/generate-enrollment-pdf`.
11. Audit log written via `writeAuditLog('contract', ..., 'customer_enrolled', ...)`.

### Enrollment — "Add to Cart" path

1. Same form/modal as above, dealer clicks **Add to Cart — Pay within 10 days** ([index.html:588](index.html)). Handler at [index.html:2614–2752](index.html).
2. Creates a `contracts` row with `status: 'pending_payment', payment_method: 'invoice'` ([index.html:2721](index.html)).
3. Creates an `invoice_items` row with `status: 'unpaid'` and a 10-day `due_date` ([index.html:2741](index.html)).
4. **No Stripe charge yet.** Dealer pays later in the Billing Cart tab (see next flow).

### Cart payment flow — `paySelectedCard` ⚠ BROKEN

This flow is broken. See Section 8 #1.

1. Dealer opens Billing Cart, selects unpaid invoice items via checkboxes, clicks **Charge Card on File**.
2. `paySelectedCard` ([index.html:2990](index.html)) sums selected wholesale prices, POSTs to `/api/charge-enrollment` with **`contractId: null`** ([index.html:3016](index.html)) because there are multiple contracts.
3. **Only checks `chargeRes.ok`** ([index.html:3019](index.html)) — does not even read the JSON body. Throws on non-200 only.
4. Client-side loop ([index.html:3021–3036](index.html)) PATCHes every selected `invoice_items` row to `status: 'paid'` and every related `contracts` row to `status: 'active'`. The dealer now has activated contracts based purely on a 200 response from a single API call.
5. Webhook fires for the single charge — but it has no `contract_id` in metadata, so the webhook's contract-update branch ([api/stripe-webhook.js:68](api/stripe-webhook.js)) is skipped. The webhook returns `{received: true}` and does nothing with the data.

### Service ticket flow

1. Dealer enters HIN; on blur `updateTicketContractIndicator` ([assets/js/dealer-portal.js:5738](assets/js/dealer-portal.js)) calls `verifyHINForTicket` to confirm there's an active contract.
2. Dealer fills form, clicks **Submit Service Ticket**. Handler at [assets/js/dealer-portal.js:5791](assets/js/dealer-portal.js).
3. Re-runs `verifyHINForTicket` server-side check.
4. POSTs to `/rest/v1/tickets` with `status: 'pending', reimbursement_amount: 150` (hardcoded — see Section 8 #10).
5. POSTs to `/rest/v1/reimbursements` with the same hardcoded `amount: 150` and `status: 'pending'`.
6. Writes an `audit_log` row, sends an admin notification email via Resend.
7. Admin review: in the Claims tab, `claimsLoadPending` ([assets/js/dealer-portal.js:6146](assets/js/dealer-portal.js)) lists pending tickets. `claimsApprove` ([assets/js/dealer-portal.js:6065](assets/js/dealer-portal.js)) flips ticket status to `approved`. `rejectTicket` ([assets/js/dealer-portal.js:6081](assets/js/dealer-portal.js)) prompts for a reason and flips both the ticket and the reimbursement to `rejected`.
8. Reimbursement payout: `claimsMarkDealerPaid` ([assets/js/dealer-portal.js:6119](assets/js/dealer-portal.js)) batches all `pending` reimbursements for an approved ticket for one dealership and PATCHes them to `paid` with today's `paid_date`. **No actual money movement** — this is a bookkeeping operation; payment to the dealer happens out-of-band.

### Auth flow

1. Login: `doLogin` ([assets/js/dealer-portal.js:4946](assets/js/dealer-portal.js)) calls `supabase.auth.signInWithPassword({ email, password })`. On success, stores `session.access_token` in `window.authToken`.
2. `fetchDealerByAuthId` ([assets/js/dealer-portal.js:174](assets/js/dealer-portal.js)) joins the auth user to a `dealers` row by `auth_id` (and requires `active=true`). If no row, the user is signed out.
3. `buildDealerSession` ([assets/js/dealer-portal.js:160](assets/js/dealer-portal.js)) constructs `currentDealer` with `isAdmin: dealer.is_admin === true`.
4. `onLoginSuccess` ([assets/js/dealer-portal.js:4467](assets/js/dealer-portal.js)) flips the UI between dealer and admin layouts based on `isAdmin`.
5. All Supabase REST calls go through `authHeaders()` ([assets/js/dealer-portal.js:37](assets/js/dealer-portal.js)) which sets `apikey: <anon key>` and `Authorization: Bearer <JWT or anon>`. **If `window.authToken` is unset, falls back to the anon key**, meaning RLS uses an unauthenticated anon role for that request.
6. Session restore on page load: [assets/js/dealer-portal.js:5038](assets/js/dealer-portal.js) calls `supabase.auth.getSession()` and re-hydrates `currentDealer` from `auth_id`.
7. Logout: `doLogout` ([assets/js/dealer-portal.js:5238](assets/js/dealer-portal.js)) calls `supabase.auth.signOut()` and clears local state.
8. Password reset request: `#reset-btn` handler ([assets/js/dealer-portal.js:4543](assets/js/dealer-portal.js)) calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: 'https://whitestone-dealer-portal.vercel.app' })` — Supabase emails the link.
9. Password recovery completion: `supabase.auth.onAuthStateChange` listens for `PASSWORD_RECOVERY` events ([assets/js/dealer-portal.js:4514](assets/js/dealer-portal.js)) and uses a browser `prompt()` to capture the new password (see Section 8 #9).

## 7. Environment variables (Vercel)

Based on what the code references:

- **`STRIPE_SECRET_KEY`** — required by [`api/charge-enrollment.js:6`](api/charge-enrollment.js) and [`api/create-stripe-customer.js:6`](api/create-stripe-customer.js). Both fail with HTTP 500 if missing.
- **`STRIPE_WEBHOOK_SECRET`** — required by [`api/stripe-webhook.js:44`](api/stripe-webhook.js). Fails with HTTP 500 if missing.
- **`SUPABASE_URL`** — referenced by [`api/stripe-webhook.js:69`](api/stripe-webhook.js) (with hardcoded fallback to the project URL) and [`api/generate-enrollment-pdf.py:21`](api/generate-enrollment-pdf.py) (no fallback).
- **`SUPABASE_ANON_KEY`** — referenced by [`api/stripe-webhook.js:70`](api/stripe-webhook.js) (with hardcoded fallback) and [`api/generate-enrollment-pdf.py:22`](api/generate-enrollment-pdf.py).
- **`SUPABASE_SERVICE_ROLE_KEY`** — referenced **only** by [`api/stripe-webhook.js:70`](api/stripe-webhook.js), and only as the **second** choice after `SUPABASE_ANON_KEY`. Should be the FIRST choice. See Section 8 #2.
- **`RESEND_API_KEY`** — required by [`api/send-email.js:6`](api/send-email.js) and used optionally by [`api/stripe-webhook.js:220`](api/stripe-webhook.js) (silently skipped if missing — the welcome email won't send).

There is **no `.env.example`** in the repo. Recommend adding one in a future session.

## 8. Known issues (verified against this codebase)

Numbered issues, each verified against actual file contents.

1. **`paySelectedCard` cart-payment flow is broken.** [index.html:2990–3044](index.html). After POSTing to `/api/charge-enrollment`, the only verification is `if (!chargeRes.ok) throw` ([line 3019](index.html)) — the JSON body is never parsed and the `success` field is never checked. The client then loops over selected items and PATCHes each `invoice_items` row to `status: 'paid'` and each related contract to `status: 'active'` based purely on the HTTP-200 check. Additionally, **`contractId` is passed as `null`** ([line 3016](index.html)) for batch charges, so the Stripe webhook ([api/stripe-webhook.js:66](api/stripe-webhook.js)) cannot map the charge back to any contract — its update branch is skipped entirely. **Verified.** Fix direction: server-side endpoint that takes a list of invoice item IDs, charges Stripe, persists status changes server-side after Stripe confirmation (or relies entirely on the webhook with proper metadata), and returns the new statuses to the client.

2. **`api/stripe-webhook.js` prefers `SUPABASE_ANON_KEY` over `SUPABASE_SERVICE_ROLE_KEY` and falls back to a hardcoded JWT.** [api/stripe-webhook.js:70–73](api/stripe-webhook.js):
   ```js
   var supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
   if (!supabaseKey) {
     supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'; // hardcoded anon JWT
   }
   ```
   The webhook needs `service_role` to PATCH a contract that RLS would otherwise gate. Using the anon key here means **the webhook only succeeds if RLS on `contracts` is open enough for anon to UPDATE** — which is itself a problem. The hardcoded JWT is the same anon key embedded in the client, so technically not a new credential leak (anon keys are designed to be public), but it silently masks misconfiguration. **Verified both lines.** Fix direction: require `SUPABASE_SERVICE_ROLE_KEY` outright, no fallback.

3. **`api/send-email.js` has no auth check; `to` is freely set by the caller.** [api/send-email.js:1–99](api/send-email.js). Any unauthenticated POST can send arbitrary HTML emails from `support@whitestone-partners.com` to any address. **Verified.** Fix direction: require a Supabase JWT, restrict `to` to either the calling dealer's own email or an admin-allowlisted set, and rate-limit.

4. **`api/charge-enrollment.js` and `api/create-stripe-customer.js` have no auth check.** [api/charge-enrollment.js:1–74](api/charge-enrollment.js), [api/create-stripe-customer.js:1–64](api/create-stripe-customer.js). Anyone who knows a Stripe `stripeCustomerId` can charge that customer arbitrary amounts. **Verified.** Fix direction: require a Supabase JWT, look up the calling dealer, and verify that `stripeCustomerId` belongs to them (i.e., matches `dealers.stripe_customer_id`).

   I'd also add: **`api/generate-enrollment-pdf.py` has no auth check**. Anyone who knows a `contractId` UUID can download a PDF with the customer's name, address, email, phone, HIN, and engine info. **Verified** (no auth code in the function). Fix direction: require a Supabase JWT and verify the contract belongs to the calling dealer (or admin).

5. **[RESOLVED 2026-05-10]** **`hin_conflicts` table has a fully open RLS policy.** [supabase/hin_conflicts.sql:17](supabase/hin_conflicts.sql):
   ```sql
   create policy "allow all hin_conflicts" on hin_conflicts for all using (true) with check (true);
   ```
   RLS is enabled but the policy lets any anon/authenticated user select, insert, update, delete. **Verified.** Other tables may have similar open policies — **cannot be verified from migration files alone** because most tables have no migration in this repo (see Section 9). Fix direction: scope the policy — admins read all, dealers insert their own and read those they raised.

6. **[RESOLVED 2026-05-10]** **The `cancellations` migration does not enable RLS or define policies.** [supabase/migrations/20260504000000_cancellations.sql](supabase/migrations/20260504000000_cancellations.sql). The file has no `alter table ... enable row level security;` and no `create policy ...`. **Verified.** If the table was created from this file in production, dealers can read every dealer's cancellation requests (which contain customer names, refund amounts, dealer margin). Fix direction: new migration that enables RLS and adds dealer-isolation policies.

7. **`index.html` `<head>` has no security or indexing meta tags.** [index.html:1–24](index.html). Present:
   - `<meta charset="UTF-8">`
   - `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
   - `<title>...`
   - Two `<link rel="stylesheet">`
   - Two `<script src=...>` (Supabase, Stripe.js)

   **Absent:** `noindex`/robots, `Content-Security-Policy`, `X-Frame-Options` (or `frame-ancestors` CSP), `Referrer-Policy`, `Permissions-Policy`. **Verified by grep.** Fix direction: at minimum add `<meta name="robots" content="noindex,nofollow">` for a dealer-only app, and configure security response headers via `vercel.json`.

8. **`vercel.json` only configures the PDF function — no security headers, no SPA rewrites, no `noindex` headers.** [vercel.json:1–7](vercel.json). The entire file is just `{"functions": {"api/generate-enrollment-pdf.py": {"includeFiles": "public/enrollment-form-template.pdf"}}}`. **Verified.** Fix direction: add a `headers` block to set CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`.

9. **Password recovery uses `prompt()`.** [assets/js/dealer-portal.js:4515](assets/js/dealer-portal.js):
   ```js
   if (event === "PASSWORD_RECOVERY") {
     var newPassword = prompt("Enter your new password (minimum 8 characters):");
   ```
   The native browser `prompt()` is used to capture the new password during a Supabase password-recovery flow. The input shows in plaintext, can't be confirmed, isn't styled, and may be stripped by some browsers. **Verified.** Fix direction: replace with a styled in-page form with confirmation field and submit button, using `supabase.auth.updateUser({ password })`.

### Additional issues found while reading

10. **Reimbursement amount is hardcoded at $150 client-side.** [assets/js/dealer-portal.js:5827](assets/js/dealer-portal.js) and [:5845](assets/js/dealer-portal.js): the ticket POST and reimbursement POST both set `reimbursement_amount: 150` / `amount: 150` regardless of what service was performed and regardless of the dealer's `dealer_pricing.reimbursement_rate`. The pricing tab and the dealer rate sheet PDF both prominently display per-service rates, but those rates are not consulted when the actual reimbursement row is created. The Section 4 admin Activity feed and stat cards also assume `$150 avg per ticket` ([assets/js/dealer-portal.js:34, 5132](assets/js/dealer-portal.js)). Either intentional simplification or an unfinished feature — flag for product owner before changing.

11. **Hardcoded Supabase URL + anon key in client.** [assets/js/dealer-portal.js:6–7](assets/js/dealer-portal.js). Anon keys are designed to be public, so this is technically safe, but it means there is no way to point this build at a staging Supabase project without editing source. Combined with the same hardcoded fallback in `stripe-webhook.js:72`, the project ref `ypuohmiynnmbnlqfctlg` is baked into the codebase. Fix direction: read from Vite/build env or inject at deploy time.

12. **Stripe LIVE publishable key hardcoded in HTML.** [index.html:2141](index.html): `Stripe('pk_live_51TGqa7...')`. Publishable keys are public by design — this is not a credential leak — but the hardcoding is worth noting because there's no way to swap to a `pk_test_` key for staging. Fix direction: same as #11.

13. **Two parallel pricing UIs / two price tables / two service catalogs.** The repo defines pricing twice:
    - The active "Wholesale Pricing" UI (`ws-...` IDs in `index.html`, `wsRender`, `wsLoadDealerPricing` defined inline in `index.html`), which uses an in-memory `WHOLESALE_SERVICES_DEFAULT` array at [index.html:2144](index.html).
    - A second "Pricing Model" UI (`pricing-services-tbody`, `pricing-slider-commission`, etc.) backed by the `services` Supabase table, with `pricingInitOnTab` / `pricingRenderServicesTable` / `pricingRenderProfitChart` in `dealer-portal.js`.
    The second UI's DOM elements are not present in the current `index.html`; the code path appears dormant. **Default contract prices also disagree:** the cart "Add to Cart" handler hardcodes `wholesale: 1yr=3325/2yr=6650/3yr=9975` ([index.html:2620](index.html)), while `pricingDefaultRates()` uses `1yr=3699/2yr=6798/3yr=9297` ([assets/js/dealer-portal.js:2268–2270](assets/js/dealer-portal.js)). Fix direction: pick one, delete the other, and have the cart pull live wholesale from `dealer_pricing` like the enrollment modal does.

14. **Orphaned admin "add dealer" handler in `dealer-portal.js`.** [assets/js/dealer-portal.js:6939–6991](assets/js/dealer-portal.js) binds a click handler on `#add-dealer-btn` that reads `#new-username`, `#new-password`, `#new-name`, `#add-ok`, `#add-err` — **none of which exist in `index.html`**. The current "Add Dealer" UI is the modal at [index.html:1437–1491](index.html) with handler `submitAddDealer` defined in the inline script. Likely dead code. The two handlers will both fire on `#add-dealer-btn` clicks (the inline one opens the modal; the dealer-portal.js one tries to read the missing fields and silently fails), but the inline binding [index.html:2123](index.html) replaces the button with `cloneNode` to detach previous listeners — so the dealer-portal.js handler gets bound to a now-orphaned node. Fix direction: delete the dead handler.

15. **Legacy enrollment "Generate Payment Link" button.** [assets/js/dealer-portal.js:5928–6019](assets/js/dealer-portal.js). Bound to `#enroll-btn`, which is also not present in the current `index.html`. Creates a contract with hardcoded `retail_price: 3699`, `contract_type: '1yr'`, `status: 'active'` directly without any payment, then shows a "payment link" UI. Likely dead code from an earlier design. Fix direction: delete.

16. **Tickets table is written directly from the client, not via an API.** [assets/js/dealer-portal.js:5830](assets/js/dealer-portal.js). This is consistent with the rest of the app (almost everything writes directly via Supabase REST + RLS), so it's only a problem if RLS isn't enforced — but it means a malicious dealer could submit tickets with arbitrary `dealer_id`/`dealership_name` if RLS doesn't pin those to the auth user. Cannot be verified from these files alone. See Section 9.

17. **`authHeaders()` silently falls back to the anon key when `window.authToken` is null.** [assets/js/dealer-portal.js:37–46](assets/js/dealer-portal.js). After logout (or on stale sessions), any subsequent fetch will go out as anon. Depending on RLS, this could either error cleanly or silently expose data the anon role can read.

    > **Note (2026-05-10):** With RLS lockdown now applied, the anon role has no useful read/write access to dealer-owned tables — so the silent fallback now produces empty results or RLS errors instead of leaking data. The fallback is still a code smell and should be fixed in a later session (Session 5 — JWT auth on public endpoints will overlap with this).

18. **`generateTempPassword()` produces an 8-character password from a 32-char alphabet** ([assets/js/dealer-portal.js:647–654](assets/js/dealer-portal.js)) — `WSP-` prefix + 6 random alphanumerics. ~30 bits of entropy. Used during dealer approval and "Add Dealer" flow as the initial Supabase Auth password. Sent to the dealer via Formspree email (welcome message at [assets/js/dealer-portal.js:6406–6427](assets/js/dealer-portal.js)). Reasonable for a temp password the dealer will reset, but worth flagging.

## 9. Known Unknowns

Things that cannot be determined from these files alone. Each must be checked against the live Supabase database in a future session.

- ~~RLS status of each of the 12 tables in production.~~ **RESOLVED 2026-05-10.** Live audit completed via SQL query; all 13 tables (public schema) had RLS enabled with a single permissive "allow all" policy and direct anon-role grants. All 13 are now locked down with per-table dealer-isolated policies plus admin override. See Section 12.
- **Whether the hardcoded anon-key fallback in the webhook is currently in use.** Depends on Vercel env config for `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`. Check Vercel project settings.
- **What the `services` table actually contains in production**, given that the UI which writes to it is dormant. Check `select count(*), min(sort_order), max(sort_order) from public.services;`.
- **Whether `dealer_applications`, `dealer_messages`, `audit_log`, `dealer_pricing`, `invoice_items`, `reimbursements`, `tickets`, `contracts`, `dealers`, `services` were created via SQL editor or some out-of-repo migration.** Their schemas have to be reverse-engineered from code references — column names listed in Section 4 are best-guesses based on what the JS sends. Inspect actual schemas with `\d+ public.<table>` in psql or via the Supabase dashboard.
- **Whether the Supabase RPC `generate_agreement_number(p_dealer_id uuid)` exists.** Called at [index.html:2667](index.html) and [index.html:3475](index.html). Code tolerates failure (just leaves `agreement_number` blank).
- **What columns `chargeback_applied`, `chargeback_applied_at`, `chargeback_notes`, `total_chargeback_amount` look like on `cancellations`.** Written by `markChargebackApplied` at [assets/js/dealer-portal.js:1328](assets/js/dealer-portal.js) but not in the migration file. Likely added via SQL editor.
- **Whether the `services` PATCH/DELETE/POST flow at [assets/js/dealer-portal.js:2543–2647](assets/js/dealer-portal.js) is reachable** given that its triggering UI doesn't exist in `index.html`. Probably not, but worth confirming nothing else triggers `pricingPersistAllServicesToSupabase`.
- **Whether the Stripe LIVE publishable key on [index.html:2141](index.html) matches the LIVE secret key in Vercel env.** They have to agree. Verify in Stripe dashboard.
- **Whether the welcome-email Formspree endpoint at [assets/js/dealer-portal.js:8](assets/js/dealer-portal.js) is the right destination.** Looks like a single shared inbox; check it's the intended target for new-dealer welcome messages and for the contact form.
- **Whether the customer email on the contract is reliable enough to send the activation email to.** The webhook unconditionally emails `contract.customer_email` ([api/stripe-webhook.js:111](api/stripe-webhook.js)). No validation, no opt-in record.

## 10. What belongs in this repo vs. the marketing repo

- **This repo (`Whitestone-Dealer-Portal-main`):** anything behind login. Dealer-facing app, API endpoints, dealer pricing, tickets, contracts, billing/cart, cancellations, admin panels, all Supabase reads/writes, all Stripe interactions, all transactional emails and PDFs.
- **`whitestone-partners` (separate repo):** marketing site, public landing page, dealer recruitment form (the form UI itself; the `dealer_applications` row it produces lives here in this repo's Supabase). Static HTML only, no backend, no Supabase client.

If a future session is tempted to add an `/api/` folder or import the Supabase client to the marketing repo, that's a signal something is wrong.

## 11. How future sessions should work

- **One concern per session.** Never mix RLS changes with API auth changes with marketing site work in the same session.
- **Read before writing.** For any change touching money, auth, or RLS: audit first, propose the change, wait for human confirmation, then apply.
- **Commit before starting work and after each logical change.** Use `git revert` to undo, not manual edits. Note: the workspace at this exact path is **not** a git repo today (`git status` will fail) — confirm git is initialized before relying on `git revert`.
- **New Supabase changes go in NEW migration files with new timestamps.** Never edit an old migration that has already been applied.
- **Test API endpoints with `curl` against the deployed function before trusting them.** The local repo has no dev server config; the only way to exercise `/api/*` is against Vercel.
- **When grepping for a function, grep BOTH `index.html` and `assets/js/dealer-portal.js`.** Section 3 explains the split.
- **Prefer fixing the broken cart payment flow (Section 8 #1) by moving status mutation server-side**, not by patching the client to read the JSON body. The architecture invariant in Section 5 says Stripe is the source of truth.

## 12. Change Log

Permanent record of significant changes applied to production.

### 2026-05-10 — RLS Lockdown (Session 1 + Session 2 combined)

**What was wrong:** Every table in the public schema had a single policy named "allow all <tablename>" applied to the public role with `using (true) with check (true)`, plus direct GRANT of INSERT/UPDATE/DELETE/TRUNCATE to the anon role. Effect: anyone with the publicly-visible anon key (in the client-side JS) could read, modify, or delete any row in any table, including `dealers.password` (legacy plaintext column, not used for auth), `dealers.stripe_customer_id`, all customer PII, and all financial data.

**What was applied:** Single transaction in Supabase SQL Editor. Steps:
1. REVOKE ALL on every public-schema table from `anon` and `authenticated`. Re-granted only the minimum SELECT/INSERT/UPDATE/DELETE required, table-by-table.
2. DROP the 13 "allow all" policies.
3. CREATE helper functions `public.is_admin()` and `public.current_dealer_id()` (both SECURITY DEFINER, STABLE, search_path=public).
4. CREATE per-table policies enforcing dealer-isolation by `dealer_id = public.current_dealer_id()` with admin override via `public.is_admin()`. DELETE restricted to admin-only on most tables.
5. ALTER TABLE ... FORCE ROW LEVEL SECURITY on every table.

**Tables covered:** `audit_log`, `cancellations`, `contracts`, `dealer_applications`, `dealer_messages`, `dealer_pricing`, `dealers`, `hin_conflicts`, `invoice_items`, `invoices`, `reimbursements`, `services`, `tickets`.

**Special cases worth knowing:**
- `audit_log` is admin-read-only for now (Option B from the planning conversation). It has no `dealer_id` column — only `dealer_name` (text). Dealer-side activity feed is now empty; future session should add a proper `dealer_id` column and rewrite policy.
- `dealer_applications` allows public INSERT (for the marketing-site form) but admin-only SELECT/UPDATE/DELETE.
- `services` is read-all-authenticated, admin-write — it's a shared reference table of service types.
- `hin_conflicts` is admin-only for SELECT/UPDATE, but any authenticated user can INSERT (so conflicts can be raised by client code when it detects a HIN collision attempt).

**Verification:** All policies were listed back via `pg_policies` at the end of the transaction before COMMIT. Admin login (support@whitestone-partners.com) confirmed working post-deploy. No dealers in production yet (system not live), so no user-facing regressions to monitor.

**SQL artifact:** The full transaction was NOT yet saved as a migration file at the time of lockdown — it was applied directly to production via the SQL editor. Saving the SQL to `supabase/migrations/` is a pending follow-up (Task 1 of next session).

**Pending follow-ups identified during this session:**
- Drop the unused `dealers.password` legacy plaintext column (no longer used for auth — Supabase Auth handles this via `auth.users`).
- 9 of 11 dealer rows in the `dealers` table have `auth_id IS NULL` — these are placeholder/test rows that cannot log in. They are now functionally invisible from the dealer side and visible only to admin. Decision needed: keep, mark inactive, or delete.
- `audit_log` schema needs a `dealer_id uuid` column (FK to `dealers.id`) so dealer-side activity feed can be re-enabled with a non-fragile policy.
