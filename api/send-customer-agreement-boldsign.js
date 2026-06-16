const { sendDocument } = require('./_boldsign-helpers.js');
const { resolveCallerAccess, callerCanActOnLocation } = require('./_caller-access.js');

/**
 * /api/send-customer-agreement-boldsign.js
 *
 * Sends the customer enrollment contract PDF via BoldSign for electronic signature.
 * NEW endpoint — not wired into the live flow yet (Phase 2A).
 *
 * Mirrors send-customer-agreement-docusign.js: contract-owner OR admin auth gate,
 * PDF generation via /api/generate-enrollment-pdf, then BoldSign coordinate fields.
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

  const contractId = payload && payload.contractId;
  if (!contractId) return res.status(400).json({ error: 'contractId required' });

  // --- AUTHENTICATION GATE (contract owner OR admin) — from send-customer-agreement-docusign.js ---
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

  if (!process.env.BOLDSIGN_API_KEY) {
    console.error('send-customer-agreement-boldsign: missing BOLDSIGN_API_KEY');
    return res.status(500).json({ error: 'Server misconfigured (boldsign)' });
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

  var access;
  try {
    access = await resolveCallerAccess(SUPABASE_URL, SERVICE_KEY, callerAuthUid);
  } catch (e) {
    return res.status(500).json({ error: 'Could not look up caller access' });
  }
  if (!access.ok) {
    if (access.reason === 'inactive') return res.status(403).json({ error: 'Dealer account is inactive' });
    return res.status(403).json({ error: 'No access for this user' });
  }

  let contract;
  try {
    const contractRes = await fetch(
      SUPABASE_URL + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId) + '&select=*&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const rows = await contractRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    contract = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Could not fetch contract' });
  }

  const isAdmin = access.isAdmin === true;
  const isOwner = callerCanActOnLocation(access, contract.dealer_id);
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'You do not have access to this contract' });
  }
  // --- END AUTH ---

  const customerEmail = contract.customer_email;
  const customerFirstName = contract.customer_first_name || '';
  const customerLastName = contract.customer_last_name || '';
  const customerFullName = (customerFirstName + ' ' + customerLastName).trim();

  if (!customerEmail) {
    return res.status(400).json({ error: 'Contract has no customer email' });
  }
  if (!customerFullName) {
    return res.status(400).json({ error: 'Contract has no customer name' });
  }

  let pdfBase64;
  try {
    const protocol = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers.host;
    const pdfUrl = protocol + '://' + host + '/api/generate-enrollment-pdf';

    const pdfRes = await fetch(pdfUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + jwt
      },
      body: JSON.stringify({ contractId: contractId })
    });
    if (!pdfRes.ok) {
      const errText = await pdfRes.text();
      console.error('send-customer-agreement-boldsign: PDF generation failed:', pdfRes.status, errText);
      return res.status(500).json({ error: 'PDF generation failed', detail: errText });
    }
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    pdfBase64 = pdfBuf.toString('base64');
  } catch (e) {
    console.error('send-customer-agreement-boldsign: PDF fetch error:', e && e.message);
    return res.status(500).json({ error: 'Could not fetch PDF' });
  }

  // Signature + date on page 2 (MAINTENANCE PLAN HOLDER SIGNATURE: anchor, bottom-origin).
  const formFields = [
    {
      id: 'cust_sign',
      name: 'cust_sign',
      fieldType: 'Signature',
      pageNumber: 2,
      bounds: { x: 180, y: 625, width: 180, height: 20 },
      isRequired: true
    },
    {
      id: 'cust_date',
      name: 'cust_date',
      fieldType: 'DateSigned',
      pageNumber: 2,
      bounds: { x: 420, y: 625, width: 110, height: 18 },
      isRequired: true
    }
  ];

  try {
    const result = await sendDocument({
      title: 'Whitestone Partners — Maintenance Plan Agreement',
      message: 'Please review and sign your Whitestone Partners maintenance plan agreement.',
      signerName: customerFullName,
      signerEmail: customerEmail,
      pdfBase64: pdfBase64,
      formFields: formFields,
      metadata: {
        contract_id: String(contractId),
        whitestone_type: 'customer_contract'
      }
    });

    const documentId = result.documentId || result.DocumentId || null;

    // Persist document id on contract row (reuse envelope columns until BoldSign-specific cols exist).
    if (documentId) {
      try {
        await fetch(
          SUPABASE_URL + '/rest/v1/contracts?id=eq.' + encodeURIComponent(contractId),
          {
            method: 'PATCH',
            headers: {
              apikey: SERVICE_KEY,
              Authorization: 'Bearer ' + SERVICE_KEY,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              docusign_envelope_id: documentId,
              docusign_envelope_status: 'sent'
            })
          }
        );
      } catch (e) {
        console.error('send-customer-agreement-boldsign: contract PATCH failed:', e && e.message);
      }
    }

    return res.status(200).json({
      success: true,
      provider: 'boldsign',
      documentId: documentId,
      sent_to: customerEmail
    });
  } catch (e) {
    console.error('send-customer-agreement-boldsign error:', e);
    return res.status(500).json({ error: e.message });
  }
};
