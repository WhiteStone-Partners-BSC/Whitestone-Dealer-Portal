export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTH GATE (matches create-stripe-customer.js) ---
  var authHeader = req.headers.authorization || req.headers.Authorization || '';
  var jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  var supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error('clear-must-set-password: SUPABASE env vars missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Verify the caller's token -> get their auth uid
  var authUser;
  try {
    var verifyRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: supabaseAnonKey }
    });
    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    authUser = await verifyRes.json();
  } catch (err) {
    console.error('clear-must-set-password: JWT verify failed', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var authUid = authUser && authUser.id;
  if (!authUid) {
    return res.status(401).json({ error: 'No user id in token' });
  }

  // Flip the flag on the caller's OWN row, using the service key (bypasses RLS safely).
  try {
    var patchRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid),
      {
        method: 'PATCH',
        headers: {
          apikey: supabaseServiceKey,
          Authorization: 'Bearer ' + supabaseServiceKey,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({ must_set_password: false })
      }
    );
    if (!patchRes.ok) {
      var t = await patchRes.text();
      console.error('clear-must-set-password: PATCH failed', t);
      return res.status(500).json({ error: 'Could not update flag' });
    }
    var rows = await patchRes.json();
    // Re-read guard: confirm it actually flipped (don't trust status alone)
    if (!Array.isArray(rows) || !rows[0] || rows[0].must_set_password !== false) {
      return res.status(500).json({ error: 'Flag not cleared' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('clear-must-set-password: error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
