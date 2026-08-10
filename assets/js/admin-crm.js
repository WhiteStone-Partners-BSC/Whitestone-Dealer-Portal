/* ============================================================
   Whitestone Admin — CRM (Phase 2: pipeline + tasks + schedule)
   Depends on globals from dealer-portal.js: currentDealer, authHeaders()
   ============================================================ */
(function () {
  'use strict';

  var data = null;         // pipeline payload
  var tasks = [];          // all tasks
  var view = 'pipeline';
  var filter = 'all';
  var search = '';
  var openKey = null;
  var draftType = 'followup';
  var weekOffset = 0;
  var editingContact = null;

  var TYPES = {
    email:    { label: 'Email',           color: '#2c6a9b' },
    call:     { label: 'Phone call',      color: '#1f7a4d' },
    followup: { label: 'Follow-up',       color: '#b8963e' },
    visit:    { label: 'In-person visit', color: '#6b5ea8' }
  };

  var STAGE_COLORS = {
    'Active dealer': '#1f7a4d', 'Agreement sent': '#b8963e', 'Applied': '#2c6a9b',
    'Enrolled': '#2c6a9b', 'Inquired': '#6b5ea8', 'Engaged': '#c07a2a',
    'Mailed / no activity': '#8a8a8a', 'New': '#8a8a8a'
  };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtShort(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function ago(days) {
    if (days === null || days === undefined) return '—';
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 60) return days + ' days ago';
    return Math.round(days / 30) + ' months ago';
  }
  function ymd(d) {
    var m = String(d.getMonth() + 1); if (m.length < 2) m = '0' + m;
    var day = String(d.getDate());    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function todayYmd() { return ymd(new Date()); }
  function mondayOf(d) {
    var x = new Date(d); var wd = x.getDay();
    x.setDate(x.getDate() + (wd === 0 ? -6 : 1 - wd));
    x.setHours(0, 0, 0, 0); return x;
  }
  function stagePill(s) {
    return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;' +
      'font-weight:600;color:#fff;white-space:nowrap;background:' + (STAGE_COLORS[s] || '#8a8a8a') +
      ';">' + esc(s) + '</span>';
  }
  function typePill(t) {
    var T = TYPES[t] || { label: t, color: '#8a8a8a' };
    return '<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;' +
      'font-weight:600;color:#fff;background:' + T.color + ';">' + esc(T.label) + '</span>';
  }
  function emptyRow(msg) {
    return '<tr style="background:#fff;"><td colspan="8" style="text-align:center;padding:3rem;' +
      'color:#6b7a88;font-size:13px;background:#fff;">' + esc(msg) + '</td></tr>';
  }
  function toast(msg, bad) {
    var el = document.getElementById('crm-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'crm-toast';
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;' +
        'border-radius:8px;font-size:13px;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.2);';
      document.body.appendChild(el);
    }
    el.style.background = bad ? '#c0392b' : '#1f7a4d';
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.display = 'none'; }, 3200);
  }

  // ---------- loading ----------
  window.crmLoadPipeline = async function (force) {
    if (!window.currentDealer || !window.currentDealer.isAdmin) return;
    var loadEl = document.getElementById('crm-loading');
    var tbody = document.getElementById('crm-tbody');
    if (data && !force) { render(); return; }
    if (loadEl) loadEl.style.display = 'block';
    if (tbody) tbody.innerHTML = '';
    try {
      var results = await Promise.all([
        fetch('/api/crm-pipeline', { headers: authHeaders() }),
        fetch('/api/crm-tasks', { headers: authHeaders() })
      ]);
      var pj = await results[0].json();
      var tj = await results[1].json();
      if (loadEl) loadEl.style.display = 'none';
      if (!results[0].ok || !pj.ok) {
        if (tbody) tbody.innerHTML = emptyRow(pj.error || 'Could not load the pipeline.');
        return;
      }
      data = pj;
      tasks = (results[1].ok && tj.ok && tj.tasks) ? tj.tasks : [];
      render();
    } catch (e) {
      if (loadEl) loadEl.style.display = 'none';
      if (tbody) tbody.innerHTML = emptyRow('Could not reach the pipeline endpoint.');
      console.error('crmLoadPipeline', e);
    }
  };
  window.crmRefresh = function () { crmLoadPipeline(true); };

  async function reloadTasks() {
    try {
      var r = await fetch('/api/crm-tasks', { headers: authHeaders() });
      var j = await r.json();
      if (r.ok && j.ok) tasks = j.tasks || [];
    } catch (e) { console.error('reloadTasks', e); }
    render();
  }

  // ---------- view / filters ----------
  window.crmSetView = function (v) {
    view = v;
    var pf = document.getElementById('crm-pipeline-filters');
    var pt = document.getElementById('crm-pipeline-table');
    var sc = document.getElementById('crm-schedule');
    if (pf) pf.style.display = (v === 'pipeline') ? '' : 'none';
    if (pt) pt.style.display = (v === 'pipeline') ? '' : 'none';
    if (sc) sc.style.display = (v === 'schedule') ? '' : 'none';
    var a = document.getElementById('crm-tab-pipeline');
    var b = document.getElementById('crm-tab-schedule');
    if (a) { a.style.background = v === 'pipeline' ? '#0c1e2e' : '#fff'; a.style.color = v === 'pipeline' ? '#fff' : '#0c1e2e'; }
    if (b) { b.style.background = v === 'schedule' ? '#0c1e2e' : '#fff'; b.style.color = v === 'schedule' ? '#fff' : '#0c1e2e'; }
    render();
  };
  window.crmSetFilter = function (f) { filter = f; openKey = null; render(); };
  window.crmSetSearch = function (v) { search = v || ''; openKey = null; render(); };
  window.crmShiftWeek = function (n) { weekOffset = (n === 0) ? 0 : weekOffset + n; render(); };
  window.crmPickType = function (t) { draftType = t; render(); };
  window.crmToggleRow = function (k) { openKey = (openKey === k) ? null : k; editingContact = null; render(); };
  window.crmEditContact = function (k) { editingContact = k; render(); };
  window.crmCancelEdit = function () { editingContact = null; render(); };

  function openTasksFor(id) {
    return tasks.filter(function (t) { return t.dealer_id === id && t.status !== 'done'; });
  }

  // ---------- actions ----------
  window.crmAddTask = async function (dealerId, name) {
    var note = (document.getElementById('crm-note-' + dealerId) || {}).value || '';
    var due = (document.getElementById('crm-due-' + dealerId) || {}).value || '';
    var owner = (document.getElementById('crm-owner-' + dealerId) || {}).value || '';
    if (!due) { toast('Pick a due date', true); return; }
    try {
      var r = await fetch('/api/crm-tasks', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          dealer_id: dealerId, dealership_name: name,
          type: draftType, note: note, due_date: due, owner: owner
        })
      });
      var j = await r.json();
      if (!r.ok || !j.ok) { toast(j.error || 'Could not create task', true); return; }
      toast('Task added for ' + name);
      await reloadTasks();
    } catch (e) { toast('Could not create task', true); }
  };

  window.crmToggleTask = async function (id, done) {
    try {
      var r = await fetch('/api/crm-tasks', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ id: id, status: done ? 'done' : 'open' })
      });
      var j = await r.json();
      if (!r.ok || !j.ok) { toast(j.error || 'Could not update task', true); return; }
      await reloadTasks();
    } catch (e) { toast('Could not update task', true); }
  };

  window.crmDeleteTask = async function (id) {
    if (!window.confirm('Delete this task?')) return;
    try {
      var r = await fetch('/api/crm-tasks?id=' + encodeURIComponent(id), {
        method: 'DELETE', headers: authHeaders()
      });
      var j = await r.json();
      if (!r.ok || !j.ok) { toast(j.error || 'Could not delete task', true); return; }
      toast('Task deleted');
      await reloadTasks();
    } catch (e) { toast('Could not delete task', true); }
  };

  window.crmSaveContact = async function (dealerId) {
    var body = { dealer_id: dealerId };
    ['contact_first_name', 'contact_last_name', 'contact_title', 'email', 'phone', 'city', 'state']
      .forEach(function (f) {
        var el = document.getElementById('crm-c-' + f + '-' + dealerId);
        if (el) body[f] = el.value;
      });
    try {
      var r = await fetch('/api/crm-contact', {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body)
      });
      var j = await r.json();
      if (!r.ok || !j.ok) { toast(j.error || 'Could not save contact', true); return; }
      toast('Contact saved');
      editingContact = null;
      await window.crmLoadPipeline(true);
    } catch (e) { toast('Could not save contact', true); }
  };

  // ---------- render ----------
  function visible() {
    if (!data) return [];
    var list = data.prospects.slice();
    if (filter === 'followup') list = list.filter(function (p) { return p.needs_followup; });
    else if (filter === 'engaged') list = list.filter(function (p) { return p.scan_days > 0; });
    else if (filter === 'active') list = list.filter(function (p) { return p.active; });
    if (search) {
      var q = search.toLowerCase();
      list = list.filter(function (p) {
        return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
               ((p.contact && p.contact.email) || '').toLowerCase().indexOf(q) !== -1 ||
               (((p.contact && p.contact.contact_first_name) || '') + ' ' +
                ((p.contact && p.contact.contact_last_name) || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  function statBox(n, label, color) {
    return '<div style="text-align:center;padding:0 1.5rem;">' +
      '<div style="font-size:30px;font-weight:600;line-height:1;color:' + (color || '#0c1e2e') + ';">' + n + '</div>' +
      '<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6b7a88;margin-top:6px;">' +
      esc(label) + '</div></div>';
  }

  function render() {
    if (!data) return;

    var mon = mondayOf(new Date());
    var sun = new Date(mon); sun.setDate(sun.getDate() + 6);
    var dueThisWeek = tasks.filter(function (t) {
      return t.status !== 'done' && t.due_date >= ymd(mon) && t.due_date <= ymd(sun);
    }).length;
    var overdue = tasks.filter(function (t) {
      return t.status !== 'done' && t.due_date < todayYmd();
    }).length;

    var stats = document.getElementById('crm-stats');
    if (stats) {
      stats.innerHTML =
        statBox(data.counts.prospects, 'Prospects') +
        statBox(data.counts.needs_followup, 'Need follow-up') +
        statBox(tasks.filter(function (t) { return t.status !== 'done'; }).length, 'Open tasks') +
        statBox(dueThisWeek, 'Due this week') +
        statBox(overdue, 'Overdue', overdue ? '#c0392b' : '#0c1e2e');
    }

    var ws = document.getElementById('crm-week-summary');
    if (ws) {
      ws.innerHTML = dueThisWeek
        ? '<strong>' + dueThisWeek + '</strong> task' + (dueThisWeek === 1 ? '' : 's') + ' due this week' +
          (overdue ? ' · <span style="color:#c0392b;font-weight:600;">' + overdue + ' overdue</span>' : '')
        : 'Nothing due this week.';
    }

    document.querySelectorAll('#crm-filters .crm-filter-btn').forEach(function (b) {
      var on = b.getAttribute('data-crm-filter') === filter;
      b.style.background = on ? '#0c1e2e' : '#fff';
      b.style.color = on ? '#fff' : '#0c1e2e';
    });

    if (view === 'pipeline') renderTable(); else renderSchedule();
  }

  function renderTable() {
    var tbody = document.getElementById('crm-tbody');
    if (!tbody) return;
    var list = visible();
    if (!list.length) { tbody.innerHTML = emptyRow('No prospects match this filter.'); return; }

    var html = '';
    list.forEach(function (p) {
      var id = p.canonical_dealer_id || (p.dealer_ids && p.dealer_ids[0]);
      var ot = openTasksFor(id);
      var next = ot.slice().sort(function (a, b) { return a.due_date < b.due_date ? -1 : 1; })[0];
      var flag = (p.scan_days > 0 && ot.length === 0)
        ? '<span title="Engaged but no task scheduled" style="color:#c0392b;font-weight:700;">&#9679;</span> ' : '';
      html +=
        '<tr class="admin-mc-summary" style="cursor:pointer;background:#fff;color:#0c1e2e;" ' +
        'onclick="crmToggleRow(\'' + esc(p.key) + '\')" ' +
        'onmouseover="this.style.background=\'#f4f6f8\'" onmouseout="this.style.background=\'#fff\'">' +
          '<td>' + flag + '<strong>' + esc(p.name) + '</strong>' +
            (p.duplicate_rows > 1 ? '<div style="font-size:11px;color:#6b7a88;">' + p.duplicate_rows + ' merged records</div>' : '') + '</td>' +
          '<td>' + stagePill(p.stage) + '</td>' +
          '<td>' + (p.scan_days || 0) +
            (p.scan_count > p.scan_days ? ' <span style="color:#6b7a88;font-size:11px;">(' + p.scan_count + ' taps)</span>' : '') + '</td>' +
          '<td>' + fmtDate(p.last_scan) + '</td>' +
          '<td>' + ago(p.days_since_activity) + '</td>' +
          '<td>' + (ot.length ? '<strong>' + ot.length + '</strong>' : '<span style="color:#c7cfd6;">—</span>') + '</td>' +
          '<td>' + (next ? typePill(next.type) + ' ' + fmtDate(next.due_date) : '<span style="color:#c7cfd6;">none</span>') + '</td>' +
          '<td>' + (p.contact && p.contact.email
            ? '<a href="mailto:' + esc(p.contact.email) + '" onclick="event.stopPropagation();" style="color:#2c6a9b;">Email</a>'
            : '<span style="color:#c0392b;font-size:12px;">no email</span>') + '</td>' +
        '</tr>';
      if (openKey === p.key) html += detailRow(p, id);
    });
    tbody.innerHTML = html;
  }

  function kv(k, v) {
    return '<div style="margin-bottom:8px;font-size:13px;">' +
      '<span style="font-size:12px;color:#6b7a88;display:inline-block;min-width:110px;">' + esc(k) + '</span>' + v + '</div>';
  }

  function contactBlock(p, id) {
    var c = p.contact || {};
    if (editingContact === p.key) {
      function f(name, label, val) {
        return '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">' +
          '<label style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7a88;">' + esc(label) + '</label>' +
          '<input id="crm-c-' + name + '-' + id + '" value="' + esc(val || '') + '" ' +
          'style="padding:7px 9px;border:1px solid var(--border);border-radius:6px;font-size:13px;"></div>';
      }
      return f('contact_first_name', 'First name', c.contact_first_name) +
             f('contact_last_name', 'Last name', c.contact_last_name) +
             f('contact_title', 'Title', c.contact_title) +
             f('email', 'Email', c.email) +
             f('phone', 'Phone', c.phone) +
             f('city', 'City', c.city) +
             f('state', 'State', c.state) +
             '<div style="display:flex;gap:8px;margin-top:10px;">' +
             '<button onclick="event.stopPropagation();crmSaveContact(\'' + id + '\')" ' +
             'style="background:#0c1e2e;color:#fff;border:0;border-radius:6px;padding:9px 18px;font-size:12px;cursor:pointer;">Save</button>' +
             '<button onclick="event.stopPropagation();crmCancelEdit()" ' +
             'style="background:#fff;color:#0c1e2e;border:1px solid var(--border);border-radius:6px;padding:9px 18px;font-size:12px;cursor:pointer;">Cancel</button></div>';
    }
    var person = [c.contact_first_name, c.contact_last_name].filter(Boolean).join(' ');
    var out = '';
    if (person) out += kv('Contact', esc(person) + (c.contact_title ? ' — ' + esc(c.contact_title) : ''));
    out += kv('Email', c.email
      ? '<a href="mailto:' + esc(c.email) + '" style="color:#2c6a9b;">' + esc(c.email) + '</a>'
      : '<span style="color:#c0392b;">none on file</span>');
    out += kv('Phone', c.phone
      ? '<a href="tel:' + esc(c.phone) + '" style="color:#2c6a9b;">' + esc(c.phone) + '</a>'
      : '<span style="color:#c0392b;">none on file</span>');
    if (c.city || c.state) out += kv('Location', esc([c.city, c.state].filter(Boolean).join(', ')));
    if (c.boat_brands) out += kv('Brands', esc(c.boat_brands));
    out += '<button onclick="event.stopPropagation();crmEditContact(\'' + esc(p.key) + '\')" ' +
      'style="margin-top:10px;background:#fff;color:#0c1e2e;border:1px solid var(--border);' +
      'border-radius:6px;padding:8px 16px;font-size:12px;cursor:pointer;">Edit contact</button>';
    return out;
  }

  function detailRow(p, id) {
    var tl = '';
    (p.events || []).forEach(function (e) {
      tl += '<div style="padding:8px 0;border-bottom:1px solid #eee;">' +
        '<div style="font-size:12px;color:#6b7a88;">' + fmtDate(e.at) + '</div>' +
        '<div style="font-size:13px;">' + esc(e.label) + (e.person ? ' — ' + esc(e.person) : '') + '</div>' +
        (e.detail ? '<div style="font-size:12px;color:#555;margin-top:3px;">' + esc(e.detail) + '</div>' : '') +
        '</div>';
    });
    if (!tl) tl = '<div style="color:#6b7a88;font-size:13px;">No recorded activity.</div>';

    var ot = openTasksFor(id), otl = '';
    ot.sort(function (a, b) { return a.due_date < b.due_date ? -1 : 1; }).forEach(function (t) {
      otl += '<div style="padding:8px 0;border-bottom:1px solid #eee;">' +
        '<div style="font-size:12px;color:' + (t.due_date < todayYmd() ? '#c0392b' : '#6b7a88') + ';">' +
        fmtDate(t.due_date) + (t.due_date < todayYmd() ? ' · overdue' : '') + '</div>' +
        '<div style="font-size:13px;">' + typePill(t.type) + ' ' + esc(t.note || '') +
        (t.owner ? ' <span style="color:#6b7a88;">(' + esc(t.owner) + ')</span>' : '') + '</div>' +
        '<div style="margin-top:5px;">' +
        '<a href="#" onclick="event.preventDefault();event.stopPropagation();crmToggleTask(\'' + t.id + '\',true)" style="font-size:12px;color:#1f7a4d;">Mark done</a>' +
        ' · <a href="#" onclick="event.preventDefault();event.stopPropagation();crmDeleteTask(\'' + t.id + '\')" style="font-size:12px;color:#c0392b;">Delete</a>' +
        '</div></div>';
    });
    if (!otl) otl = '<div style="color:#6b7a88;font-size:13px;">No open tasks.</div>';

    var tt = '';
    Object.keys(TYPES).forEach(function (k) {
      var on = draftType === k;
      tt += '<button onclick="event.stopPropagation();crmPickType(\'' + k + '\')" ' +
        'style="border:1px solid ' + (on ? '#0c1e2e' : 'var(--border)') + ';background:' + (on ? '#0c1e2e' : '#fff') +
        ';color:' + (on ? '#fff' : '#0c1e2e') + ';border-radius:8px;padding:9px 14px;font-size:12px;cursor:pointer;' +
        'display:inline-flex;align-items:center;gap:7px;margin-right:8px;margin-bottom:8px;">' +
        '<span style="width:9px;height:9px;border-radius:50%;display:inline-block;background:' + TYPES[k].color + ';"></span>' +
        TYPES[k].label + '</button>';
    });

    var d = new Date(); d.setDate(d.getDate() + 2);
    var defaultDue = ymd(d);

    return '<tr class="admin-mc-expand"><td colspan="8" style="background:#fafbfc;color:#0c1e2e;padding:1.5rem;" onclick="event.stopPropagation();">' +
      '<div style="display:flex;gap:2.5rem;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:250px;"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7a88;margin-bottom:10px;">Contact</div>' + contactBlock(p, id) + '</div>' +
        '<div style="flex:1;min-width:250px;"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7a88;margin-bottom:10px;">Activity</div>' + tl + '</div>' +
        '<div style="flex:1;min-width:250px;"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7a88;margin-bottom:10px;">Open tasks</div>' + otl + '</div>' +
      '</div>' +
      '<div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);">' +
        '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7a88;margin-bottom:10px;">Create a task</div>' +
        '<div>' + tt + '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:6px;">' +
          '<div style="display:flex;flex-direction:column;gap:5px;flex:2;min-width:230px;">' +
            '<label style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7a88;">Note</label>' +
            '<input id="crm-note-' + id + '" placeholder="What needs to happen?" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;"></div>' +
          '<div style="display:flex;flex-direction:column;gap:5px;">' +
            '<label style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7a88;">Due</label>' +
            '<input type="date" id="crm-due-' + id + '" value="' + defaultDue + '" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;"></div>' +
          '<div style="display:flex;flex-direction:column;gap:5px;">' +
            '<label style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7a88;">Owner</label>' +
            '<select id="crm-owner-' + id + '" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">' +
            '<option>Carson</option><option>Ben</option><option>Cody</option></select></div>' +
          '<button onclick="event.stopPropagation();crmAddTask(\'' + id + '\',\'' + esc(p.name).replace(/'/g, '&#39;') + '\')" ' +
            'style="background:#0c1e2e;color:#fff;border:0;border-radius:6px;padding:10px 20px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;">Add task</button>' +
        '</div>' +
      '</div></td></tr>';
  }

  function renderSchedule() {
    var host = document.getElementById('crm-schedule');
    if (!host) return;

    var mon = mondayOf(new Date());
    mon.setDate(mon.getDate() + weekOffset * 7);
    var end = new Date(mon); end.setDate(end.getDate() + 6);
    var names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var today = todayYmd();

    var legend = '';
    Object.keys(TYPES).forEach(function (k) {
      legend += '<span style="margin-right:14px;white-space:nowrap;"><span style="display:inline-block;width:9px;height:9px;' +
        'border-radius:50%;background:' + TYPES[k].color + ';margin-right:5px;"></span>' + TYPES[k].label + '</span>';
    });

    var days = '';
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon); d.setDate(d.getDate() + i);
      var key = ymd(d);
      var isToday = key === today;
      var dayTasks = tasks.filter(function (t) { return t.due_date === key; })
        .sort(function (a, b) { return (a.status === b.status) ? 0 : (a.status === 'done' ? 1 : -1); });

      var cards = '';
      dayTasks.forEach(function (t) {
        var done = t.status === 'done';
        var od = !done && key < today;
        cards += '<div style="border-left:3px solid ' + (od ? '#c0392b' : TYPES[t.type] ? TYPES[t.type].color : '#8a8a8a') +
          ';background:' + (od ? '#fdf2f2' : '#f8fafc') + ';border-radius:5px;padding:7px 8px;margin-bottom:7px;' +
          'font-size:12px;' + (done ? 'opacity:.45;' : '') + '">' +
          '<span style="float:right;cursor:pointer;color:#6b7a88;font-size:14px;" ' +
          'onclick="crmToggleTask(\'' + t.id + '\',' + (done ? 'false' : 'true') + ')" title="' +
          (done ? 'Mark not done' : 'Mark done') + '">' + (done ? '&#9745;' : '&#9744;') + '</span>' +
          '<span style="font-weight:600;display:block;' + (done ? 'text-decoration:line-through;' : '') + '">' +
          esc(t.dealership_name || '(dealer)') + '</span>' +
          '<span style="color:#6b7a88;font-size:11px;">' + esc((TYPES[t.type] || {}).label || t.type) +
          (t.note ? ' · ' + esc(t.note) : '') + (t.owner ? ' · ' + esc(t.owner) : '') + '</span></div>';
      });
      if (!cards) cards = '<div style="color:#c7cfd6;font-size:11px;padding-top:6px;">Nothing scheduled</div>';

      days += '<div class="crm-day" style="background:#fff;border:1px solid ' + (isToday ? '#b8963e' : 'var(--border)') +
        ';border-radius:10px;min-height:210px;padding:10px;' + (isToday ? 'box-shadow:0 0 0 2px rgba(184,150,62,.18);' : '') + '">' +
        '<h4 style="margin:0 0 2px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7a88;">' + names[i] + '</h4>' +
        '<div style="font-size:19px;font-weight:600;margin-bottom:9px;' + (isToday ? 'color:#b8963e;' : '') + '">' + d.getDate() + '</div>' +
        cards + '</div>';
    }

    host.innerHTML =
      '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button onclick="crmShiftWeek(-1)" style="border:1px solid var(--border);background:#fff;border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:15px;">&#8249;</button>' +
            '<strong style="font-size:15px;">' + fmtShort(mon) + ' – ' + fmtShort(end) + ', ' + end.getFullYear() + '</strong>' +
            '<button onclick="crmShiftWeek(1)" style="border:1px solid var(--border);background:#fff;border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:15px;">&#8250;</button>' +
            '<button onclick="crmShiftWeek(0)" style="margin-left:8px;background:#fff;color:#0c1e2e;border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:12px;cursor:pointer;">This week</button>' +
          '</div>' +
          '<div style="font-size:12px;color:#6b7a88;">' + legend + '</div>' +
        '</div>' +
        '<div class="crm-week" style="display:grid;grid-template-columns:repeat(7,1fr);gap:10px;">' + days + '</div>' +
      '</div>';
  }

  // Mobile: stack the week
  var mq = document.createElement('style');
  mq.textContent = '@media(max-width:900px){.crm-week{grid-template-columns:1fr !important;}' +
    '.crm-day{min-height:0 !important;}}';
  document.head.appendChild(mq);
})();
