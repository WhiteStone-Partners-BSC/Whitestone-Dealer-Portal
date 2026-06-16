/**
 * /api/boldsign-webhook.js
 *
 * Receives BoldSign webhook events (document status updates).
 * Verifies HMAC signature, routes dealer agreements by Labels, mutates dealer state.
 *
 * Events handled:
 *   - Completed  (all signers done — download PDF, update dealer, notify admin)
 *   - others     (acknowledged and ignored)
 *
 * Setup:
 *   1. BoldSign dashboard -> API -> Webhooks -> add endpoint
 *   2. URL: https://www.whitestone-dealer-portal.vercel.app/api/boldsign-webhook
 *   3. Events: Completed (+ Sent/Viewed/Signed optional for logging)
 *   4. Copy signing secret -> BOLDSIGN_WEBHOOK_SECRET in Vercel
 */

const crypto = require('crypto');
const { BOLDSIGN_API_BASE } = require('./_boldsign-helpers.js');

const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// BoldSign: X-BoldSign-Signature: t=TIMESTAMP,s0=HEX_HMAC[,s1=OLD_KEY_HEX]
// Signed payload = `${timestamp}.${rawBody}`; HMAC-SHA256 with webhook secret -> hex.
function verifyBoldSignSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;

  var parts = String(signatureHeader).split(',');
  var timestamp = null;
  var signatures = [];
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim().split('=');
    if (kv.length < 2) continue;
    var key = kv[0].trim();
    var val = kv.slice(1).join('=').trim();
    if (key === 't') timestamp = val;
    if (key === 's0' || key === 's1') signatures.push(val.toLowerCase());
  }
  if (!timestamp || signatures.length === 0) return false;

  var signedPayload = timestamp + '.' + rawBody.toString('utf8');
  var expectedHex = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex').toLowerCase();
  var expectedBuf = Buffer.from(expectedHex, 'utf8');

  for (var j = 0; j < signatures.length; j++) {
    try {
      var sigBuf = Buffer.from(signatures[j], 'utf8');
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch (e) {}
  }
  return false;
}

function parseLabels(labels) {
  var dealerId = null;
  var whitestoneType = null;
  (Array.isArray(labels) ? labels : []).forEach(function (l) {
    var s = String(l);
    if (s.indexOf('dealer_id:') === 0) dealerId = s.slice('dealer_id:'.length);
    if (s.indexOf('whitestone_type:') === 0) whitestoneType = s.slice('whitestone_type:'.length);
  });
  return { dealerId: dealerId, whitestoneType: whitestoneType };
}

async function fetchDocumentLabels(documentId, apiKey) {
  if (!apiKey || !documentId) return { dealerId: null, whitestoneType: null, labels: [] };
  try {
    var res = await fetch(
      BOLDSIGN_API_BASE + '/v1/document/properties?documentId=' + encodeURIComponent(documentId),
      { headers: { 'X-API-KEY': apiKey, accept: 'application/json' } }
    );
    if (!res.ok) return { dealerId: null, whitestoneType: null, labels: [] };
    var json = await res.json();
    var labels = json.labels || json.Labels || [];
    var parsed = parseLabels(labels);
    return { dealerId: parsed.dealerId, whitestoneType: parsed.whitestoneType, labels: labels };
  } catch (e) {
    console.warn('boldsign-webhook: document properties fetch failed:', e && e.message);
    return { dealerId: null, whitestoneType: null, labels: [] };
  }
}

async function downloadSignedPdf(documentId, apiKey) {
  var headers = { 'X-API-KEY': apiKey, accept: 'application/pdf' };

  // Prefer base64 response when supported.
  var dlRes = await fetch(
    BOLDSIGN_API_BASE + '/v1/document/download?documentId=' + encodeURIComponent(documentId),
    { headers: Object.assign({}, headers, { 'x-response-format': 'base64' }) }
  );
  if (!dlRes.ok) {
    var errText = await dlRes.text();
    throw new Error('BoldSign download failed (' + dlRes.status + '): ' + errText.slice(0, 200));
  }

  var contentType = (dlRes.headers.get('content-type') || '').toLowerCase();
  if (contentType.indexOf('application/json') !== -1) {
    var json = await dlRes.json();
    var b64 = json.data || json.file || json.base64 || json.document || '';
    if (typeof b64 === 'string' && b64.indexOf('base64,') !== -1) {
      b64 = b64.split('base64,')[1];
    }
    if (b64) return Buffer.from(b64, 'base64');
  }

  return Buffer.from(await dlRes.arrayBuffer());
}

