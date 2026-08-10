/**
 * /api/crm-tasks.js
 *
 * Admin-only CRUD for CRM tasks.
 *   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD   list (optional date window)
 *   POST   { dealer_id, dealership_name, type, note, due_date, owner }
 *   PATCH  { id, ...fields }                update; status:'done' stamps completed_at
 *   DELETE ?id=<uuid>
 *
 * Reads/writes with the service key. crm_tasks has RLS on with no policies,
 * so this endpoint is the only way in.
 */

const { resolveCallerAccess } = require('./_caller-access.js');

const TYPES = ['email', 'call', 'followup', 'visit'];

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
    if (!authUid) return res.status(401).json({ error: 'No user id in token' });
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

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
  const base = SUPABASE_URL + '/rest/v1/crm_tasks';

  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  try {
    // ---------- LIST ----------
    if (req.method === 'GET') {
      let url = base + '?select=*&order=due_date.asc&limit=2000';
      const from = req.query && req.query.from;
      const to = req.query && req.query.to;
      if (isDate(from)) url += '&due_date=gte.' + from;
      if (isDate(to)) url += '&due_date=lte.' + to;
      const r = await fetch(url, { headers: svc });
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: 'Could not load tasks', detail: t.slice(0, 300) });
      }
      const rows = await r.json();
      return res.status(200).json({ ok: true, tasks: rows });
    }

    // ---------- CREATE ----------
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.dealer_id) return res.status(400).json({ error: 'dealer_id is required' });
      if (TYPES.indexOf(b.type) === -1) {
        return res.status(400).json({ error: 'type must be one of: ' + TYPES.join(', ') });
      }
      if (!isDate(b.due_date)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });

      // dealer_id must be a real, non-test dealer
      const dr = await fetch(
        SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(b.dealer_id) +
        '&select=id,dealership_name,dba_name,is_test&limit=1',
        { headers: svc }
      );
      const drows = await dr.json();
      if (!Array.isArray(drows) || !drows.length) {
        return res.status(400).json({ error: 'Unknown dealer_id' });
      }
      if (drows[0].is_test === true) {
        return res.status(400).json({ error: 'Cannot create a task on a test dealer' });
      }

      const payload = {
        dealer_id: b.dealer_id,
        dealership_name: b.dealership_name ||
          drows[0].dba_name || drows[0].dealership_name || null,
        type: b.type,
        note: (b.note || '').slice(0, 2000) || null,
        due_date: b.due_date,
        owner: (b.owner || '').slice(0, 120) || null,
        status: 'open',
        created_by: authUid
      };

      const r = await fetch(base, {
        method: 'POST',
        headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: 'Could not create task', detail: t.slice(0, 300) });
      }
      const created = await r.json();
      return res.status(200).json({ ok: true, task: created[0] });
    }

    // ---------- UPDATE ----------
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (!b.id) return res.status(400).json({ error: 'id is required' });

      const patch = { updated_at: new Date().toISOString() };
      if (b.type !== undefined) {
        if (TYPES.indexOf(b.type) === -1) return res.status(400).json({ error: 'bad type' });
        patch.type = b.type;
      }
      if (b.note !== undefined) patch.note = (b.note || '').slice(0, 2000) || null;
      if (b.owner !== undefined) patch.owner = (b.owner || '').slice(0, 120) || null;
      if (b.due_date !== undefined) {
        if (!isDate(b.due_date)) return res.status(400).json({ error: 'bad due_date' });
        patch.due_date = b.due_date;
      }
      if (b.status !== undefined) {
        if (b.status !== 'open' && b.status !== 'done') {
          return res.status(400).json({ error: 'status must be open or done' });
        }
        patch.status = b.status;
        patch.completed_at = (b.status === 'done') ? new Date().toISOString() : null;
      }

      const r = await fetch(base + '?id=eq.' + encodeURIComponent(b.id), {
        method: 'PATCH',
        headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
        body: JSON.stringify(patch)
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: 'Could not update task', detail: t.slice(0, 300) });
      }
      // PostgREST returns 200/204 even when zero rows matched — re-read to confirm.
      const updated = await r.json();
      if (!Array.isArray(updated) || !updated.length) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json({ ok: true, task: updated[0] });
    }

    // ---------- DELETE ----------
    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || '';
      if (!id) return res.status(400).json({ error: 'id is required' });
      const r = await fetch(base + '?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: Object.assign({}, svc, { Prefer: 'return=representation' })
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: 'Could not delete task', detail: t.slice(0, 300) });
      }
      const gone = await r.json();
      if (!Array.isArray(gone) || !gone.length) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('crm-tasks error:', e && e.message);
    return res.status(500).json({ error: 'Task operation failed', detail: e && e.message });
  }
}

module.exports = handler;
