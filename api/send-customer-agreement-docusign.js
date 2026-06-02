const { getDocuSignAccessToken, deriveAuthHost } = require('./_docusign-helpers.js');

/**
 * /api/send-customer-agreement-docusign.js
 *
 * Sends the customer enrollment contract PDF via DocuSign for electronic signature.
 *
 * Flow:
 *   1. JWT auth gate (contract owner OR admin)
 *   2. Fetch contract row + dealership info
 *   3. Generate the pre-filled PDF (server-to-server call to /api/generate-enrollment-pdf)
 *   4. Authenticate to DocuSign via JWT grant -> exchange for access token
 *   5. Create envelope: upload PDF, add customer as signer with anchor-based signature field
 *   6. Tag envelope with customFields for webhook routing (whitestone_type=customer_contract)
 *   7. Send envelope (DocuSign emails customer)
 *   8. Persist envelope id + status back to contract row
 *
 * Test mode: while DOCUSIGN_TEST_MODE_ENABLED is true, envelope recipient
 * is TEST_EMAIL_RECIPIENT instead of customer_email. Subject is prefixed
 * with [TEST -> realEmail] for visibility.
 */

const SUPPORT_REPLY_EMAIL = 'support@whitestone-partners.com';

// ============================================================
// TEST MODE -- FLIP TO false BEFORE SENDING TO REAL CUSTOMERS
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

  const contractId = payload && payload.contractId;
  if (!contractId) return res.status(400).json({ error: 'contractId required' });

  // --- AUTHENTICATION GATE (contract owner OR admin) ---
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

  // Step 1: Verify JWT
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

  // Step 2: Look up the caller's dealer row
  let callerDealer;
  try {
    const callerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(callerAuthUid) + '&select=id,is_admin,active',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const rows = await callerRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    callerDealer = rows[0];
    if (!callerDealer.active) {
      return res.status(403).json({ error: 'Dealer account is inactive' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Could not look up caller dealer' });
  }

  // Step 3: Fetch the contract
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

  // Step 4: Ownership check (admin OR contract owner)
  const isAdmin = !!callerDealer.is_admin;
  const isOwner = String(contract.dealer_id) === String(callerDealer.id);
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'You do not have access to this contract' });
  }

  // Step 5: Validate the contract has required customer info
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

  // Step 6: Generate the pre-filled PDF via existing endpoint
  const protocol = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers.host;
  const pdfUrl = protocol + '://' + host + '/api/generate-enrollment-pdf';

  let pdfBase64;
  try {
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
      console.error('send-customer-agreement-docusign: PDF generation failed:', pdfRes.status, errText);
      return res.status(500).json({ error: 'PDF generation failed', detail: errText });
    }
    // The Python endpoint returns the PDF as binary bytes
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    pdfBase64 = pdfBuf.toString('base64');
  } catch (e) {
    console.error('send-customer-agreement-docusign: PDF fetch error:', e && e.message);
    return res.status(500).json({ error: 'Could not fetch PDF' });
  }

  // Step 7: Authenticate to DocuSign
  let accessToken, accountBaseUri, accountId;
  try {
    const DS_USER_ID = process.env.DOCUSIGN_USER_ID;
    const DS_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
    const DS_PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY;
    const DS_BASE_URI = process.env.DOCUSIGN_BASE_URI;
    const DS_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
    if (!DS_USER_ID || !DS_INTEGRATION_KEY || !DS_PRIVATE_KEY || !DS_BASE_URI || !DS_ACCOUNT_ID) {
      return res.status(500).json({ error: 'Server misconfigured (DocuSign env)' });
    }

    accessToken = await getDocuSignAccessToken({
      userId: DS_USER_ID,
      integrationKey: DS_INTEGRATION_KEY,
      privateKey: DS_PRIVATE_KEY,
      authHost: deriveAuthHost(DS_BASE_URI)
    });
    accountBaseUri = DS_BASE_URI;
    accountId = DS_ACCOUNT_ID;
  } catch (e) {
    console.error('send-customer-agreement-docusign: DocuSign auth failed:', e && e.message);
    return res.status(500).json({ error: 'DocuSign authentication failed' });
  }

  // Step 8: Resolve recipient (test mode swaps to TEST_EMAIL_RECIPIENT)
  const realRecipientEmail = customerEmail;
  const realRecipientName = customerFullName;
  const recipientEmail = DOCUSIGN_TEST_MODE_ENABLED ? TEST_EMAIL_RECIPIENT : realRecipientEmail;
  const recipientName = DOCUSIGN_TEST_MODE_ENABLED ? TEST_EMAIL_NAME : realRecipientName;

  const subjectPrefix = DOCUSIGN_TEST_MODE_ENABLED
    ? '[TEST -> ' + realRecipientEmail + '] '
    : '';
  const emailSubject = subjectPrefix + 'Please sign your Whitestone Marine Maintenance Plan';

  // Step 9: Build envelope definition
  const envelopeDef = {
    emailSubject: emailSubject,
    emailBlurb: 'Hi ' + recipientName + ', please review and sign your Marine Maintenance Plan enrollment. If you have any questions, reply directly to ' + SUPPORT_REPLY_EMAIL + '.',
    status: 'sent',
    emailSettings: {
      replyEmailAddressOverride: SUPPORT_REPLY_EMAIL,
      replyEmailNameOverride: 'Whitestone Partners'
    },
    documents: [
      {
        documentBase64: pdfBase64,
        name: 'Whitestone Marine Maintenance Plan',
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    customFields: {
      textCustomFields: [
        {
          name: 'whitestone_type',
          value: 'customer_contract',
          required: 'false',
          show: 'false'
        },
        {
          name: 'whitestone_contract_id',
          value: String(contractId),
          required: 'false',
          show: 'false'
        }
      ]
    },
    recipients: {
      signers: [
        {
          email: recipientEmail,
          name: recipientName,
          recipientId: '1',
          routingOrder: '1',
          // Anchor-based tab placement: customer signs on the line containing
          // "MAINTENANCE PLAN HOLDER SIGNATURE:". Initial offsets from dealer
          // template (X=180 Y=8 sig, X=420 Y=3 date). May need tuning in 8.4.
          tabs: {
            signHereTabs: [
              {
                anchorString: 'MAINTENANCE PLAN HOLDER SIGNATURE:',
                anchorXOffset: '180',
                anchorYOffset: '8',
                anchorUnits: 'pixels',
                anchorIgnoreIfNotPresent: 'false'
              }
            ],
            dateSignedTabs: [
              {
                anchorString: 'MAINTENANCE PLAN HOLDER SIGNATURE:',
                anchorXOffset: '420',
                anchorYOffset: '-2',
                anchorUnits: 'pixels',
                anchorIgnoreIfNotPresent: 'false'
              }
            ]
          }
        }
      ]
    }
  };

  // Step 10: Create + send envelope
  let envelopeId, envelopeStatus;
  try {
    const createUrl = accountBaseUri + '/v2.1/accounts/' + accountId + '/envelopes';
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(envelopeDef)
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('send-customer-agreement-docusign: envelope create failed:', createRes.status, errText);
      return res.status(500).json({ error: 'DocuSign envelope creation failed', detail: errText });
    }
    const envelopeData = await createRes.json();
    envelopeId = envelopeData.envelopeId;
    envelopeStatus = envelopeData.status || 'sent';
  } catch (e) {
    console.error('send-customer-agreement-docusign: envelope create error:', e && e.message);
    return res.status(500).json({ error: 'Could not create envelope' });
  }

  // Step 11: Persist envelope ID + status to contract row
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
          docusign_envelope_id: envelopeId,
          docusign_envelope_status: envelopeStatus
        })
      }
    );
  } catch (e) {
    console.error('send-customer-agreement-docusign: contract PATCH failed:', e && e.message);
    // Envelope was created but not persisted. Return success anyway so dealer sees confirmation.
    // Webhook will still update the row when customer signs (assuming envelope ID can be matched).
  }

  // Step 12: Return success
  return res.status(200).json({
    ok: true,
    envelopeId: envelopeId,
    envelopeStatus: envelopeStatus,
    testMode: DOCUSIGN_TEST_MODE_ENABLED,
    recipientEmail: recipientEmail,
    recipientName: recipientName,
    realRecipientEmail: realRecipientEmail,
    realRecipientName: realRecipientName
  });
};
