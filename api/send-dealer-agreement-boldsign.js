const { sendDocument } = require('./_boldsign-helpers.js');

/**
 * /api/send-dealer-agreement-boldsign.js
 *
 * Sends the dealer agreement PDF via BoldSign for electronic signature.
 * NEW endpoint — not wired into the live flow yet (Phase 1A).
 *
 * Mirrors send-dealer-agreement-docusign.js: admin auth gate, PDF generation,
 * then sends via BoldSign coordinate fields instead of DocuSign anchors.
 */

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

  // --- AUTHENTICATION GATE (admin only) — copied from send-dealer-agreement-docusign.js ---
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

  if (!process.env.BOLDSIGN_API_KEY) {
    console.error('send-dealer-agreement-boldsign: missing BOLDSIGN_API_KEY');
    return res.status(500).json({ error: 'Server misconfigured (boldsign)' });
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
    console.error('send-dealer-agreement-boldsign: dealer fetch failed:', e);
    return res.status(500).json({ error: 'Failed to fetch dealer' });
  }

  const realRecipientEmail = dealer.email;
  const realRecipientName = [dealer.contact_first_name, dealer.contact_last_name]
    .filter(function (p) { return !!p; }).join(' ') || (dealer.dealership_name || 'Dealer');

  if (!realRecipientEmail) {
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
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ dealerId: dealerId })
    });
    if (!pdfRes.ok) {
      const errBody = await pdfRes.text();
      console.error('send-dealer-agreement-boldsign: PDF generation failed:', pdfRes.status, errBody);
      return res.status(500).json({ error: 'PDF generation failed: ' + errBody.substring(0, 200) });
    }
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    pdfBase64 = pdfBuf.toString('base64');
  } catch (e) {
    console.error('send-dealer-agreement-boldsign: PDF generation threw:', e);
    return res.status(500).json({ error: 'PDF generation error' });
  }

  // 3. Coordinate fields (converted from DEALER: anchor on page 3).
  const formFields = [
    {
      id: 'dealer_sign',
      name: 'dealer_sign',
      fieldType: 'Signature',
      pageNumber: 3,
      bounds: { x: 110, y: 94, width: 180, height: 22 },
      isRequired: true
    },
    {
      id: 'dealer_date',
      name: 'dealer_date',
      fieldType: 'DateSigned',
      pageNumber: 3,
      bounds: { x: 110, y: 73, width: 120, height: 18 },
      isRequired: true
    }
  ];

  // 4. Send via BoldSign
  try {
    const result = await sendDocument({
      title: 'Whitestone Partners — Dealer Participation Agreement',
      message: 'Please review and sign your Whitestone Partners dealer agreement.',
      signerName: realRecipientName,
      signerEmail: realRecipientEmail,
      pdfBase64: pdfBase64,
      formFields: formFields,
      metadata: {
        dealer_id: String(dealerId),
        whitestone_type: 'dealer_agreement'
      }
    });

    return res.status(200).json({
      success: true,
      provider: 'boldsign',
      documentId: result.documentId || result.DocumentId || null,
      sent_to: realRecipientEmail
    });
  } catch (e) {
    console.error('send-dealer-agreement-boldsign error:', e);
    return res.status(500).json({ error: e.message });
  }
};
