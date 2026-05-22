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
    console.error('create-stripe-financial-connections-session: SUPABASE env vars missing');
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
    console.error('create-stripe-financial-connections-session: JWT verification failed', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var authUid = authUser && authUser.id;
  if (!authUid) {
    return res.status(401).json({ error: 'No user id in token' });
  }

  var callerDealer;
  try {
    var dealerRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid) + '&select=id,is_admin,active,dealership_name,email,stripe_customer_id',
      { headers: { apikey: supabaseServiceKey, Authorization: 'Bearer ' + supabaseServiceKey } }
    );
    var dealerRows = await dealerRes.json();
    if (!Array.isArray(dealerRows) || dealerRows.length === 0) {
      return res.status(403).json({ error: 'No dealer record for this user' });
    }
    callerDealer = dealerRows[0];
  } catch (err) {
    console.error('create-stripe-financial-connections-session: dealer lookup failed', err);
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

  var { dealerId } = req.body || {};

  // --- DEALER OWNERSHIP CHECK ---
  // If a dealerId is passed, it must match the caller (unless admin).
  // If no dealerId is passed, default to the caller's own dealer id.
  var targetDealerId = dealerId || callerDealer.id;
  if (!callerDealer.is_admin && String(targetDealerId) !== String(callerDealer.id)) {
    return res.status(403).json({ error: 'You do not have access to link a bank account for this dealer' });
  }
  // --- END OWNERSHIP ---

  try {
    var customerId = callerDealer.stripe_customer_id;

    // If no Stripe customer yet, create one. Bank link can happen before card-on-file.
    if (!customerId) {
      var customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + secretKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          name: callerDealer.dealership_name || '',
          email: callerDealer.email || '',
          'metadata[dealer_id]': String(callerDealer.id)
        }).toString()
      });
      var customer = await customerRes.json();
      if (!customerRes.ok) {
        return res.status(400).json({ error: customer.error ? customer.error.message : 'Failed to create customer' });
      }
      customerId = customer.id;

      // Persist the new customer id back to the dealers row so future calls reuse it.
      try {
        await fetch(
          supabaseUrl + '/rest/v1/dealers?id=eq.' + encodeURIComponent(callerDealer.id),
          {
            method: 'PATCH',
            headers: {
              apikey: supabaseServiceKey,
              Authorization: 'Bearer ' + supabaseServiceKey,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({ stripe_customer_id: customerId })
          }
        );
      } catch (patchErr) {
        console.error('create-stripe-financial-connections-session: failed to persist stripe_customer_id', patchErr);
        // Non-fatal. The session was created; the next call will create a new customer if this didn't persist.
      }
    }

    // Create the Financial Connections Session.
    // permissions=payment_method gives us a us_bank_account payment method we can charge via ACH.
    var sessionParams = new URLSearchParams();
    sessionParams.append('account_holder[type]', 'customer');
    sessionParams.append('account_holder[customer]', customerId);
    sessionParams.append('permissions[]', 'payment_method');
    sessionParams.append('filters[countries][]', 'US');

    var sessionRes = await fetch('https://api.stripe.com/v1/financial_connections/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: sessionParams.toString()
    });
    var session = await sessionRes.json();
    if (!sessionRes.ok) {
      return res.status(400).json({ error: session.error ? session.error.message : 'Failed to create Financial Connections session' });
    }

    return res.status(200).json({
      success: true,
      clientSecret: session.client_secret,
      customerId: customerId,
      sessionId: session.id
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
