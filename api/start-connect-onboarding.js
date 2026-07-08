const { resolveCallerAccess } = require('./_caller-access.js');

/**
 * /api/start-connect-onboarding.js
 *
 * Phase 2.1 (SANDBOX). Dealer/principal-callable. Ensures an org-level Stripe
 * Connect Express account exists, then returns a Stripe-hosted onboarding link.
 *
 * Safety: uses STRIPE_CONNECT_SECRET_KEY (sandbox test key) ONLY. Never touches
 * STRIPE_SECRET_KEY (the live inbound key). Nothing here moves money.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var ANON = process.env.SUPABASE_ANON_KEY;
  var SERVICE = process.env.SUPABASE_SERVICE_KEY || ANON;
  var STRIPE = process.env.STRIPE_CONNECT_SECRET_KEY; // Connect key, NOT STRIPE_SECRET_KEY
  if (!SUPABASE_URL || !ANON || !STRIPE) {
    console.error('start-connect-onboarding: missing env (SUPABASE_URL / SUPABASE_ANON_KEY / STRIPE_CONNECT_SECRET_KEY)');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Verify JWT (same pattern as create-stripe-financial-connections-session.js)
  var jwt = (req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization' });

  var authUid;
  try {
    var uRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: ANON }
    });
    if (!uRes.ok) return res.status(401).json({ error: 'Invalid token' });
    var authUser = await uRes.json();
    authUid = authUser && authUser.id;
    if (!authUid) return res.status(401).json({ error: 'No user id in token' });
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

  var access;
  try {
    access = await resolveCallerAccess(SUPABASE_URL, SERVICE, authUid);
  } catch (e) {
    return res.status(500).json({ error: 'Could not resolve caller access' });
  }
  if (!access || !access.ok || !access.active) return res.status(403).json({ error: 'Not authorized' });

  var role = access.userRow && access.userRow.role;
  var allowed = access.isAdmin || role === 'principal' || role === 'org_admin' || !!access.dealerRow;
  // organizationId is only returned on the org-user branch of resolveCallerAccess.
  // Legacy dealers/admins fall back to the dealer row's organization_id.
  var orgId = access.organizationId || (access.dealerRow && access.dealerRow.organization_id);
  if (!allowed || !orgId) return res.status(403).json({ error: 'No organization for caller' });

  var stripeHeaders = {
    Authorization: 'Bearer ' + STRIPE,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  var supaHeaders = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE };

  // Read org -> reuse existing connected account or create one.
  var org;
  try {
    var orgRes = await fetch(
      SUPABASE_URL + '/rest/v1/organizations?id=eq.' + encodeURIComponent(orgId) + '&select=id,stripe_connect_account_id',
      { headers: supaHeaders }
    );
    var orgRows = await orgRes.json();
    org = Array.isArray(orgRows) && orgRows[0] ? orgRows[0] : null;
  } catch (e) {
    return res.status(500).json({ error: 'Org lookup failed' });
  }
  if (!org) return res.status(404).json({ error: 'Org not found' });

  var acct = org.stripe_connect_account_id;

  if (!acct) {
    try {
      var p = new URLSearchParams();
      p.append('type', 'express');
      p.append('country', 'US');
      p.append('capabilities[transfers][requested]', 'true'); // platform pays dealer -> transfers
      var aRes = await fetch('https://api.stripe.com/v1/accounts', {
        method: 'POST', headers: stripeHeaders, body: p.toString()
      });
      var a = await aRes.json();
      if (!aRes.ok) return res.status(400).json({ error: a.error ? a.error.message : 'Account create failed' });
      acct = a.id;

      // Persisting the acct id is REQUIRED: the connect webhook maps account.updated
      // back to the org via stripe_connect_account_id. If this fails, fail loud rather
      // than hand back a link for an account we can't track.
      var savRes = await fetch(
        SUPABASE_URL + '/rest/v1/organizations?id=eq.' + encodeURIComponent(orgId),
        {
          method: 'PATCH',
          headers: Object.assign({}, supaHeaders, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify({ stripe_connect_account_id: acct })
        }
      );
      if (!savRes.ok) {
        console.error('start-connect-onboarding: failed to persist acct id', savRes.status, await savRes.text());
        return res.status(500).json({ error: 'Failed to save connected account' });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Hosted onboarding link. Use the APEX vercel.app host: the www. variant has no valid
  // TLS cert (the *.vercel.app wildcard covers only one label), and apex serves /api/*
  // directly with no 307 redirect (verified against the live deployment).
  try {
    var base = 'https://whitestone-dealer-portal.vercel.app';
    var lp = new URLSearchParams();
    lp.append('account', acct);
    lp.append('type', 'account_onboarding');
    lp.append('refresh_url', base + '/?connect=refresh');
    lp.append('return_url', base + '/?connect=done');
    var lRes = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST', headers: stripeHeaders, body: lp.toString()
    });
    var link = await lRes.json();
    if (!lRes.ok) return res.status(400).json({ error: link.error ? link.error.message : 'Link create failed' });
    return res.status(200).json({ url: link.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
