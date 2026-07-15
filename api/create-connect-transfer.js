const { resolveCallerAccess } = require('./_caller-access.js');

/**
 * /api/create-connect-transfer.js
 *
 * Phase 2.2 (SANDBOX). Admin-only. Creates a Stripe Connect transfer to a
 * dealer's connected account for pending approved reimbursements.
 *
 * Safety:
 *   - Uses STRIPE_CONNECT_SECRET_KEY only (never STRIPE_SECRET_KEY).
 *   - Pays by dealer_id -> org -> acct_ (never by dealership_name alone).
 *   - Recomputes amount from the DB; never trusts a client-sent total.
 *   - Creates payout_batches FIRST, transfers with Idempotency-Key =
 *     payout_batch_{batch.id}, deletes the batch if the transfer fails
 *     (before any reimbursement is flipped).
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var ANON = process.env.SUPABASE_ANON_KEY;
  var SERVICE = process.env.SUPABASE_SERVICE_KEY;
  var STRIPE = process.env.STRIPE_CONNECT_SECRET_KEY; // Connect sandbox key, NOT STRIPE_SECRET_KEY
  if (!SUPABASE_URL || !ANON || !SERVICE || !STRIPE) {
    console.error('create-connect-transfer: missing env');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  var jwt = (req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization' });

  var authUid;
  try {
    var uRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: ANON }
    });
    if (!uRes.ok) return res.status(401).json({ error: 'Invalid token' });
    var authUser = await uRes.json();
    authUid = authUser && authUser.id;
    if (!authUid) return res.status(401).json({ error: 'No user id in token' });
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var access;
  try {
    access = await resolveCallerAccess(SUPABASE_URL, SERVICE, authUid);
  } catch (e) {
    return res.status(500).json({ error: 'Could not resolve caller access' });
  }
  if (!access || !access.ok || access.isAdmin !== true) {
    return res.status(403).json({ error: 'Admin only' });
  }

  var body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  var dealerId = body.dealerId;
  var cycleStart = body.cycleStart || null;
  var cycleEnd = body.cycleEnd || null;
  if (!dealerId) return res.status(400).json({ error: 'dealerId required' });

  var svc = {
    apikey: SERVICE,
    Authorization: 'Bearer ' + SERVICE,
    'Content-Type': 'application/json'
  };

  // Resolve dealer -> org -> Connect account (by dealer_id, never by name alone).
  var dealer;
  try {
    var dRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId) +
        '&select=id,dealership_name,organization_id&limit=1',
      { headers: svc }
    );
    var dRows = await dRes.json();
    dealer = Array.isArray(dRows) && dRows[0] ? dRows[0] : null;
  } catch (e) {
    return res.status(500).json({ error: 'Dealer lookup failed' });
  }
  if (!dealer) return res.status(404).json({ error: 'Dealer not found' });
  if (!dealer.organization_id) {
    return res.status(400).json({ error: 'Dealer has no organization — cannot route payout' });
  }

  var org;
  try {
    var oRes = await fetch(
      SUPABASE_URL + '/rest/v1/organizations?id=eq.' + encodeURIComponent(dealer.organization_id) +
        '&select=id,stripe_connect_account_id,payouts_enabled&limit=1',
      { headers: svc }
    );
    var oRows = await oRes.json();
    org = Array.isArray(oRows) && oRows[0] ? oRows[0] : null;
  } catch (e) {
    return res.status(500).json({ error: 'Organization lookup failed' });
  }
  if (!org || !org.stripe_connect_account_id) {
    return res.status(400).json({ error: 'Dealer has not set up payouts yet' });
  }
  if (org.payouts_enabled !== true) {
    return res.status(400).json({ error: 'Payouts are not enabled for this dealer yet' });
  }

  // Recompute amount from DB (mirror claimsMarkDealerPaid filter: pending reimbursements
  // whose tickets are approved). Prefer dealer_id for the money path.
  var approvedIds = {};
  try {
    var tRes = await fetch(
      SUPABASE_URL + '/rest/v1/tickets?status=eq.approved&select=id',
      { headers: svc }
    );
    var tRows = await tRes.json();
    (Array.isArray(tRows) ? tRows : []).forEach(function (t) { approvedIds[t.id] = true; });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load approved tickets' });
  }

  var eligible = [];
  try {
    var rRes = await fetch(
      SUPABASE_URL + '/rest/v1/reimbursements?dealer_id=eq.' + encodeURIComponent(dealerId) +
        '&status=eq.pending&select=*&order=created_at.asc',
      { headers: svc }
    );
    if (!rRes.ok) return res.status(500).json({ error: 'Could not load reimbursements' });
    var rRows = await rRes.json();
    eligible = (Array.isArray(rRows) ? rRows : []).filter(function (r) {
      return r.ticket_id && approvedIds[r.ticket_id];
    });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load reimbursements' });
  }

  var totalDollars = eligible.reduce(function (sum, r) {
    return sum + (parseFloat(r.amount) || 0);
  }, 0);
  var ticketCount = eligible.length;
  if (ticketCount === 0 || totalDollars <= 0) {
    return res.status(400).json({ error: 'Nothing pending to reimburse' });
  }
  var amountCents = Math.round(totalDollars * 100);

  var oldest = eligible[0];
  if (!cycleStart) {
    cycleStart = (oldest.created_at || new Date().toISOString()).substring(0, 10);
  }
  if (!cycleEnd) {
    cycleEnd = new Date().toISOString().split('T')[0];
  }
  var todayStr = new Date().toISOString().split('T')[0];
  var paidBy = (access.dealerRow && (access.dealerRow.dealership_name || access.dealerRow.username)) || 'admin';

  // Create batch FIRST so we have a stable id for Idempotency-Key.
  // payment_reference is NOT NULL — placeholder overwritten on success.
  var batch;
  try {
    var batchRes = await fetch(SUPABASE_URL + '/rest/v1/payout_batches', {
      method: 'POST',
      headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        dealer_id: dealerId,
        dealership_name: dealer.dealership_name || '',
        cycle_start: cycleStart,
        cycle_end: cycleEnd,
        total_amount: totalDollars,
        ticket_count: ticketCount,
        payment_reference: 'stripe_pending',
        paid_by: paidBy
      })
    });
    if (!batchRes.ok) {
      var batchErr = await batchRes.text();
      console.error('create-connect-transfer: batch create failed', batchRes.status, batchErr);
      return res.status(500).json({ error: 'Could not create payout batch' });
    }
    var batchRows = await batchRes.json();
    batch = Array.isArray(batchRows) ? batchRows[0] : batchRows;
  } catch (e) {
    return res.status(500).json({ error: 'Could not create payout batch' });
  }
  if (!batch || !batch.id) {
    return res.status(500).json({ error: 'Payout batch created but no id returned' });
  }

  // Transfer — Idempotency-Key scoped to batch.id so a double-click cannot double-pay.
  var transfer;
  try {
    var params = new URLSearchParams();
    params.append('amount', String(amountCents));
    params.append('currency', 'usd');
    params.append('destination', org.stripe_connect_account_id);
    params.append('description', 'Whitestone reimbursement - ' + (dealer.dealership_name || ''));
    params.append('metadata[payout_batch_id]', String(batch.id));
    params.append('metadata[dealer_id]', String(dealerId));
    params.append('metadata[ticket_count]', String(ticketCount));

    var trRes = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + STRIPE,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': 'payout_batch_' + batch.id
      },
      body: params.toString()
    });
    transfer = await trRes.json();
    if (!trRes.ok) {
      var stripeMsg = (transfer && transfer.error && transfer.error.message) || 'Transfer failed';
      console.error('create-connect-transfer: Stripe transfer failed', transfer && transfer.error);
      try {
        await fetch(
          SUPABASE_URL + '/rest/v1/payout_batches?id=eq.' + encodeURIComponent(batch.id),
          { method: 'DELETE', headers: svc }
        );
      } catch (delErr) {
        console.error('create-connect-transfer: failed to delete orphan batch', delErr && delErr.message);
      }
      return res.status(400).json({ error: stripeMsg });
    }
  } catch (e) {
    try {
      await fetch(
        SUPABASE_URL + '/rest/v1/payout_batches?id=eq.' + encodeURIComponent(batch.id),
        { method: 'DELETE', headers: svc }
      );
    } catch (delErr2) {}
    return res.status(500).json({ error: e.message || 'Transfer request failed' });
  }

  // Success: stamp transfer id onto the batch, then flip reimbursements.
  try {
    var patchBatch = await fetch(
      SUPABASE_URL + '/rest/v1/payout_batches?id=eq.' + encodeURIComponent(batch.id),
      {
        method: 'PATCH',
        headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          stripe_transfer_id: transfer.id,
          payment_reference: transfer.id
        })
      }
    );
    if (!patchBatch.ok) {
      console.error('create-connect-transfer: batch PATCH failed after transfer', await patchBatch.text());
    }
  } catch (e) {
    console.error('create-connect-transfer: batch PATCH threw after transfer', e && e.message);
  }

  var patchFailures = 0;
  for (var i = 0; i < eligible.length; i++) {
    try {
      var pRes = await fetch(
        SUPABASE_URL + '/rest/v1/reimbursements?id=eq.' + encodeURIComponent(eligible[i].id),
        {
          method: 'PATCH',
          headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
          body: JSON.stringify({
            status: 'paid',
            paid_date: todayStr,
            payout_batch_id: batch.id
          })
        }
      );
      if (!pRes.ok) patchFailures++;
    } catch (e) {
      patchFailures++;
    }
  }
  if (patchFailures > 0) {
    console.warn('create-connect-transfer: reimbursement PATCH failures', patchFailures, 'of', eligible.length);
  }

  // Re-read (PostgREST 204 can mask RLS/silent no-ops).
  var verifiedBatch = null;
  var verifiedPaidCount = 0;
  try {
    var vbRes = await fetch(
      SUPABASE_URL + '/rest/v1/payout_batches?id=eq.' + encodeURIComponent(batch.id) +
        '&select=id,dealer_id,total_amount,ticket_count,payment_reference,stripe_transfer_id,paid_at,paid_by&limit=1',
      { headers: svc }
    );
    var vbRows = await vbRes.json();
    verifiedBatch = Array.isArray(vbRows) && vbRows[0] ? vbRows[0] : null;

    var vrRes = await fetch(
      SUPABASE_URL + '/rest/v1/reimbursements?payout_batch_id=eq.' + encodeURIComponent(batch.id) +
        '&status=eq.paid&select=id',
      { headers: svc }
    );
    var vrRows = await vrRes.json();
    verifiedPaidCount = Array.isArray(vrRows) ? vrRows.length : 0;
  } catch (e) {
    console.warn('create-connect-transfer: verify re-read failed', e && e.message);
  }

  return res.status(200).json({
    success: true,
    transferId: transfer.id,
    amount: totalDollars,
    ticketCount: ticketCount,
    payoutBatchId: batch.id,
    verified: {
      stripe_transfer_id: verifiedBatch ? verifiedBatch.stripe_transfer_id : null,
      payment_reference: verifiedBatch ? verifiedBatch.payment_reference : null,
      paid_reimbursement_count: verifiedPaidCount
    }
  });
};
