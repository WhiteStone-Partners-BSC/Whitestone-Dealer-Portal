/* ============================================================
   Whitestone Admin — CRM Pipeline (Phase 1, read-only)
   Depends on globals from dealer-portal.js: currentDealer, authHeaders()
   ============================================================ */
(function () {
  'use strict';

  var crmData = null;
  var crmFilter = 'all';
  var crmSearch = '';
  var crmOpenKey = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function ago(days) {
    if (days === null || days === undefined) return '—';
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 60) return days + ' days ago';
    return Math.round(days / 30) + ' months ago';
  }

  var STAGE_COLORS = {
    'Active dealer':        '#1f7a4d',
    'Agreement sent':       '#b8963e',
    'Applied':              '#2c6a9b',
    'Enrolled':             '#2c6a9b',
    'Inquired':             '#6b5ea8',
    'Engaged':              '#c07a2a',
    'Mailed / no activity': '#8a8a8a',
    'New':                  '#8a8a8a'
  };

  function stagePill(stage) {
    var c = STAGE_COLORS[stage] || '#8a8a8a';
    return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;' +
      'font-size:11px;font-weight:600;letter-spacing:0.02em;color:#fff;background:' + c + ';">' +
      esc(stage) + '</span>';
  }

  function emptyRow(msg) {
    return '<tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--light);' +
      'font-size:13px;">' + esc(msg) + '</td></tr>';
  }

  window.crmLoadPipeline = async function crmLoadPipeline(force) {
    if (!window.currentDealer || !window.currentDealer.isAdmin) return;
    var loadEl = document.getElementById('crm-loading');
    var tbody = document.getElementById('crm-tbody');
    if (crmData && !force) { crmRender(); return; }
    if (loadEl) loadEl.style.display = 'block';
    if (tbody) tbody.innerHTML = '';

    try {
      var resp = await fetch('/api/crm-pipeline', { headers: authHeaders() });
      var json = await resp.json();
      if (loadEl) loadEl.style.display = 'none';
      if (!resp.ok || !json.ok) {
        if (tbody) tbody.innerHTML = emptyRow(json.error || 'Could not load the pipeline.');
        return;
      }
      crmData = json;
      crmRender();
    } catch (e) {
      if (loadEl) loadEl.style.display = 'none';
      if (tbody) tbody.innerHTML = emptyRow('Could not reach the pipeline endpoint.');
      console.error('crmLoadPipeline', e);
    }
  };

  function crmVisible() {
    if (!crmData) return [];
    var list = crmData.prospects.slice();
    if (crmFilter === 'followup') list = list.filter(function (p) { return p.needs_followup; });
    else if (crmFilter === 'engaged') list = list.filter(function (p) { return p.scan_days > 0; });
    else if (crmFilter === 'active') list = list.filter(function (p) { return p.active; });
    if (crmSearch) {
      var q = crmSearch.toLowerCase();
      list = list.filter(function (p) {
        return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
               ((p.contact && p.contact.email) || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  function crmRender() {
    if (!crmData) return;
    var c = crmData.counts;
    var stats = document.getElementById('crm-stats');
    if (stats) {
      stats.innerHTML =
        statBox(c.prospects, 'Prospects') +
        statBox(c.needs_followup, 'Need follow-up') +
        statBox(c.engaged, 'Have engaged') +
        statBox(c.active_dealers, 'Active dealers');
    }

    document.querySelectorAll('#crm-filters .crm-filter-btn').forEach(function (b) {
      b.style.background = (b.getAttribute('data-crm-filter') === crmFilter) ? '#0c1e2e' : '#fff';
      b.style.color = (b.getAttribute('data-crm-filter') === crmFilter) ? '#fff' : '#0c1e2e';
    });

    var tbody = document.getElementById('crm-tbody');
    if (!tbody) return;
    var list = crmVisible();
    if (!list.length) { tbody.innerHTML = emptyRow('No prospects match this filter.'); return; }

    var html = '';
    list.forEach(function (p) {
      var flag = p.needs_followup
        ? '<span title="Engaged but never submitted anything" style="color:#c0392b;font-weight:700;">&#9679;</span> '
        : '';
      html +=
        '<tr class="admin-mc-summary" data-crm-key="' + esc(p.key) + '" ' +
        'style="cursor:pointer;" ' +
        'onmouseover="this.style.background=\'#f8f9fb\'" onmouseout="this.style.background=\'\'">' +
          '<td>' + flag + '<strong>' + esc(p.name) + '</strong>' +
            (p.duplicate_rows > 1
              ? '<div style="font-size:11px;color:var(--light);">' + p.duplicate_rows + ' merged records</div>'
              : '') +
          '</td>' +
          '<td>' + stagePill(p.stage) + '</td>' +
          '<td>' + (p.scan_days || 0) + (p.scan_count > p.scan_days ? ' <span style="color:var(--light);font-size:11px;">(' + p.scan_count + ' taps)</span>' : '') + '</td>' +
          '<td>' + fmtDate(p.last_scan) + '</td>' +
          '<td>' + ago(p.days_since_activity) + '</td>' +
          '<td>' + esc((p.contact && (p.contact.city || p.contact.state)) ? [p.contact.city, p.contact.state].filter(Boolean).join(', ') : '—') + '</td>' +
          '<td>' + (p.contact && p.contact.email
            ? '<a href="mailto:' + esc(p.contact.email) + '" onclick="event.stopPropagation();" style="color:#2c6a9b;">Email</a>'
            : '<span style="color:var(--light);">no email</span>') + '</td>' +
        '</tr>';
      if (crmOpenKey === p.key) html += detailRow(p);
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('tr[data-crm-key]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var k = tr.getAttribute('data-crm-key');
        crmOpenKey = (crmOpenKey === k) ? null : k;
        crmRender();
      });
    });
  }

  function statBox(n, label) {
    return '<div style="text-align:center;padding:0 1.5rem;">' +
      '<div style="font-size:30px;font-weight:600;color:#0c1e2e;line-height:1;">' + n + '</div>' +
      '<div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--light);margin-top:6px;">' +
      esc(label) + '</div></div>';
  }

  function detailRow(p) {
    var ct = p.contact || {};
    var person = [ct.contact_first_name, ct.contact_last_name].filter(Boolean).join(' ');
    var lines = '';
    if (person) lines += kv('Contact', person + (ct.contact_title ? ' — ' + ct.contact_title : ''));
    if (ct.email) lines += kv('Email', '<a href="mailto:' + esc(ct.email) + '" style="color:#2c6a9b;">' + esc(ct.email) + '</a>');
    if (ct.phone) lines += kv('Phone', '<a href="tel:' + esc(ct.phone) + '" style="color:#2c6a9b;">' + esc(ct.phone) + '</a>');
    if (ct.website) lines += kv('Website', esc(ct.website));
    if (ct.boat_brands) lines += kv('Brands', esc(ct.boat_brands));
    if (ct.service_volume) lines += kv('Service volume', esc(ct.service_volume));
    if (!lines) lines = '<div style="color:var(--light);font-size:13px;">No contact details on file.</div>';

    var tl = '';
    (p.events || []).forEach(function (e) {
      tl += '<div style="padding:8px 0;border-bottom:1px solid #eee;">' +
        '<div style="font-size:12px;color:var(--light);">' + fmtDate(e.at) + '</div>' +
        '<div style="font-size:13px;">' + esc(e.label) +
        (e.person ? ' — ' + esc(e.person) : '') + '</div>' +
        (e.detail ? '<div style="font-size:12px;color:#555;margin-top:3px;">' + esc(e.detail) + '</div>' : '') +
        '</div>';
    });
    if (!tl) tl = '<div style="color:var(--light);font-size:13px;">No recorded activity.</div>';

    var mailto = ct.email
      ? '<a href="mailto:' + esc(ct.email) +
        '?subject=' + encodeURIComponent('Whitestone Partners — ' + p.name) +
        '" style="display:inline-block;margin-top:14px;background:#0c1e2e;color:#fff;padding:9px 18px;' +
        'border-radius:6px;text-decoration:none;font-size:12px;letter-spacing:0.08em;' +
        'text-transform:uppercase;">Open email</a>'
      : '';

    return '<tr class="admin-mc-expand"><td colspan="7" style="background:#fafbfc;padding:1.5rem;">' +
      '<div style="display:flex;gap:2.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:260px;">' +
          '<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--light);margin-bottom:10px;">Contact</div>' +
          lines + mailto +
        '</div>' +
        '<div style="flex:1.4;min-width:300px;">' +
          '<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--light);margin-bottom:10px;">Activity</div>' +
          tl +
        '</div>' +
      '</div></td></tr>';
  }

  function kv(k, v) {
    return '<div style="margin-bottom:8px;">' +
      '<span style="font-size:12px;color:var(--light);display:inline-block;min-width:110px;">' + esc(k) + '</span>' +
      '<span style="font-size:13px;">' + v + '</span></div>';
  }

  window.crmSetFilter = function (f) { crmFilter = f; crmOpenKey = null; crmRender(); };
  window.crmSetSearch = function (v) { crmSearch = v || ''; crmOpenKey = null; crmRender(); };
  window.crmRefresh = function () { crmLoadPipeline(true); };
})();
