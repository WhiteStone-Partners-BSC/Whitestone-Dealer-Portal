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

      await fetch(supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId), {
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
    }
  }

  return res.status(200).json({ received: true });
}
