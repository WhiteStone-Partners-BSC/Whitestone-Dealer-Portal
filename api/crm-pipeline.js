/**
 * /api/crm-pipeline.js
 *
 * Read-only admin endpoint. Returns the dealer prospect pipeline, stitched from
 * dealers + dealer_box_scans + dealer_enrollments + dealer_inquiries + dealer_applications.
 *
 * Groups duplicate dealer rows by normalized dealership name, because promoting an
 * enrollment to an application currently creates a SECOND dealers row via
 * created_dealer_id rather than linking to the original.
 *
 * Auth: admin only. Reads with the service key (dealers is never exposed to anon).
 * Writes nothing.
 */

const { resolveCallerAccess } = require('./_caller-access.js');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE = process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured (supabase)' });
  }

  // --- Verify JWT ---
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

  // --- Admin gate ---
  let access;
  try {
    access = await resolveCallerAccess(SUPABASE_URL, SERVICE, authUid);
  } catch (e) {
    return res.status(500).json({ error: 'Could not resolve caller access' });
  }
  if (!access || !access.ok || access.isAdmin !== true) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const svc = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE };

  async function get(path) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: svc });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(path.split('?')[0] + ' -> ' + r.status + ' ' + body.slice(0, 200));
    }
    return r.json();
  }

  try {
    // --- Real prospects only ---
    const dealers = await get(
      'dealers?is_test=eq.false&is_admin=eq.false' +
      '&select=id,dealership_name,legal_business_name,dba_name,contact_first_name,' +
      'contact_last_name,contact_title,email,phone,city,state,website,boat_brands,' +
      'service_volume,active,created_at,dealer_number' +
      '&order=created_at.asc&limit=2000'
    );

    const realIds = {};
    dealers.forEach(function (d) { realIds[d.id] = true; });

    const [scans, enrollments, inquiries, applications] = await Promise.all([
      get('dealer_box_scans?select=dealer_id,scanned_at,is_first_scan&order=scanned_at.asc&limit=5000'),
      get('dealer_enrollments?select=dealer_id,submitter_name,submitter_email,submitter_phone,dealership_name,message,submitted_at,status,agreement_sent_at,agreement_signed_at,activated_at,notes&order=submitted_at.asc&limit=2000'),
      get('dealer_inquiries?select=dealer_id,submitter_name,submitter_email,submitter_phone,comment,submitted_at,responded_at,response_notes&order=submitted_at.asc&limit=2000'),
      get('dealer_applications?select=created_dealer_id,dealership_name,contact_name,contact_first_name,contact_last_name,contact_title,email,phone,city,state,status,referral_source,notes,created_at,reviewed_at&order=created_at.asc&limit=2000')
    ]);

    // --- Group duplicate dealers rows by normalized name ---
    function normName(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(llc|inc|co|company|corp|the)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const groups = {};
    dealers.forEach(function (d) {
      const display = d.dba_name || d.dealership_name || d.legal_business_name || '(unnamed)';
      const key = normName(display) || ('id:' + d.id);
      if (!groups[key]) {
        groups[key] = {
          key: key,
          name: display,
          dealer_ids: [],
          rows: [],
          active: false,
          created_at: d.created_at,
          contact: {},
          events: []
        };
      }
      const g = groups[key];
      g.dealer_ids.push(d.id);
      g.rows.push(d);
      if (d.active === true) g.active = true;
      if (d.created_at && d.created_at < g.created_at) g.created_at = d.created_at;
      if (String(display).length > String(g.name).length) g.name = display;

      // First non-empty value wins for each contact field
      ['contact_first_name', 'contact_last_name', 'contact_title', 'email', 'phone',
       'city', 'state', 'website', 'boat_brands', 'service_volume', 'dealer_number'
      ].forEach(function (f) {
        if (!g.contact[f] && d[f]) g.contact[f] = d[f];
      });
    });

    function groupForDealerId(id) {
      if (!id) return null;
      const keys = Object.keys(groups);
      for (let i = 0; i < keys.length; i++) {
        if (groups[keys[i]].dealer_ids.indexOf(id) !== -1) return groups[keys[i]];
      }
      return null;
    }

    // --- Attach activity ---
    scans.forEach(function (s) {
      if (!realIds[s.dealer_id]) return;
      const g = groupForDealerId(s.dealer_id);
      if (!g) return;
      g.events.push({ type: 'scan', at: s.scanned_at, label: s.is_first_scan ? 'First box scan' : 'Box scanned' });
    });

    enrollments.forEach(function (e) {
      if (!realIds[e.dealer_id]) return;
      const g = groupForDealerId(e.dealer_id);
      if (!g) return;
      g.events.push({
        type: 'enrollment',
        at: e.submitted_at || e.created_at,
        label: 'Enrollment form submitted',
        detail: e.message || '',
        person: e.submitter_name || '',
        email: e.submitter_email || '',
        phone: e.submitter_phone || ''
      });
      if (!g.contact.email && e.submitter_email) g.contact.email = e.submitter_email;
      if (!g.contact.phone && e.submitter_phone) g.contact.phone = e.submitter_phone;
    });

    inquiries.forEach(function (q) {
      if (!realIds[q.dealer_id]) return;
      const g = groupForDealerId(q.dealer_id);
      if (!g) return;
      g.events.push({
        type: 'inquiry',
        at: q.submitted_at,
        label: q.responded_at ? 'Inquiry (responded)' : 'Inquiry submitted',
        detail: q.comment || '',
        person: q.submitter_name || '',
        email: q.submitter_email || '',
        phone: q.submitter_phone || ''
      });
      if (!g.contact.email && q.submitter_email) g.contact.email = q.submitter_email;
      if (!g.contact.phone && q.submitter_phone) g.contact.phone = q.submitter_phone;
    });

    applications.forEach(function (a) {
      const g = groupForDealerId(a.created_dealer_id) ||
                (groups[normName(a.dealership_name)] || null);
      if (!g) return;
      g.events.push({
        type: 'application',
        at: a.created_at,
        label: 'Application (' + (a.status || 'no status') + ')',
        detail: a.notes || '',
        person: a.contact_name || ((a.contact_first_name || '') + ' ' + (a.contact_last_name || '')).trim(),
        email: a.email || '',
        phone: a.phone || '',
        referral_source: a.referral_source || ''
      });
      g.lastAppStatus = a.status || g.lastAppStatus;
      if (!g.contact.email && a.email) g.contact.email = a.email;
      if (!g.contact.phone && a.phone) g.contact.phone = a.phone;
      if (!g.contact.city && a.city) g.contact.city = a.city;
      if (!g.contact.state && a.state) g.contact.state = a.state;
    });

    // --- Derive metrics + stage ---
    const now = Date.now();
    const DAY = 86400000;

    const out = Object.keys(groups).map(function (k) {
      const g = groups[k];
      g.events.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });

      const scanEvents = g.events.filter(function (e) { return e.type === 'scan'; });
      const dayset = {};
      scanEvents.forEach(function (e) { dayset[String(e.at || '').slice(0, 10)] = true; });
      const scanDays = Object.keys(dayset).length;

      const enrollCount = g.events.filter(function (e) { return e.type === 'enrollment'; }).length;
      const inquiryCount = g.events.filter(function (e) { return e.type === 'inquiry'; }).length;
      const appCount = g.events.filter(function (e) { return e.type === 'application'; }).length;

      const lastAt = g.events.length ? g.events[0].at : g.created_at;
      const daysSince = lastAt ? Math.floor((now - new Date(lastAt).getTime()) / DAY) : null;

      // Stage is INFERRED from available signals. Replace once Carson supplies real stages.
      let stage = 'New';
      if (g.active) stage = 'Active dealer';
      else if (g.lastAppStatus === 'agreement_sent') stage = 'Agreement sent';
      else if (appCount > 0) stage = 'Applied';
      else if (enrollCount > 0) stage = 'Enrolled';
      else if (inquiryCount > 0) stage = 'Inquired';
      else if (scanDays > 0) stage = 'Engaged';
      else stage = 'Mailed / no activity';

      // Heat: distinct scan DAYS, not raw scans — two taps five seconds apart is one visit.
      let heat = scanDays * 10 + enrollCount * 25 + inquiryCount * 20 + appCount * 15;
      if (daysSince !== null) {
        if (daysSince <= 14) heat += 30;
        else if (daysSince <= 30) heat += 20;
        else if (daysSince <= 60) heat += 10;
      }

      const engagedNoAction = scanDays > 0 && enrollCount === 0 && inquiryCount === 0 && appCount === 0;

      return {
        key: g.key,
        name: g.name,
        dealer_ids: g.dealer_ids,
        canonical_dealer_id: g.dealer_ids[0],
        duplicate_rows: g.dealer_ids.length,
        stage: stage,
        active: g.active,
        heat: heat,
        scan_count: scanEvents.length,
        scan_days: scanDays,
        first_scan: scanEvents.length ? scanEvents[scanEvents.length - 1].at : null,
        last_scan: scanEvents.length ? scanEvents[0].at : null,
        enrollment_count: enrollCount,
        inquiry_count: inquiryCount,
        application_count: appCount,
        last_app_status: g.lastAppStatus || null,
        last_activity_at: lastAt,
        days_since_activity: daysSince,
        needs_followup: engagedNoAction,
        contact: g.contact,
        created_at: g.created_at,
        events: g.events.slice(0, 50)
      };
    });

    out.sort(function (a, b) {
      if (b.heat !== a.heat) return b.heat - a.heat;
      return String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || ''));
    });

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      counts: {
        prospects: out.length,
        needs_followup: out.filter(function (p) { return p.needs_followup; }).length,
        engaged: out.filter(function (p) { return p.scan_days > 0; }).length,
        active_dealers: out.filter(function (p) { return p.active; }).length
      },
      prospects: out
    });
  } catch (e) {
    console.error('crm-pipeline error:', e && e.message);
    if (String(e && e.message).indexOf('is_test') !== -1) {
      return res.status(500).json({
        error: 'dealers.is_test column missing — run CRM Phase 1a first',
        detail: e.message
      });
    }
    return res.status(500).json({ error: 'Pipeline load failed', detail: e && e.message });
  }
}

module.exports = handler;
