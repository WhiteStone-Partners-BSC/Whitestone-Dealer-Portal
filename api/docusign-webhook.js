/**
 * /api/docusign-webhook.js
 *
 * Receives DocuSign Connect events (envelope status updates).
 * Verifies HMAC signature, routes by event type, mutates dealer state.
 *
 * Events handled:
 *   - envelope-sent       (log only - we already marked it sent at send time)
 *   - envelope-completed  (dealer signed - the important one)
 *   - envelope-declined   (dealer declined - notify admin)
 *
 * Setup:
 *   1. In DocuSign Admin -> Connect -> add configuration
 *   2. URL: https://whitestone-dealer-portal.vercel.app/api/docusign-webhook
 *   3. Events: envelope-sent, envelope-completed, envelope-declined
 *   4. Enable HMAC signing, copy the secret to DOCUSIGN_HMAC_KEY in Vercel
 *   5. Format: JSON
 */

const crypto = require('crypto');
const { getDocuSignAccessToken, fetchSignedEnvelopePdf, deriveAuthHost } = require('./_docusign-helpers.js');

// Vercel needs the raw body for HMAC verification; bodyParser strips that.
const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// DocuSign's HMAC scheme: HMAC-SHA256 of the raw body, base64-encoded.
// Header name: x-docusign-signature-1 (or 2, 3 if multiple keys configured).
function verifyDocuSignSignature(rawBody, headers, secret) {
  if (!secret) return false;
  const sigHeaders = ['x-docusign-signature-1', 'x-docusign-signature-2', 'x-docusign-signature-3'];
  const expectedB64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const expectedBuf = Buffer.from(expectedB64, 'base64');

  for (let i = 0; i < sigHeaders.length; i++) {
    const sig = headers[sigHeaders[i]];
    if (!sig) continue;
    try {
      const sigBuf = Buffer.from(sig, 'base64');
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const HMAC_KEY = process.env.DOCUSIGN_HMAC_KEY;
  if (!HMAC_KEY) {
    console.error('docusign-webhook: DOCUSIGN_HMAC_KEY missing');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const rawBody = await getRawBody(req);
  const payload = rawBody.toString('utf8');

  // Verify the request actually came from DocuSign.
  if (!verifyDocuSignSignature(rawBody, req.headers, HMAC_KEY)) {
    console.warn('docusign-webhook: invalid signature, rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // DocuSign Connect payload shape varies by version. Most recent (Connect 2.0+):
  //   event.event  = 'envelope-completed' | 'envelope-sent' | 'envelope-declined' | ...
  //   event.data   = { envelopeId, envelopeSummary: {...}, accountId, ... }
  const eventType = event.event || event.event_name || '';
  const envelopeData = (event.data && event.data.envelopeSummary) || event.data || event.envelope || {};
  const envelopeId = envelopeData.envelopeId || event.envelopeId || (event.data && event.data.envelopeId);

  if (!envelopeId) {
    console.warn('docusign-webhook: no envelopeId in payload, type=' + eventType);
    return res.status(200).json({ received: true, warning: 'no envelopeId' });
  }

  // --- Supabase setup ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('docusign-webhook: SUPABASE env vars missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  const supaHeaders = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  // --- Find dealer by envelope ID ---
  let dealer;
  try {
    const dealerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?docusign_envelope_id=eq.' + encodeURIComponent(envelopeId) + '&select=*&limit=1',
      { headers: supaHeaders }
    );
    const rows = await dealerRes.json();
    if (Array.isArray(rows) && rows.length > 0) {
      dealer = rows[0];
    }
  } catch (e) {
    console.error('docusign-webhook: dealer lookup failed:', e);
    // Continue - we'll still log the event but skip DB mutations
  }

  if (!dealer) {
    console.warn('docusign-webhook: no dealer matches envelopeId=' + envelopeId + ', eventType=' + eventType);
    // Return 200 so DocuSign doesn't retry. The envelope may belong to a test dealer that was deleted.
    return res.status(200).json({ received: true, warning: 'no matching dealer' });
  }

  // ============================================================
  // Event router
  // ============================================================

  // envelope-sent: we already marked it sent at send time. Log and exit.
  if (eventType === 'envelope-sent') {
    console.log('docusign-webhook: envelope-sent for envelopeId=' + envelopeId + ' dealer=' + dealer.dealership_name);
    // Still bump status in case the send endpoint failed to set it.
    try {
      await fetch(SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealer.id), {
        method: 'PATCH',
        headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ docusign_envelope_status: 'sent' })
      });
    } catch (e) {}
    return res.status(200).json({ received: true, type: eventType });
  }

  // envelope-declined: dealer refused to sign. Notify admin.
  if (eventType === 'envelope-declined') {
    const declineReason = (envelopeData.declinedReason || envelopeData.voidedReason || 'No reason given');
    try {
      await fetch(SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealer.id), {
        method: 'PATCH',
        headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ docusign_envelope_status: 'declined' })
      });
    } catch (e) {}

    try {
      await sendAdminEmail({
        subject: 'Dealer declined agreement: ' + (dealer.dealership_name || dealer.email),
        html: '<h2>Agreement declined</h2>'
          + '<p><strong>Dealer:</strong> ' + escapeHtml(dealer.dealership_name || '') + '</p>'
          + '<p><strong>Email:</strong> ' + escapeHtml(dealer.email || '') + '</p>'
          + '<p><strong>Reason:</strong> ' + escapeHtml(declineReason) + '</p>'
          + '<p><strong>Envelope:</strong> ' + escapeHtml(envelopeId) + '</p>'
          + '<p>This dealer has been marked as declined. Reach out directly to understand the objection.</p>'
      });
    } catch (e) {
      console.error('docusign-webhook: decline email failed:', e);
    }
    return res.status(200).json({ received: true, type: eventType });
  }

  // envelope-completed: the dealer signed. This is the important one.
  if (eventType === 'envelope-completed') {
    // Idempotency check - if we've already processed this envelope-completed, skip.
    if (dealer.docusign_envelope_status === 'completed' && dealer.agreement_signed_at) {
      console.log('docusign-webhook: envelope-completed already processed for envelopeId=' + envelopeId);
      return res.status(200).json({ received: true, type: eventType, idempotent: true });
    }

    const signedAt = new Date().toISOString();

    // Try to extract the signer's name from the payload.
    let signerName = '';
    try {
      const signers = (envelopeData.recipients && envelopeData.recipients.signers) || [];
      if (signers.length > 0) {
        signerName = signers[0].name || signers[0].email || '';
      }
    } catch (e) {}
    if (!signerName) {
      // Fallback - use the contact name we have on file
      signerName = [dealer.contact_first_name, dealer.contact_last_name]
        .filter(function(p) { return !!p; }).join(' ') || dealer.dealership_name || '';
    }

    // 1. Pull the signed PDF from DocuSign + upload to Supabase Storage.
    let storagePath = null;
    try {
      const DS_USER_ID = process.env.DOCUSIGN_USER_ID;
      const DS_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
      const DS_BASE_URI = process.env.DOCUSIGN_BASE_URI;
      const DS_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
      const DS_PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY;

      if (DS_USER_ID && DS_ACCOUNT_ID && DS_BASE_URI && DS_INTEGRATION_KEY && DS_PRIVATE_KEY) {
        const accessToken = await getDocuSignAccessToken({
          userId: DS_USER_ID,
          integrationKey: DS_INTEGRATION_KEY,
          privateKey: DS_PRIVATE_KEY,
          authHost: deriveAuthHost(DS_BASE_URI)
        });
        const pdfBuf = await fetchSignedEnvelopePdf({
          accessToken: accessToken,
          baseUri: DS_BASE_URI,
          accountId: DS_ACCOUNT_ID,
          envelopeId: envelopeId
        });

        // Upload to Supabase Storage: dealer-agreements/{dealerId}/{envelopeId}.pdf
        storagePath = dealer.id + '/' + envelopeId + '.pdf';
        const uploadRes = await fetch(
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
          const errText = await uploadRes.text();
          console.error('docusign-webhook: PDF upload to storage failed:', uploadRes.status, errText);
          storagePath = null; // Don't reference a path that didn't upload.
        }
      } else {
        console.warn('docusign-webhook: skipping PDF retrieval, DocuSign env vars missing');
      }
    } catch (e) {
      console.error('docusign-webhook: PDF retrieval/upload error:', e && e.message);
      // Non-fatal - we still update dealer status. Admin can re-fetch PDF from DocuSign UI.
    }

    // 2. Mutate dealer row: signed + pending pricing.
    try {
      const patch = {
        docusign_envelope_status: 'completed',
        agreement_signed_at: signedAt,
        agreement_signed_by: signerName,
        enrollment_status: 'pending_pricing'
      };
      await fetch(SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealer.id), {
        method: 'PATCH',
        headers: Object.assign({}, supaHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify(patch)
      });
    } catch (e) {
      console.error('docusign-webhook: dealer PATCH failed:', e);
    }

    // 3. Notify admin.
    try {
      await sendAdminEmail({
        subject: 'Dealer signed agreement: ' + (dealer.dealership_name || dealer.email),
        html: '<h2 style="color:#0c1e2e;">Agreement signed</h2>'
          + '<p><strong>Dealer:</strong> ' + escapeHtml(dealer.dealership_name || '') + '</p>'
          + '<p><strong>Signed by:</strong> ' + escapeHtml(signerName) + '</p>'
          + '<p><strong>Signed at:</strong> ' + escapeHtml(signedAt) + '</p>'
          + '<p><strong>Envelope:</strong> ' + escapeHtml(envelopeId) + '</p>'
          + (storagePath
              ? '<p><strong>Signed PDF stored at:</strong> dealer-agreements/' + escapeHtml(storagePath) + '</p>'
              : '<p><em>Note: signed PDF retrieval failed - fetch manually from DocuSign UI.</em></p>')
          + '<p style="margin-top:24px;background:#fdf9ed;padding:14px 18px;border-left:3px solid #b8963e;border-radius:4px;">'
          + '<strong>Next step:</strong> Set pricing for this dealer in the Pricing tab, then flip their status to active.'
          + '</p>'
      });
    } catch (e) {
      console.error('docusign-webhook: admin email failed:', e);
    }

    return res.status(200).json({ received: true, type: eventType, dealer: dealer.id });
  }

  // Unrecognized event type - acknowledge so DocuSign doesn't retry.
  console.log('docusign-webhook: unhandled event type=' + eventType + ' envelopeId=' + envelopeId);
  return res.status(200).json({ received: true, unhandled: eventType });
}

module.exports = handler;
module.exports.config = config;

// ============================================================
// Email helper
// ============================================================
async function sendAdminEmail(opts) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.warn('docusign-webhook: RESEND_API_KEY missing, skipping admin email');
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
