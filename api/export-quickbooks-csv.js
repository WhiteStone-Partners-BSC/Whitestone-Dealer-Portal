/**
 * /api/export-quickbooks-csv.js
 *
 * Read-only admin endpoint. Generates QuickBooks Online bank-import CSV
 * for income (paid invoice_items) or expenses (paid reimbursements).
 *
 * Query params:
 *   type  = 'income' | 'expenses'  (required)
 *   start = YYYY-MM-DD             (optional, inclusive)
 *   end   = YYYY-MM-DD             (optional, inclusive)
 *
 * Auth: admin only (same JWT + is_admin gate as other admin endpoints).
 * Returns: text/csv with Content-Disposition attachment.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- Parse query ---
  const type = (req.query && req.query.type) || '';
  const start = (req.query && req.query.start) || '';
  const end = (req.query && req.query.end) || '';

  if (type !== 'income' && type !== 'expenses') {
    return res.status(400).json({ error: "type must be 'income' or 'expenses'" });
  }

  // --- Auth gate (admin only) ---
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured (supabase)' });
  }

  // Verify JWT
  let callerAuthUid;
  try {
    const verifyRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + jwt, apikey: SUPABASE_ANON_KEY }
    });
    if (!verifyRes.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    const authUser = await verifyRes.json();
    callerAuthUid = authUser && authUser.id;
    if (!callerAuthUid) return res.status(401).json({ error: 'No user id in token' });
  } catch (e) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

  // Verify caller is admin
  try {
    const callerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(callerAuthUid) + '&select=id,is_admin,active',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const rows = await callerRes.json();
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0].is_admin || !rows[0].active) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Could not verify admin' });
  }

  // --- CSV helpers ---
  function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  function dateOnly(ts) {
    if (!ts) return '';
    // ts may be a date or timestamptz; take the YYYY-MM-DD portion
    return String(ts).slice(0, 10);
  }

  // --- Build the query + CSV per type ---
  try {
    let rows = [];
    let csvLines = ['Date,Description,Amount'];

    if (type === 'income') {
      // invoice_items: status=paid, optional paid_at range
      let q = SUPABASE_URL + '/rest/v1/invoice_items?status=eq.paid'
        + '&select=paid_at,wholesale_price,contract_type,dealership_name,payment_method,contract_id'
        + '&order=paid_at.asc';
      if (start) q += '&paid_at=gte.' + encodeURIComponent(start);
      if (end) q += '&paid_at=lte.' + encodeURIComponent(end + 'T23:59:59');

      const r = await fetch(q, { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
      rows = await r.json();
      if (!Array.isArray(rows)) rows = [];

      rows.forEach(function(row) {
        const date = dateOnly(row.paid_at);
        const desc = 'Contract ' + (row.contract_type || '') + ' - ' + (row.dealership_name || 'Unknown dealer')
          + ' (' + (row.payment_method || 'n/a') + ') [' + (row.contract_id || '') + ']';
        const amount = Number(row.wholesale_price || 0).toFixed(2);
        csvLines.push([csvEscape(date), csvEscape(desc), csvEscape(amount)].join(','));
      });

    } else {
      // expenses: reimbursements status=paid, optional paid_date range
      let q = SUPABASE_URL + '/rest/v1/reimbursements?status=eq.paid'
        + '&select=paid_date,amount,dealership_name,ticket_id,notes'
        + '&order=paid_date.asc';
      if (start) q += '&paid_date=gte.' + encodeURIComponent(start);
      if (end) q += '&paid_date=lte.' + encodeURIComponent(end);

      const r = await fetch(q, { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
      rows = await r.json();
      if (!Array.isArray(rows)) rows = [];

      rows.forEach(function(row) {
        const date = dateOnly(row.paid_date);
        let desc = 'Reimbursement - ' + (row.dealership_name || 'Unknown dealer') + ' [' + (row.ticket_id || '') + ']';
        if (row.notes) desc += ' - ' + row.notes;
        // money OUT -> negative
        const amount = (-Math.abs(Number(row.amount || 0))).toFixed(2);
        csvLines.push([csvEscape(date), csvEscape(desc), csvEscape(amount)].join(','));
      });
    }

    const csv = csvLines.join('\n');
    const filename = 'whitestone-quickbooks-' + type
      + (start ? '-' + start : '')
      + (end ? '-to-' + end : '')
      + '.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    return res.status(200).send(csv);

  } catch (e) {
    console.error('export-quickbooks-csv error:', e && e.message);
    return res.status(500).json({ error: 'Export failed', detail: e && e.message });
  }
};
