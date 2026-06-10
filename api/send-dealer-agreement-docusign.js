const { getDocuSignAccessToken, deriveAuthHost } = require('./_docusign-helpers.js');

/**
 * /api/send-dealer-agreement-docusign.js
 *
 * Sends the dealer agreement PDF via DocuSign for electronic signature.
 *
 * Flow:
 *   1. JWT auth gate (admin only)
 *   2. Fetch dealer record
 *   3. Generate the pre-filled PDF (server-to-server call to existing PDF endpoint)
 *   4. Authenticate to DocuSign via JWT grant -> exchange for access token
 *   5. Create envelope: upload PDF, add signer with email + signature field
 *   6. Send envelope (DocuSign emails dealer)
 *   7. Persist envelope id + status back to dealer row
 *
 * Test mode: while DOCUSIGN_TEST_MODE_ENABLED is true, envelope recipient
 * is TEST_EMAIL_RECIPIENT instead of dealer.email. Subject is prefixed
 * with [TEST -> realEmail] for visibility.
 */

const SUPPORT_REPLY_EMAIL = 'support@whitestone-partners.com';

// ============================================================
// TEST MODE -- FLIP TO false BEFORE SENDING TO REAL DEALERS
// ============================================================
const DOCUSIGN_TEST_MODE_ENABLED = true;
const TEST_EMAIL_RECIPIENT = 'neblloydben@gmail.com';
const TEST_EMAIL_NAME = 'Ben Lloyd (Test)';
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const dealerId = payload && payload.dealerId;
  if (!dealerId) return res.status(400).json({ error: 'dealerId required' });

  // --- AUTHENTICATION GATE (admin only) ---
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured (supabase)' });
  }

  let callerAuthUid;
  try {
    const verifyRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: SUPABASE_ANON_KEY }
    });
    if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    const authUser = await verifyRes.json();
    callerAuthUid = authUser && authUser.id;
    if (!callerAuthUid) return res.status(401).json({ error: 'No user id in token' });
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

  // Verify caller is admin
  try {
    const callerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(callerAuthUid) + '&select=id,is_admin,active',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const callerRows = await callerRes.json();
    if (!Array.isArray(callerRows) || callerRows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    if (!callerRows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required to send dealer agreements' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not verify caller' });
  }
  // --- END AUTH ---

  // DocuSign env vars
  const DS_USER_ID = process.env.DOCUSIGN_USER_ID;
  const DS_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
  const DS_BASE_URI = process.env.DOCUSIGN_BASE_URI; // e.g. https://demo.docusign.net/restapi
  const DS_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
  const DS_PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY;
  if (!DS_USER_ID || !DS_ACCOUNT_ID || !DS_BASE_URI || !DS_INTEGRATION_KEY || !DS_PRIVATE_KEY) {
    console.error('send-dealer-agreement-docusign: missing DocuSign env vars');
    return res.status(500).json({ error: 'Server misconfigured (docusign)' });
  }

  const supabaseHeaders = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  // 1. Fetch dealer row
  let dealer;
  try {
    const dealerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId) + '&select=*&limit=1',
      { headers: supabaseHeaders }
    );
    const rows = await dealerRes.json();
    if (!dealerRes.ok || !Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    dealer = rows[0];
  } catch (e) {
    console.error('Dealer fetch failed:', e);
    return res.status(500).json({ error: 'Failed to fetch dealer' });
  }

  if (!dealer.email) {
    return res.status(400).json({ error: 'Dealer has no email on file' });
  }

  // 2. Generate the PDF by calling the existing endpoint (server-to-server)
  let pdfBase64;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const pdfUrl = protocol + '://' + host + '/api/generate-dealer-agreement-pdf';

    const pdfRes = await fetch(pdfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ dealerId: dealerId })
    });
    if (!pdfRes.ok) {
      const errBody = await pdfRes.text();
      console.error('PDF generation failed:', pdfRes.status, errBody);
      return res.status(500).json({ error: 'PDF generation failed: ' + errBody.substring(0, 200) });
    }
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    pdfBase64 = pdfBuf.toString('base64');
  } catch (e) {
    console.error('PDF generation threw:', e);
    return res.status(500).json({ error: 'PDF generation error' });
  }

  // 3. DocuSign JWT auth -- exchange RSA-signed JWT for an access token
  let dsAccessToken;
  try {
    dsAccessToken = await getDocuSignAccessToken({
      userId: DS_USER_ID,
      integrationKey: DS_INTEGRATION_KEY,
      privateKey: DS_PRIVATE_KEY,
      authHost: deriveAuthHost(DS_BASE_URI)
    });
  } catch (e) {
    console.error('DocuSign JWT auth failed:', e && e.message);
    return res.status(500).json({ error: 'DocuSign authentication failed: ' + (e && e.message || 'unknown') });
  }

  // 4. Build envelope
  const realRecipientEmail = dealer.email;
  const realRecipientName = [dealer.contact_first_name, dealer.contact_last_name]
    .filter(function(p) { return !!p; }).join(' ') || (dealer.dealership_name || 'Dealer');

  const recipientEmail = DOCUSIGN_TEST_MODE_ENABLED ? TEST_EMAIL_RECIPIENT : realRecipientEmail;
  const recipientName = DOCUSIGN_TEST_MODE_ENABLED ? TEST_EMAIL_NAME : realRecipientName;
  const subjectPrefix = DOCUSIGN_TEST_MODE_ENABLED ? '[TEST -> ' + realRecipientEmail + '] ' : '';
  const emailSubject = subjectPrefix + 'Please sign your Whitestone Partners Dealer Agreement';

  const envelopeDef = {
    emailSubject: emailSubject,
    emailBlurb: 'Hi ' + recipientName + ', please review and sign the attached Dealer Participation Agreement. If you have any questions, reply directly to ' + SUPPORT_REPLY_EMAIL + '.',
    status: 'sent', // send immediately; use 'created' to create as draft instead
    emailSettings: {
      replyEmailAddressOverride: SUPPORT_REPLY_EMAIL,
      replyEmailNameOverride: 'Whitestone Partners'
    },
    documents: [
      {
        documentBase64: pdfBase64,
        name: 'Whitestone Dealer Agreement',
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    recipients: {
      signers: [
        {
          email: recipientEmail,
          name: recipientName,
          recipientId: '1',
          routingOrder: '1',
          // Page 3 dealer block: unique anchor 'DEALER:' (top ~654), then SIGNATURE ~676, DATE ~701.
          // Positive anchorYOffset moves tab DOWN from the anchor origin (bottom-left of matched text).
          tabs: {
            signHereTabs: [
              {
                anchorString: 'DEALER:',
                anchorXOffset: '50',
                anchorYOffset: '24',
                anchorUnits: 'pixels',
                anchorIgnoreIfNotPresent: 'false'
              }
            ],
            dateSignedTabs: [
              {
                anchorString: 'DEALER:',
                anchorXOffset: '50',
                anchorYOffset: '48',
                anchorUnits: 'pixels',
                anchorIgnoreIfNotPresent: 'false'
              }
            ]
          }
        }
      ]
    }
  };

  // 5. Create + send envelope
  let envelopeId;
  let envelopeStatus;
  try {
    const envelopeRes = await fetch(
      DS_BASE_URI + '/v2.1/accounts/' + encodeURIComponent(DS_ACCOUNT_ID) + '/envelopes',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + dsAccessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(envelopeDef)
      }
    );
    const envelopeJson = await envelopeRes.json();
    if (!envelopeRes.ok) {
      console.error('DocuSign envelope create failed:', envelopeRes.status, envelopeJson);
      const msg = (envelopeJson && envelopeJson.message) || ('DocuSign envelope create failed (' + envelopeRes.status + ')');
      return res.status(500).json({ error: msg });
    }
    envelopeId = envelopeJson.envelopeId;
    envelopeStatus = envelopeJson.status || 'sent';
  } catch (e) {
    console.error('DocuSign envelope request threw:', e);
    return res.status(500).json({ error: 'DocuSign request error' });
  }

  // 6. Persist envelope id/status to dealer row
  try {
    await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId),
      {
        method: 'PATCH',
        headers: supabaseHeaders,
        body: JSON.stringify({
          docusign_envelope_id: envelopeId,
          docusign_envelope_status: envelopeStatus,
          agreement_signed_at: null
        })
      }
    );
  } catch (e) {
    console.warn('Could not persist docusign envelope id:', e);
    // Non-fatal: envelope was sent successfully.
  }

  return res.status(200).json({
    ok: true,
    envelopeId: envelopeId,
    envelopeStatus: envelopeStatus,
    sent_to: recipientEmail,
    real_recipient: realRecipientEmail,
    test_mode: DOCUSIGN_TEST_MODE_ENABLED
  });
};
