const crypto = require('crypto');

/**
 * /api/connect-webhook.js
 *
 * Phase 2.1 (SANDBOX). Receives Stripe Connect events on CONNECTED accounts.
 * Separate endpoint + separate secret from the inbound stripe-webhook.js.
 *
 * Handles: account.updated -> mirror payouts_enabled / charges_enabled /
 * details_submitted onto the organizations row (matched by stripe_connect_account_id).
 *
 * Setup: register in Stripe TEST dashboard, "Listen to events on Connected accounts",
 * event account.updated, URL https://www.whitestone-dealer-portal.vercel.app/api/connect-webhook,
 * copy signing secret to STRIPE_CONNECT_WEBHOOK_SECRET.
 */

module.exports.config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Stripe signature: header "t=TIMESTAMP,v1=HEX_HMAC[,v1=...]".
// Signed payload = `${t}.${rawBody}`, HMAC-SHA256 -> hex. 5-minute tolerance.
// Guards length/presence so a malformed/forged header returns 400, not a 500 crash.
function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret || !sigHeader || typeof sigHeader !== 'string') return false;
  var parts = sigHeader.split(',');
  var timestamp = null;
  var signatures = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p.indexOf('t=') === 0) timestamp = p.slice(2);
    else if (p.indexOf('v1=') === 0) signatures.push(p.slice(3));
  }
  if (!timestamp || signatures.length === 0) return false;
  var tsNum = parseInt(timestamp, 10);
  if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  var expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + payload, 'utf8').digest('hex');
  var expBuf = Buffer.from(expected, 'hex');
  for (var j = 0; j < signatures.length; j++) {
    try {
      var sigBuf = Buffer.from(signatures[j], 'hex');
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) return true;
    } catch (e) { /* malformed hex -> skip */ }
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SECRET || !SUPABASE_URL || !SERVICE) {
    console.error('connect-webhook: missing env (STRIPE_CONNECT_WEBHOOK_SECRET / SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  var bodyBuf = await rawBody(req);
  var payload = bodyBuf.toString('utf8');
  var sig = req.headers['stripe-signature'] || '';
  if (!verifyStripeSignature(payload, sig, SECRET)) {
    return res.status(400).json({ error: 'Bad signature' });
  }

  var event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.type === 'account.updated') {
    var a = (event.data && event.data.object) ? event.data.object : {};
    if (!a.id) return res.status(200).json({ received: true, warning: 'no account id' });
    try {
      var patchRes = await fetch(
        SUPABASE_URL + '/rest/v1/organizations?stripe_connect_account_id=eq.' + encodeURIComponent(a.id),
        {
          method: 'PATCH',
          headers: {
            apikey: SERVICE,
            Authorization: 'Bearer ' + SERVICE,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            payouts_enabled: !!a.payouts_enabled,
            connect_charges_enabled: !!a.charges_enabled,
            connect_details_submitted: !!a.details_submitted
          })
        }
      );
      if (!patchRes.ok) {
        console.error('connect-webhook: org PATCH failed', patchRes.status, await patchRes.text());
      }
    } catch (e) {
      console.error('connect-webhook: org PATCH threw', e && e.message);
    }
    return res.status(200).json({ received: true, type: event.type, account: a.id });
  }

  return res.status(200).json({ received: true, ignored: event.type });
};
