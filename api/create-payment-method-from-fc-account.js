export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTH GATE (same pattern as create-stripe-financial-connections-session.js) ---
  var authHeader = req.headers.authorization || req.headers.Authorization || '';
  var jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization header' });

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  var supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('create-payment-method-from-fc-account: SUPABASE env vars missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  var authUser;
  try {
    var verifyRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: supabaseAnonKey }
    });
    if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    authUser = await verifyRes.json();
  } catch (err) {
    console.error('create-payment-method-from-fc-account: JWT verify failed', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }
  var authUid = authUser && authUser.id;
  if (!authUid) return res.status(401).json({ error: 'No user id in token' });

  var callerDealer;
  try {
    var dealerRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid) + '&select=id,is_admin,active,stripe_customer_id',
      { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
    );
    var dealerRows = await dealerRes.json();
    if (!Array.isArray(dealerRows) || dealerRows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    callerDealer = dealerRows[0];
  } catch (err) {
    console.error('create-payment-method-from-fc-account: dealer lookup failed', err);
    return res.status(500).json({ error: 'Could not verify caller' });
  }
  if (!callerDealer.active) return res.status(403).json({ error: 'Dealer account is inactive' });
  // --- END AUTH GATE ---

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  var { financialConnectionsAccountId } = req.body || {};
  if (!financialConnectionsAccountId) {
    return res.status(400).json({ error: 'Missing financialConnectionsAccountId' });
  }

  try {
    // Create a us_bank_account PaymentMethod FROM the linked Financial Connections account.
    var pmParams = new URLSearchParams();
    pmParams.append('type', 'us_bank_account');
    pmParams.append('us_bank_account[financial_connections_account]', financialConnectionsAccountId);

    var pmRes = await fetch('https://api.stripe.com/v1/payment_methods', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: pmParams.toString()
    });
    var pm = await pmRes.json();
    if (!pmRes.ok) {
      console.error('create-payment-method-from-fc-account: PM create failed', pm.error);
      return res.status(400).json({ error: pm.error ? pm.error.message : 'Failed to create payment method' });
    }

    return res.status(200).json({ success: true, paymentMethodId: pm.id });
  } catch (e) {
    console.error('create-payment-method-from-fc-account: exception', e);
    return res.status(500).json({ error: e.message });
  }
}
