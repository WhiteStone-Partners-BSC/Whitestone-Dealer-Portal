export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTHENTICATION GATE ---
  var authHeader = req.headers.authorization || req.headers.Authorization || '';
  var jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  var supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('charge-enrollment: SUPABASE env vars missing');
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
    console.error('charge-enrollment: JWT verification failed', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var authUid = authUser && authUser.id;
  if (!authUid) {
    return res.status(401).json({ error: 'No user id in token' });
  }

  var callerDealer;
  try {
    var dealerRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid) + '&select=id,stripe_customer_id,is_admin,active',
      { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
    );
    var dealerRows = await dealerRes.json();
    if (!Array.isArray(dealerRows) || dealerRows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    callerDealer = dealerRows[0];
  } catch (err) {
    console.error('charge-enrollment: dealer lookup failed', err);
    return res.status(500).json({ error: 'Could not verify caller' });
  }

  if (!callerDealer.active) {
    return res.status(403).json({ error: 'Dealer account is inactive' });
  }
  // --- END AUTHENTICATION (caller dealer on record) ---

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  var { stripeCustomerId, amount, dealerName, customerName, contractType, contractId } = req.body;

  if (!stripeCustomerId || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // --- STRIPE CUSTOMER OWNERSHIP CHECK ---
  if (!callerDealer.is_admin && stripeCustomerId !== callerDealer.stripe_customer_id) {
    return res.status(403).json({ error: 'You do not have access to charge this customer' });
  }
  // --- END OWNERSHIP ---

  try {
    var custRes = await fetch(
      'https://api.stripe.com/v1/customers/' + encodeURIComponent(stripeCustomerId),
      { headers: { Authorization: 'Bearer ' + secretKey } }
    );
    var cust = await custRes.json();
    if (!custRes.ok) {
      return res.status(400).json({ error: cust.error ? cust.error.message : 'Invalid customer' });
    }
    var defaultPm = cust.invoice_settings && cust.invoice_settings.default_payment_method;
    var paymentMethodId = typeof defaultPm === 'string' ? defaultPm : defaultPm && defaultPm.id;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'No default payment method on file for this customer.' });
    }

    var params = new URLSearchParams({
      amount: Math.round(Number(amount) * 100).toString(),
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: 'true',
      off_session: 'true',
      description: (dealerName || '') + ' — ' + (contractType || '') + ' contract for ' + (customerName || ''),
      'metadata[dealer]': dealerName || '',
      'metadata[customer]': customerName || '',
      'metadata[contract]': contractType || '',
      'metadata[contract_id]': contractId || ''
    });

    var piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var pi = await piRes.json();

    if (!piRes.ok) {
      return res.status(400).json({ error: pi.error ? pi.error.message : 'Payment failed' });
    }

    if (pi.status === 'succeeded') {
      return res.status(200).json({
        success: true,
        paymentIntentId: pi.id,
        amount: amount
      });
    }
    return res.status(400).json({
      error: 'Payment not completed. Status: ' + pi.status
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
