import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  var parts = sigHeader.split(',');
  var timestamp = null;
  var signatures = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p.indexOf('t=') === 0) timestamp = p.slice(2);
    else if (p.indexOf('v1=') === 0) signatures.push(p.slice(3));
  }
  if (!timestamp || !signatures.length) return false;
  var tsNum = parseInt(timestamp, 10);
  if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  var signed = timestamp + '.' + payload;
  var expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  var expBuf = Buffer.from(expected, 'hex');
  for (var j = 0; j < signatures.length; j++) {
    try {
      var sigBuf = Buffer.from(signatures[j], 'hex');
      if (expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) return true;
    } catch (e) {}
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: 'Not configured' });
  }

  var sig = req.headers['stripe-signature'];
  var body = await getRawBody(req);
  var payload = body.toString('utf8');

  if (!verifyStripeSignature(payload, sig, webhookSecret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  var event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // ----- Helpers used by multiple event handlers -----
  var supabaseUrl = process.env.SUPABASE_URL || 'https://ypuohmiynnmbnlqfctlg.supabase.co';
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseKey) {
    console.error('stripe-webhook: SUPABASE_SERVICE_KEY and SUPABASE_ANON_KEY both missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  var supaHeaders = {
    'apikey': supabaseKey,
    'Authorization': 'Bearer ' + supabaseKey,
    'Content-Type': 'application/json'
  };

  // Wholesale price map by contract_type. Source of truth for revenue math.
  // Keep in sync with the admin Pricing dashboard reference panel.
  var WHOLESALE_PRICE_BY_TYPE = {
    '1yr': 2495,
    '2yr': 4495,
    '3yr': 6495
  };

  // ----- Event router -----

  // payment_intent.processing: ACH submitted. Money has NOT moved yet.
  // The frontend already marked the invoice as 'processing'; nothing to do here.
  // Log for diagnostics so we can verify webhooks are firing.
  if (event.type === 'payment_intent.processing') {
    var piProcessing = event.data.object;
    console.log('stripe-webhook: payment_intent.processing for', piProcessing.id, 'amount', piProcessing.amount);
    return res.status(200).json({ received: true, type: event.type });
  }

  // payment_intent.succeeded: card cleared (instant) OR ACH cleared (3-5 days later).
  if (event.type === 'payment_intent.succeeded') {
    var pi = event.data.object;
    var contractIdMeta = pi.metadata && pi.metadata.contract_id;
    var amountPaid = (typeof pi.amount_received === 'number') ? pi.amount_received / 100 : null;
    var paidAtIso = new Date().toISOString();

    // Path A: single-contract payment (legacy enrollment flow uses this).
    if (contractIdMeta) {
      var wholesaleForContract = amountPaid;
      // If amount missing for some reason, fall back to contract_type lookup.
      try {
        var contractTypeMeta = pi.metadata && pi.metadata.contract;
        if (!wholesaleForContract && WHOLESALE_PRICE_BY_TYPE[contractTypeMeta]) {
          wholesaleForContract = WHOLESALE_PRICE_BY_TYPE[contractTypeMeta];
        }
      } catch (e) {}

      var patchRes = await fetch(supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractIdMeta), {
        method: 'PATCH',
        headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify(Object.assign(
          { status: 'active', stripe_payment_id: pi.id, paid_at: paidAtIso },
          wholesaleForContract ? { wholesale_price: wholesaleForContract } : {}
        ))
      });

      if (patchRes.ok) {
        // Send the existing customer welcome email (unchanged logic, just wrapped).
        try {
          await sendContractWelcomeEmail(contractIdMeta, supabaseUrl, supaHeaders);
        } catch (e) {
          console.error('stripe-webhook: welcome email failed', e);
        }
      }
      return res.status(200).json({ received: true, type: event.type, path: 'single' });
    }

    // Path B: invoice-batch payment (cart flow). Look up invoice_items by stripe_payment_intent_id.
    // Each row's contract may already be 'active' (frontend activated immediately) but the invoice
    // is in 'processing' state and needs to flip to 'paid'.
    try {
      var invRes = await fetch(
        supabaseUrl + '/rest/v1/invoice_items?stripe_payment_intent_id=eq.' + encodeURIComponent(pi.id) + '&select=id,contract_id,status',
        { headers: supaHeaders }
      );
      var invRows = await invRes.json();
      if (Array.isArray(invRows) && invRows.length > 0) {
        for (var i = 0; i < invRows.length; i++) {
          var row = invRows[i];
          // Flip invoice to paid.
          await fetch(supabaseUrl + '/rest/v1/invoice_items?id=eq.' + encodeURIComponent(row.id), {
            method: 'PATCH',
            headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
            body: JSON.stringify({
              status: 'paid',
              paid_at: paidAtIso,
              ach_failure_reason: null
            })
          });
          // Contract is likely already active from frontend. No-op if so. Defensive PATCH ensures it.
          if (row.contract_id) {
            await fetch(supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(row.contract_id), {
              method: 'PATCH',
              headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
              body: JSON.stringify({ status: 'active', stripe_payment_id: pi.id, paid_at: paidAtIso })
            });
          }
        }
      }
    } catch (e) {
      console.error('stripe-webhook: invoice batch flip failed', e);
    }
    return res.status(200).json({ received: true, type: event.type, path: 'batch' });
  }

  // payment_intent.payment_failed: ACH bounced or card declined AFTER the frontend already
  // marked the invoice 'processing' and the contract 'active'. Per business rule, contract STAYS
  // active. We flip the invoice back to 'unpaid' so it reappears in the dealer's cart, store the
  // Stripe failure reason so the dealer sees what went wrong, and email admin.
  if (event.type === 'payment_intent.payment_failed') {
    var piFail = event.data.object;
    var failReason = '';
    try {
      var lastErr = piFail.last_payment_error;
      if (lastErr) {
        failReason = lastErr.message || lastErr.code || lastErr.decline_code || 'Payment failed';
      }
      if (!failReason) failReason = 'Payment failed (no detail from bank)';
    } catch (e) {
      failReason = 'Payment failed';
    }

    try {
      var invFailRes = await fetch(
        supabaseUrl + '/rest/v1/invoice_items?stripe_payment_intent_id=eq.' + encodeURIComponent(piFail.id) + '&select=id,contract_id,status',
        { headers: supaHeaders }
      );
      var invFailRows = await invFailRes.json();

      if (Array.isArray(invFailRows) && invFailRows.length > 0) {
        for (var k = 0; k < invFailRows.length; k++) {
          var failRow = invFailRows[k];
          // Flip invoice back to unpaid, store reason. Contract stays active.
          await fetch(supabaseUrl + '/rest/v1/invoice_items?id=eq.' + encodeURIComponent(failRow.id), {
            method: 'PATCH',
            headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
            body: JSON.stringify({
              status: 'unpaid',
              ach_failure_reason: failReason,
              paid_at: null
            })
          });
        }
      }

      // Email admin via Resend (only support@whitestone-partners.com for now).
      var resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        var amountFailed = (typeof piFail.amount === 'number') ? (piFail.amount / 100).toFixed(2) : '?';
        var pmTypeMeta = (piFail.metadata && piFail.metadata.payment_method_type) || 'unknown';
        var dealerMeta = (piFail.metadata && piFail.metadata.dealer) || 'unknown dealer';
        var failHtml =
          '<h2 style="font-family:sans-serif;color:#0c1e2e;">Payment failed</h2>' +
          '<p><strong>Dealer:</strong> ' + dealerMeta + '</p>' +
          '<p><strong>Amount:</strong> $' + amountFailed + '</p>' +
          '<p><strong>Method:</strong> ' + pmTypeMeta + '</p>' +
          '<p><strong>Stripe PI:</strong> ' + piFail.id + '</p>' +
          '<p><strong>Reason from Stripe:</strong> ' + failReason + '</p>' +
          '<p>The invoice has been returned to the dealer\'s cart. Contracts stay active per business rule.</p>';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Whitestone Partners <support@whitestone-partners.com>',
            to: ['support@whitestone-partners.com'],
            subject: 'Payment failed: ' + dealerMeta + ' - $' + amountFailed,
            html: failHtml
          })
        });
      }
    } catch (e) {
      console.error('stripe-webhook: payment_failed handler error', e);
    }
    return res.status(200).json({ received: true, type: event.type });
  }

  // charge.dispute.created: chargeback opened. Notify admin immediately - this is high-stakes.
  if (event.type === 'charge.dispute.created') {
    var dispute = event.data.object;
    try {
      var resendKeyD = process.env.RESEND_API_KEY;
      if (resendKeyD) {
        var disputeAmount = (typeof dispute.amount === 'number') ? (dispute.amount / 100).toFixed(2) : '?';
        var disputeReason = dispute.reason || 'unknown';
        var disputeHtml =
          '<h2 style="font-family:sans-serif;color:#c8102e;">Chargeback opened</h2>' +
          '<p><strong>Amount:</strong> $' + disputeAmount + '</p>' +
          '<p><strong>Reason:</strong> ' + disputeReason + '</p>' +
          '<p><strong>Stripe charge:</strong> ' + (dispute.charge || 'unknown') + '</p>' +
          '<p><strong>Dispute ID:</strong> ' + dispute.id + '</p>' +
          '<p>Respond to this dispute in the Stripe Dashboard. Deadline is typically within 7 days of receipt.</p>';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKeyD,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Whitestone Partners <support@whitestone-partners.com>',
            to: ['support@whitestone-partners.com'],
            subject: 'URGENT: Chargeback opened - $' + disputeAmount,
            html: disputeHtml
          })
        });
      }
    } catch (e) {
      console.error('stripe-webhook: dispute handler error', e);
    }
    return res.status(200).json({ received: true, type: event.type });
  }

  // Unrecognized event type - just acknowledge so Stripe doesn't retry.
  console.log('stripe-webhook: unhandled event type:', event.type);

  return res.status(200).json({ received: true });
}

