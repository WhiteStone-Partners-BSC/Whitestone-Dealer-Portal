export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // --- AUTH GATE: caller must be an admin (matches create-stripe-customer.js style) ---
  var authHeader = req.headers.authorization || req.headers.Authorization || '';
  var jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization header' });

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  var supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error('create-org-and-principal: env missing');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Verify caller token
  var authUser;
  try {
    var verifyRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: supabaseAnonKey }
    });
    if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    authUser = await verifyRes.json();
  } catch (err) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
  var callerAuthUid = authUser && authUser.id;
  if (!callerAuthUid) return res.status(401).json({ error: 'No user id in token' });

  // Confirm caller is an admin (look up dealers row by auth_id, is_admin=true)
  var svcHeaders = {
    apikey: supabaseServiceKey,
    Authorization: 'Bearer ' + supabaseServiceKey,
    'Content-Type': 'application/json'
  };
  try {
    var callerRes = await fetch(
      supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(callerAuthUid) + '&select=is_admin&limit=1',
      { headers: svcHeaders }
    );
    var callerRows = await callerRes.json();
    if (!Array.isArray(callerRows) || !callerRows[0] || callerRows[0].is_admin !== true) {
      return res.status(403).json({ error: 'Admin only' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Caller check failed' });
  }

  // --- INPUT ---
  var body = req.body || {};
  var dealerId = body.dealerId;          // the newly-created dealer row (becomes first location)
  var dealerAuthId = body.dealerAuthId;  // the dealer's auth account (becomes principal user)
  var orgName = body.orgName;            // dealership name
  var email = body.email;
  var fullName = body.fullName || null;
  if (!dealerId || !dealerAuthId || !orgName || !email) {
    return res.status(400).json({ error: 'Missing dealerId, dealerAuthId, orgName, or email' });
  }

  try {
    // 1. Create organization (principal_user_id null for now — FK cycle)
    var orgRes = await fetch(supabaseUrl + '/rest/v1/organizations', {
      method: 'POST',
      headers: Object.assign({}, svcHeaders, { Prefer: 'return=representation' }),
      body: JSON.stringify({ name: orgName, status: 'active', principal_user_id: null })
    });
    if (!orgRes.ok) {
      return res.status(500).json({ error: 'Org create failed: ' + (await orgRes.text()).slice(0,200) });
    }
    var orgRows = await orgRes.json();
    var orgId = Array.isArray(orgRows) && orgRows[0] ? orgRows[0].id : null;
    if (!orgId) return res.status(500).json({ error: 'Org created but no id' });

    // 2. Create principal user (same auth_id as the dealer login)
    var userRes = await fetch(supabaseUrl + '/rest/v1/users', {
      method: 'POST',
      headers: Object.assign({}, svcHeaders, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        auth_id: dealerAuthId,
        organization_id: orgId,
        email: email,
        full_name: fullName,
        role: 'principal',
        status: 'active'
      })
    });
    if (!userRes.ok) {
      return res.status(500).json({ error: 'User create failed: ' + (await userRes.text()).slice(0,200) });
    }
    var userRows = await userRes.json();
    var userId = Array.isArray(userRows) && userRows[0] ? userRows[0].id : null;
    if (!userId) return res.status(500).json({ error: 'User created but no id' });

    // 3. Set dealer row's organization_id (dealer = first location of the org)
    var dPatch = await fetch(
      supabaseUrl + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId),
      { method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ organization_id: orgId }) }
    );
    if (!dPatch.ok) {
      return res.status(500).json({ error: 'Dealer org link failed: ' + (await dPatch.text()).slice(0,200) });
    }

    // 4. Set org's principal_user_id (closes the FK cycle)
    var oPatch = await fetch(
      supabaseUrl + '/rest/v1/organizations?id=eq.' + encodeURIComponent(orgId),
      { method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ principal_user_id: userId }) }
    );
    if (!oPatch.ok) {
      return res.status(500).json({ error: 'Principal link failed: ' + (await oPatch.text()).slice(0,200) });
    }

    return res.status(200).json({ success: true, organizationId: orgId, principalUserId: userId });
  } catch (err) {
    console.error('create-org-and-principal: error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
