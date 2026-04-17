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

  if (event.type === 'payment_intent.succeeded') {
    var pi = event.data.object;
    var contractId = pi.metadata && pi.metadata.contract_id;

    if (contractId) {
      var supabaseUrl = process.env.SUPABASE_URL || 'https://ypuohmiynnmbnlqfctlg.supabase.co';
      var supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseKey) {
        supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwdW9obWl5bm5tYm5scWZjdGxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwODU4NzEsImV4cCI6MjA5MTY2MTg3MX0.HzrF_OCr2T9rKV9am90B2OvIQKjq28pObheMRps82AI';
      }

      var patchRes = await fetch(supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId), {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          status: 'active',
          stripe_payment_id: pi.id,
          paid_at: new Date().toISOString()
        })
      });

      if (patchRes.ok) {
        try {
          var contractDetailsRes = await fetch(
            supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId) + '&select=*',
            {
              headers: {
                'apikey':        supabaseKey,
                'Authorization': 'Bearer ' + supabaseKey
              }
            }
          );
          var contractDetails = await contractDetailsRes.json();
          var contract = contractDetails && contractDetails[0];

          if (contract && contract.customer_email) {
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

      <!-- Gold top bar -->
      <tr><td style="height:4px;background:linear-gradient(90deg,#b8963e,#d4ac52,#b8963e);"></td></tr>

      <!-- Header -->
      <tr><td style="background:#0c1e2e;padding:2rem;text-align:center;">
        <div style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:white;letter-spacing:0.06em;">WHITESTONE PARTNERS</div>
        <div style="font-size:10px;color:#b8963e;letter-spacing:0.18em;text-transform:uppercase;margin-top:4px;">Certified Marine Dealer Program</div>
      </td></tr>

      <!-- Hero message -->
      <tr><td style="padding:2rem 2rem 1rem;text-align:center;border-bottom:1px solid #eef0f3;">
        <div style="font-family:Georgia,serif;font-size:28px;font-weight:300;color:#0c1e2e;margin-bottom:0.75rem;">Your contract is active.</div>
        <div style="font-size:15px;color:#6b8599;line-height:1.7;">Hi ${customerFirstName}, your Whitestone Partners annual boat service contract is now active and your dealer is ready to get started.</div>
      </td></tr>

      <!-- Contract details -->
      <tr><td style="padding:1.5rem 2rem;">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#b8963e;margin-bottom:1rem;">Your Contract Details</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13.5px;">
          <tr style="border-bottom:1px solid #eef0f3;">
            <td style="padding:10px 0;color:#6b8599;width:140px;">Boat</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${(contract.boat_year||'')} ${(contract.boat_make||'')} ${(contract.boat_model||'')}</td>
          </tr>
          <tr style="border-bottom:1px solid #eef0f3;">
            <td style="padding:10px 0;color:#6b8599;">Hull ID (HIN)</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;font-family:monospace;">${contract.hin||'—'}</td>
          </tr>
          <tr style="border-bottom:1px solid #eef0f3;">
            <td style="padding:10px 0;color:#6b8599;">Contract</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${contractTypeLabel}</td>
          </tr>
          <tr style="border-bottom:1px solid #eef0f3;">
            <td style="padding:10px 0;color:#6b8599;">Enrolled</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${startDate}</td>
          </tr>
          <tr style="border-bottom:1px solid #eef0f3;">
            <td style="padding:10px 0;color:#6b8599;">Expires</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${endDate}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#6b8599;">Your Dealer</td>
            <td style="padding:10px 0;font-weight:500;color:#0c1e2e;">${contract.dealership_name||'—'}</td>
          </tr>
        </table>
      </td></tr>

      <!-- What's covered -->
      <tr><td style="padding:0 2rem 1.5rem;">
        <div style="background:#f8f5ee;border:1px solid #e0c97a;border-left:4px solid #b8963e;border-radius:6px;padding:1.25rem 1.5rem;">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#b8963e;margin-bottom:0.75rem;">What's Covered</div>
          <div style="font-size:13px;color:#3d5870;line-height:1.8;">
            Summer Prep · Impeller Service · Engine Oil Service · Fuel Filter Service · Transmission Oil Service · Outdrive Service · Shaft Alignment · Winterization · V-Drive Service · Ballast Cartridge Service
          </div>
        </div>
      </td></tr>

      <!-- Service history note -->
      <tr><td style="padding:0 2rem 1.5rem;">
        <div style="font-size:13.5px;color:#6b8599;line-height:1.7;text-align:center;">
          Every service your dealer completes is logged automatically — building a complete documented service history for your boat. This record is a valuable asset when it comes time to sell.
        </div>
      </td></tr>

      <!-- Tagline -->
      <tr><td style="padding:1.25rem 2rem;border-top:1px solid #eef0f3;border-bottom:1px solid #eef0f3;text-align:center;">
        <div style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#0c1e2e;">"The contract that brings your customers back. Every season."</div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:1.25rem 2rem;text-align:center;">
        <div style="font-size:12px;color:#9aafbf;">Questions about your contract?</div>
        <div style="font-size:12px;color:#9aafbf;margin-top:4px;">
          <a href="mailto:support@whitestone-partners.com" style="color:#b8963e;text-decoration:none;">support@whitestone-partners.com</a>
          &nbsp;·&nbsp;
          <a href="https://whitestone-partners.com" style="color:#b8963e;text-decoration:none;">whitestone-partners.com</a>
        </div>
        <div style="font-size:11px;color:#c5d5e0;margin-top:1rem;">Whitestone Partners LLC · St. George, Utah</div>
      </td></tr>

      <!-- Gold bottom bar -->
      <tr><td style="height:4px;background:linear-gradient(90deg,#b8963e,#d4ac52,#b8963e);"></td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

            var resendKey = process.env.RESEND_API_KEY;
            if (resendKey) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + resendKey,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from:    'Whitestone Partners <support@whitestone-partners.com>',
                  to:      [contract.customer_email],
                  subject: 'Your Whitestone Partners Contract is Active — ' + (contract.boat_year||'') + ' ' + (contract.boat_make||'') + ' ' + (contract.boat_model||''),
                  html:    welcomeHtml
                })
              });
            }
          }
        } catch (e) {}
      }
    }
  }

  return res.status(200).json({ received: true });
}