// Sends the "Your contract is active" email to the customer for a single-contract payment.
// Looks up the contract by id, builds the branded HTML, sends via Resend.
async function sendContractWelcomeEmail(contractId, supabaseUrl, supaHeaders) {
  var contractDetailsRes = await fetch(
    supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId) + '&select=*',
    { headers: { apikey: supaHeaders.apikey, Authorization: supaHeaders.Authorization } }
  );
  var contractDetails = await contractDetailsRes.json();
  var contract = contractDetails && contractDetails[0];
  if (!contract || !contract.customer_email) return;

  var startDate = contract.start_date
    ? new Date(contract.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  var endDate = contract.end_date
    ? new Date(contract.end_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  var contractTypeLabel = contract.contract_type === '2yr' ? '2-Year' : contract.contract_type === '3yr' ? '3-Year' : '1-Year';
  var customerFirstName = contract.customer_first_name || 'there';

  var welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:2rem 1rem;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <tr><td style="height:4px;background:linear-gradient(90deg,#b8963e,#d4ac52,#b8963e);"></td></tr>
      <tr><td style="background:#0c1e2e;padding:2rem;text-align:center;">
        <div style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:white;letter-spacing:0.06em;">WHITESTONE PARTNERS</div>
        <div style="font-size:10px;color:#b8963e;letter-spacing:0.18em;text-transform:uppercase;margin-top:4px;">Certified Marine Dealer Program</div>
      </td></tr>
      <tr><td style="padding:2rem 2rem 1rem;text-align:center;border-bottom:1px solid #eef0f3;">
        <div style="font-family:Georgia,serif;font-size:28px;font-weight:300;color:#0c1e2e;margin-bottom:0.75rem;">Your contract is active.</div>
        <div style="font-size:15px;color:#6b8599;line-height:1.7;">Hi ${customerFirstName}, your Whitestone Partners annual boat service contract is now active and your dealer is ready to get started.</div>
      </td></tr>
      <tr><td style="padding:1.5rem 2rem;">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#b8963e;margin-bottom:1rem;">Your Contract Details</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13.5px;">
          <tr style="border-bottom:1px solid #eef0f3;"><td style="padding:10px 0;color:#6b8599;width:140px;">Boat</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${(contract.boat_year||'')} ${(contract.boat_make||'')} ${(contract.boat_model||'')}</td></tr>
          <tr style="border-bottom:1px solid #eef0f3;"><td style="padding:10px 0;color:#6b8599;">Hull ID (HIN)</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;font-family:monospace;">${contract.hin||'-'}</td></tr>
          <tr style="border-bottom:1px solid #eef0f3;"><td style="padding:10px 0;color:#6b8599;">Contract</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${contractTypeLabel}</td></tr>
          <tr style="border-bottom:1px solid #eef0f3;"><td style="padding:10px 0;color:#6b8599;">Enrolled</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${startDate}</td></tr>
          <tr style="border-bottom:1px solid #eef0f3;"><td style="padding:10px 0;color:#6b8599;">Expires</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${endDate}</td></tr>
          <tr><td style="padding:10px 0;color:#6b8599;">Your Dealer</td><td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${contract.dealership_name||'-'}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 2rem 1.5rem;">
        <div style="background:#f8f5ee;border:1px solid #e0c97a;border-left:4px solid #b8963e;border-radius:6px;padding:1.25rem 1.5rem;">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#b8963e;margin-bottom:0.75rem;">What's Covered</div>
          <div style="font-size:13px;color:#3d5870;line-height:1.8;">De-Winterization, Impeller Service, Engine Oil Service, Fuel Filter Service, Transmission Oil Service, Outdrive Service, Shaft Alignment, Winterization, V-Drive Service, Ballast Cartridge Service</div>
        </div>
      </td></tr>
      <tr><td style="padding:0 2rem 1.5rem;">
        <div style="font-size:13.5px;color:#6b8599;line-height:1.7;text-align:center;">Every service your dealer completes is logged automatically, building a complete documented service history for your boat. This record is a valuable asset when it comes time to sell.</div>
      </td></tr>
      <tr><td style="padding:1.25rem 2rem;border-top:1px solid #eef0f3;border-bottom:1px solid #eef0f3;text-align:center;">
        <div style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#0c1e2e;">"The contract that brings your customers back. Every season."</div>
      </td></tr>
      <tr><td style="padding:1.25rem 2rem;text-align:center;">
        <div style="font-size:12px;color:#9aafbf;">Questions about your contract?</div>
        <div style="font-size:12px;color:#9aafbf;margin-top:4px;"><a href="mailto:support@whitestone-partners.com" style="color:#b8963e;text-decoration:none;">support@whitestone-partners.com</a> &nbsp;.&nbsp; <a href="https://whitestone-partners.com" style="color:#b8963e;text-decoration:none;">whitestone-partners.com</a></div>
        <div style="font-size:11px;color:#c5d5e0;margin-top:1rem;">Whitestone Partners LLC, St. George, Utah</div>
      </td></tr>
      <tr><td style="height:4px;background:linear-gradient(90deg,#b8963e,#d4ac52,#b8963e);"></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Whitestone Partners <support@whitestone-partners.com>',
      to: [contract.customer_email],
      subject: 'Your Whitestone Partners Contract is Active - ' + (contract.boat_year||'') + ' ' + (contract.boat_make||'') + ' ' + (contract.boat_model||''),
      html: welcomeHtml
    })
  });
}
