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
    console.error('create-stripe-customer: SUPABASE env vars missing');
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
    console.error('create-stripe-customer: JWT verification failed', err);
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
    console.error('create-stripe-customer: dealer lookup failed', err);
    return res.status(500).json({ error: 'Could not verify caller' });
  }

  if (!callerDealer.active) {
    return res.status(403).json({ error: 'Dealer account is inactive' });
  }
  // --- END AUTHENTICATION ---

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  var { dealerName, email, paymentMethodId, dealerId, existingCustomerId } = req.body;

  if (!paymentMethodId || !dealerId) {
    return res.status(400).json({ error: 'Missing paymentMethodId or dealerId' });
  }
  if (!existingCustomerId && (!dealerName || !email)) {
    return res.status(400).json({ error: 'Missing dealerName or email (required when no existingCustomerId)' });
  }

  // --- DEALER OWNERSHIP CHECK ---
  if (!callerDealer.is_admin && String(dealerId) !== String(callerDealer.id)) {
    return res.status(403).json({ error: 'You do not have access to create a Stripe customer for this dealer' });
  }
  // --- END OWNERSHIP ---

  try {
    var customer;
    if (existingCustomerId) {
      // Reuse the customer created by the Financial Connections session.
      var lookupRes = await fetch('https://api.stripe.com/v1/customers/' + encodeURIComponent(existingCustomerId), {
        headers: { 'Authorization': 'Bearer ' + secretKey }
      });
      customer = await lookupRes.json();
      if (!lookupRes.ok) return res.status(400).json({ error: customer });
    } else {
      var customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + secretKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          name: dealerName,
          email: email,
          'metadata[dealer_id]': dealerId || ''
        }).toString()
      });
      customer = await customerRes.json();
      if (!customerRes.ok) return res.status(400).json({ error: customer });
    }

    var attachRes = await fetch('https://api.stripe.com/v1/payment_methods/' + paymentMethodId + '/attach', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ customer: customer.id }).toString()
    });
    var attached = await attachRes.json();
    if (!attachRes.ok) return res.status(400).json({ error: attached });

    await fetch('https://api.stripe.com/v1/customers/' + customer.id, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'invoice_settings[default_payment_method]': paymentMethodId
      }).toString()
    });

    return res.status(200).json({
      success: true,
      customerId: customer.id,
      paymentMethodId: paymentMethodId
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