function extractSignerName(data, context) {
  var signerName = '';
  try {
    var signers = (data && data.signerDetails) || [];
    if (context && context.actor && context.actor.userType === 'Signer' && context.actor.id) {
      for (var i = 0; i < signers.length; i++) {
        if (signers[i].id === context.actor.id) {
          signerName = signers[i].name || signers[i].signerName || signers[i].emailAddress || '';
          break;
        }
      }
    }
    if (!signerName && signers.length > 0) {
      for (var j = 0; j < signers.length; j++) {
        if (signers[j].status === 'Completed') {
          signerName = signers[j].name || signers[j].signerName || signers[j].emailAddress || '';
          break;
        }
      }
    }
    if (!signerName && signers.length > 0) {
      signerName = signers[0].name || signers[0].signerName || signers[0].emailAddress || '';
    }
  } catch (e) {}
  return signerName;
}

async function sendAdminEmail(opts) {
  var RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.warn('boldsign-webhook: RESEND_API_KEY missing, skipping admin email');
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + RESEND_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Whitestone Partners <support@whitestone-partners.com>',
      to: ['support@whitestone-partners.com'],
      subject: opts.subject,
      html: opts.html
    })
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var rawBody = await getRawBody(req);
  var signatureHeader = req.headers['x-boldsign-signature'] || req.headers['X-BoldSign-Signature'] || '';
  var eventHeader = req.headers['x-boldsign-event'] || req.headers['X-BoldSign-Event'] || '';

  // BoldSign verification ping during webhook registration.
  if (eventHeader === 'Verification') {
    return res.status(200).json({ received: true, verification: true });
  }

  var webhookSecret = process.env.BOLDSIGN_WEBHOOK_SECRET;
  if (webhookSecret) {
    if (!verifyBoldSignSignature(rawBody, signatureHeader, webhookSecret)) {
      console.warn('boldsign-webhook: invalid signature, rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('boldsign-webhook: BOLDSIGN_WEBHOOK_SECRET not set — skipping signature verification (set before live)');
  }

  var payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('boldsign-webhook payload:', JSON.stringify(payload).slice(0, 2000));

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  var BOLDSIGN_API_KEY = process.env.BOLDSIGN_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('boldsign-webhook: SUPABASE env vars missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  var supaHeaders = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  var eventType = (payload.event && payload.event.eventType) || payload.eventType || '';
  var data = payload.data || payload.document || {};
  var documentId = data.documentId || data.DocumentId || data.id || payload.documentId;

  if (!eventType) {
    return res.status(200).json({ received: true, warning: 'no eventType' });
  }

  // Only act when all signers are done.
  if (String(eventType) !== 'Completed') {
    console.log('boldsign-webhook: ignored eventType=' + eventType + ' documentId=' + (documentId || ''));
    return res.status(200).json({ received: true, ignored: eventType });
  }

  if (!documentId) {
    return res.status(200).json({ received: true, warning: 'no documentId' });
  }

  // Read dealer_id from Labels/Tags on the payload; fallback to BoldSign document properties API.
  var labels = data.labels || data.Labels || data.tags || data.Tags || [];
  var labelInfo = parseLabels(labels);
  var dealerId = labelInfo.dealerId;
  var whitestoneType = labelInfo.whitestoneType;

  if (!dealerId && BOLDSIGN_API_KEY) {
    var fetched = await fetchDocumentLabels(documentId, BOLDSIGN_API_KEY);
    dealerId = fetched.dealerId;
    whitestoneType = whitestoneType || fetched.whitestoneType;
  }

  if (whitestoneType && whitestoneType !== 'dealer_agreement') {
    console.log('boldsign-webhook: ignoring non-dealer document type=' + whitestoneType);
    return res.status(200).json({ received: true, ignored: 'whitestone_type:' + whitestoneType });
  }

  if (!dealerId) {
    console.warn('boldsign-webhook: no dealer_id label on documentId=' + documentId);
    return res.status(200).json({ received: true, warning: 'no dealer_id label' });
  }

  // Fetch dealer row for idempotency + signer name fallback.
  var dealer;
  try {
    var dealerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId) + '&select=*&limit=1',
      { headers: supaHeaders }
    );
    var dealerRows = await dealerRes.json();
    if (!dealerRes.ok || !Array.isArray(dealerRows) || dealerRows.length === 0) {
      console.warn('boldsign-webhook: dealer not found id=' + dealerId);
      return res.status(200).json({ received: true, warning: 'dealer not found' });
    }
    dealer = dealerRows[0];
  } catch (e) {
    console.error('boldsign-webhook: dealer lookup failed:', e && e.message);
    return res.status(500).json({ error: 'Dealer lookup failed' });
  }

  if (dealer.agreement_signed_at) {
    console.log('boldsign-webhook: Completed already processed for dealer=' + dealerId);
    return res.status(200).json({ received: true, type: eventType, idempotent: true });
  }

  var signedAt = new Date().toISOString();
  var signerName = extractSignerName(data, payload.context);
  if (!signerName) {
    signerName = [dealer.contact_first_name, dealer.contact_last_name]
      .filter(function (p) { return !!p; }).join(' ') || dealer.dealership_name || '';
  }

  // 1. Download signed PDF + upload to Supabase Storage.
  var storagePath = null;
  if (BOLDSIGN_API_KEY) {
    try {
      var pdfBuf = await downloadSignedPdf(documentId, BOLDSIGN_API_KEY);
      storagePath = dealer.id + '/' + documentId + '.pdf';
      var uploadRes = await fetch(
        SUPABASE_URL + '/storage/v1/object/dealer-agreements/' + storagePath,
        {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': 'application/pdf',
            'x-upsert': 'true'
          },
          body: pdfBuf
        }
      );
      if (!uploadRes.ok) {
        var uploadErr = await uploadRes.text();
        console.error('boldsign-webhook: PDF upload to storage failed:', uploadRes.status, uploadErr);
        storagePath = null;
      }
    } catch (e) {
      console.error('boldsign-webhook: PDF retrieve/upload error:', e && e.message);
    }
  } else {
    console.warn('boldsign-webhook: BOLDSIGN_API_KEY missing, skipping PDF download');
  }

  // 2. Mutate dealer row — mirror DocuSign envelope-completed patch.
  try {
    var patch = {
      agreement_signed_at: signedAt,
      agreement_signed_by: signerName,
      enrollment_status: 'signed'
    };
    await fetch(SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealer.id), {
      method: 'PATCH',
      headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
      body: JSON.stringify(patch)
    });
  } catch (e) {
    console.error('boldsign-webhook: dealer PATCH failed:', e && e.message);
  }

  // 3. Notify admin — mirror DocuSign email build.
  try {
    await sendAdminEmail({
      subject: 'Dealer signed agreement (BoldSign): ' + (dealer.dealership_name || dealer.email),
      html: '<h2 style="color:#0c1e2e;">Agreement signed (BoldSign)</h2>'
        + '<p><strong>Dealer:</strong> ' + escapeHtml(dealer.dealership_name || '') + '</p>'
        + '<p><strong>Signed by:</strong> ' + escapeHtml(signerName) + '</p>'
        + '<p><strong>Signed at:</strong> ' + escapeHtml(signedAt) + '</p>'
        + '<p><strong>Document ID:</strong> ' + escapeHtml(documentId) + '</p>'
        + (storagePath
          ? '<p><strong>Signed PDF stored at:</strong> dealer-agreements/' + escapeHtml(storagePath) + '</p>'
          : '<p><em>Note: signed PDF retrieval failed — fetch manually from BoldSign UI.</em></p>')
        + '<p style="margin-top:24px;background:#fdf9ed;padding:14px 18px;border-left:3px solid #b8963e;border-radius:4px;">'
        + '<strong>Next step:</strong> Set pricing for this dealer in the Pricing tab, then flip their status to active.'
        + '</p>'
    });
  } catch (e) {
    console.error('boldsign-webhook: admin email failed:', e && e.message);
  }

  return res.status(200).json({
    received: true,
    type: eventType,
    dealerId: dealer.id,
    documentId: documentId,
    stored: !!storagePath
  });
}

module.exports = handler;
module.exports.config = config;
