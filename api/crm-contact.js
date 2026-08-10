/**
 * /api/crm-contact.js
 *
 * Admin-only PATCH of contact details on a prospect's dealers row.
 * Exists because box-recipient rows were created without email or phone,
 * so an "email" task has nowhere to go until someone can fill it in.
 *
 * SAFETY: refuses to edit a row that has an auth_id (a real login account).
 * Those are edited through Settings, not the CRM — changing the email on a
 * live login is an auth change, not a CRM change.
 */

const { resolveCallerAccess } = require('./_caller-access.js');

const EDITABLE = [
  'contact_first_name', 'contact_last_name', 'contact_title',
  'email', 'phone', 'city', 'state', 'website', 'boat_brands', 'service_volume'
];

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE = process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured (supabase)' });
  }

  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();

  let authUid;
  try {
    const vr = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: SUPABASE_ANON_KEY }
    });
    if (!vr.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    const au = await vr.json();
    authUid = au && au.id;
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
  if (!authUid) return res.status(401).json({ error: 'No user id in token' });

  let access;
  try {
    access = await resolveCallerAccess(SUPABASE_URL, SERVICE, authUid);
  } catch (e) {
    return res.status(500).json({ error: 'Could not resolve caller access' });
  }
  if (!access || !access.ok || access.isAdmin !== true) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const svc = {
    apikey: SERVICE,
    Authorization: 'Bearer ' + SERVICE,
    'Content-Type': 'application/json'
  };

  try {
    const b = await readBody(req);
    if (!b.dealer_id) return res.status(400).json({ error: 'dealer_id is required' });

    const dr = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(b.dealer_id) +
      '&select=id,auth_id,is_test,is_admin&limit=1',
      { headers: svc }
    );
    const rows = await dr.json();
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).json({ error: 'Unknown dealer_id' });
    }
    if (rows[0].is_admin === true) {
      return res.status(400).json({ error: 'Cannot edit an admin record here' });
    }
    if (rows[0].auth_id) {
      return res.status(400).json({
        error: 'This dealer has a login account. Edit their details in Dealers / Settings instead.'
      });
    }

    const patch = {};
    EDITABLE.forEach(function (f) {
      if (b[f] !== undefined) patch[f] = (String(b[f] || '').trim().slice(0, 300)) || null;
    });
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No editable fields supplied' });
    }

    const r = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(b.dealer_id),
      {
        method: 'PATCH',
        headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
        body: JSON.stringify(patch)
      }
    );
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: 'Could not update contact', detail: t.slice(0, 300) });
    }
    // Re-read: PostgREST reports success even when zero rows were affected.
    const updated = await r.json();
    if (!Array.isArray(updated) || !updated.length) {
      return res.status(404).json({ error: 'No row updated' });
    }
    return res.status(200).json({ ok: true, dealer: updated[0] });
  } catch (e) {
    console.error('crm-contact error:', e && e.message);
    return res.status(500).json({ error: 'Contact update failed', detail: e && e.message });
  }
}

module.exports = handler;
