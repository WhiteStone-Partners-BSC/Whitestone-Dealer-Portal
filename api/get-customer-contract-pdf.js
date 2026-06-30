const { BOLDSIGN_API_BASE } = require('./_boldsign-helpers.js');

const STORAGE_BUCKET = 'customer-contracts';

async function downloadSignedPdfFromBoldSign(documentId, apiKey) {
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

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'Customer';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTHENTICATION GATE (from charge-enrollment.js) ---
  var authHeader = req.headers.authorization || req.headers.Authorization || '';
  var jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  var supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error('get-customer-contract-pdf: SUPABASE env vars missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  var authUser;
  try {
    var verifyRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: supabaseAnonKey },
    });
    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    authUser = await verifyRes.json();
  } catch (err) {
    console.error('get-customer-contract-pdf: JWT verification failed', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var authUid = authUser && authUser.id;
  if (!authUid) {
    return res.status(401).json({ error: 'No user id in token' });
  }

  var callerDealer;
  try {
    var dealerRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid) + '&select=id,is_admin,active',
      { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
    );
    var dealerRows = await dealerRes.json();
    if (!Array.isArray(dealerRows) || dealerRows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    callerDealer = dealerRows[0];
  } catch (err) {
    console.error('get-customer-contract-pdf: dealer lookup failed', err);
    return res.status(500).json({ error: 'Could not verify caller' });
  }

  if (!callerDealer.active) {
    return res.status(403).json({ error: 'Dealer account is inactive' });
  }
  // --- END AUTHENTICATION ---

  var contractId = req.body && req.body.contractId;
  if (!contractId) {
    return res.status(400).json({ error: 'Missing contractId' });
  }

  var contract;
  try {
    var contractRes = await fetch(
      supabaseUrl + '/rest/v1/contracts?id=eq.' + encodeURIComponent(String(contractId)) +
        '&select=id,dealer_id,docusign_envelope_id,agreement_signed_at,customer_first_name,customer_last_name,hin&limit=1',
      { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
    );
    var contractRows = await contractRes.json();
    if (!contractRes.ok || !Array.isArray(contractRows) || contractRows.length === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    contract = contractRows[0];
  } catch (err) {
    console.error('get-customer-contract-pdf: contract lookup failed', err);
    return res.status(500).json({ error: 'Could not load contract' });
  }

  if (!callerDealer.is_admin && String(contract.dealer_id) !== String(callerDealer.id)) {
    return res.status(403).json({ error: 'You do not have access to this contract' });
  }

  var documentId = contract.docusign_envelope_id;
  if (!documentId || !contract.agreement_signed_at) {
    return res.status(404).json({ error: 'No signed contract on file' });
  }

  var pdfBuf = null;
  var storagePaths = [
    String(contract.id) + '/' + documentId + '.pdf',
    String(contract.dealer_id) + '/' + documentId + '.pdf',
  ];

  for (var si = 0; si < storagePaths.length && !pdfBuf; si++) {
    try {
      var storageRes = await fetch(
        supabaseUrl + '/storage/v1/object/' + STORAGE_BUCKET + '/' + storagePaths[si],
        { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
      );
      if (storageRes.ok) {
        pdfBuf = Buffer.from(await storageRes.arrayBuffer());
      }
    } catch (err) {
      console.warn('get-customer-contract-pdf: storage fetch failed path=' + storagePaths[si], err && err.message);
    }
  }

  if (!pdfBuf) {
    var boldsignKey = process.env.BOLDSIGN_API_KEY;
    if (!boldsignKey) {
      console.error('get-customer-contract-pdf: BOLDSIGN_API_KEY missing and storage miss');
      return res.status(404).json({ error: 'Signed contract PDF not available' });
    }
    try {
      pdfBuf = await downloadSignedPdfFromBoldSign(documentId, boldsignKey);
    } catch (err) {
      console.error('get-customer-contract-pdf: BoldSign fallback failed', err && err.message);
      return res.status(404).json({ error: 'Signed contract PDF not available' });
    }
  }

  var lastName = sanitizeFilenamePart(contract.customer_last_name);
  var hin = sanitizeFilenamePart((contract.hin || '').replace(/\s+/g, ''));
  var filename = 'Whitestone_Contract_' + lastName + '_' + hin + '.pdf';

  return res.status(200).json({
    base64: pdfBuf.toString('base64'),
    filename: filename,
  });
}
