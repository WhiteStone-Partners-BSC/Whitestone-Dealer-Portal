var SUPABASE_URL = "https://ypuohmiynnmbnlqfctlg.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwdW9obWl5bm5tYm5scWZjdGxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwODU4NzEsImV4cCI6MjA5MTY2MTg3MX0.HzrF_OCr2T9rKV9am90B2OvIQKjq28pObheMRps82AI";
var FORMSPREE_CONTACT = "https://formspree.io/f/mvzvzkqa";
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
var currentDealer = null;
window.authToken = null;
window.currentDealer = null;
var allTickets = [];
var adminNetworkTickets = [];
var adminDashboardMetrics = { count: 0, revenue: 0 };
var adminReimburseMetrics = { paidTotal: 0 };
var adminRenewalContracts = [];
var dealerRowsCache = [];
var adminChartInstance = null;
var dashboardPeriod = "year";
var earningsAnimRaf = null;
var dealerContractCount = 0;
var renewalContractsDealer = [];
var adminContractsCache = [];
var dealerContractsCache = [];

var currentFinPeriod = "month";
var currentFinSection = "overview";

var ADMIN_CONTRACT_AVG = 3699;
var ADMIN_AVG_REIMB = 150;
var ADMIN_COMMISSION_RATE = 0.2;

function authHeaders(extraHeaders) {
  var token = window.authToken ? window.authToken : SUPABASE_ANON_KEY;
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json"
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return headers;
}

function supabaseHeaders(extra) {
  return authHeaders(extra);
}

function buildDealerSession(dealer, session) {
  var authUserId = session && session.user ? session.user.id : null;
  return {
    id: dealer.id,
    authId: authUserId || dealer.auth_id || null,
    username: dealer.username,
    name: dealer.dealership_name,
    email: dealer.email || (session && session.user ? session.user.email : ""),
    isAdmin: dealer.is_admin === true,
    token: session ? session.access_token : window.authToken || null
  };
}

async function fetchDealerByAuthId(authId, accessToken) {
  var res = await fetch(
    SUPABASE_URL + "/rest/v1/dealers?auth_id=eq." + encodeURIComponent(authId) + "&active=eq.true&select=*",
    {
      headers: authHeaders({ Authorization: "Bearer " + accessToken })
    }
  );
  if (!res.ok) {
    throw new Error("Failed to load dealer account.");
  }
  var dealers = await res.json();
  return Array.isArray(dealers) && dealers.length ? dealers[0] : null;
}

function createDetachedSupabaseClient() {
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function mapTicketFromRow(row) {
  var created = row.created_at ? new Date(row.created_at) : null;
  var hinRaw = row.hin || "";
  return {
    id: row.id,
    ticketNum: row.ticket_number || "",
    date: created ? created.toLocaleDateString() : "",
    created_at: row.created_at,
    submittedAt: row.created_at,
    serviceDate: row.service_date || "",
    serviceType: row.service_type || "",
    dealership: row.dealership_name || "",
    firstName: row.customer_first_name || "",
    lastName: row.customer_last_name || "",
    email: row.customer_email || "",
    phone: row.customer_phone || "",
    boatMake: row.boat_make || "",
    boatModel: row.boat_model || "",
    year: row.boat_year || "",
    hin: String(hinRaw).trim().toUpperCase(),
    engineHours: row.engine_hours || "",
    technician: row.technician || "",
    serviceNotes: row.service_notes || "",
    status: row.status || "pending",
    rejectionReason: row.rejection_reason || "",
    reimbursementAmount: row.reimbursement_amount
  };
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function parseTicketDate(t) {
  var raw = String(t.serviceDate || t.date || t.submittedAt || t.created_at || "").trim();
  if (!raw) return null;
  var d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  var m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return null;
}

function customerKey(t) {
  var e = String(t.email || "").trim().toLowerCase();
  if (e) return "e:" + e;
  var fn = String(t.firstName || "").trim().toLowerCase();
  var ln = String(t.lastName || "").trim().toLowerCase();
  if (fn || ln) return "n:" + fn + "|" + ln;
  return "";
}

function ticketMatchesPeriod(t, period) {
  if (period === "all") return true;
  var d = parseTicketDate(t);
  if (!d) return false;
  return d.getFullYear() === new Date().getFullYear();
}

function countUniqueCustomers(tickets) {
  var seen = {};
  tickets.forEach(function(t) {
    var k = customerKey(t);
    if (k) seen[k] = true;
  });
  return Object.keys(seen).length;
}

function getTierMeta(contractCount) {
  var c = contractCount;
  if (c >= 30) return { id: "platinum", title: "Platinum Partner", color: "#E5E4E2" };
  if (c >= 15) return { id: "gold", title: "Gold Partner", color: "#b8963e" };
  if (c >= 5) return { id: "silver", title: "Silver Partner", color: "#C0C0C0" };
  return { id: "bronze", title: "Certified Dealer", color: "#CD7F32" };
}

function getTierProgressState(count) {
  if (count >= 30) return { platinum: true };
  if (count < 5) return { need: 5 - count, nextName: "Silver Partner", pct: Math.min(100, (count / 5) * 100) };
  if (count < 15) return { need: 15 - count, nextName: "Gold Partner", pct: ((count - 5) / 10) * 100 };
  return { need: 30 - count, nextName: "Platinum Partner", pct: ((count - 15) / 15) * 100 };
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function toggleSettingsSection(id) {
  var content = document.getElementById(id);
  var arrowId = id.replace("-content", "-arrow");
  var arrow = document.getElementById(arrowId);
  if (!content) return;
  var isOpen = window.getComputedStyle(content).display !== "none";
  content.style.display = isOpen ? "none" : "block";
  if (arrow) arrow.textContent = isOpen ? "▶" : "▼";
}

var allMessages = [];
var currentFilter = "all";

async function adminLoadMessages() {
  var listEl = document.getElementById("messages-list");
  if (listEl) {
    listEl.innerHTML = "<div style='text-align:center;padding:2rem;color:var(--light);font-size:13px;'>Loading messages...</div>";
  }
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/dealer_messages?select=*&order=created_at.desc",
      { headers: authHeaders() }
    );
    allMessages = (await res.json()) || [];
  } catch (e) {
    allMessages = [];
  }

  var newCount = allMessages.filter(function(m) { return m.status === "new"; }).length;
  var badge = document.getElementById("messages-badge");
  if (badge) {
    badge.textContent = String(newCount);
    badge.style.display = newCount > 0 ? "block" : "none";
  }

  var inProg = allMessages.filter(function(m) { return m.status === "in_progress"; }).length;
  var resolved = allMessages.filter(function(m) { return m.status === "resolved"; }).length;
  var elNew = document.getElementById("msg-count-new");
  var elProg = document.getElementById("msg-count-progress");
  var elRes = document.getElementById("msg-count-resolved");
  if (elNew) elNew.textContent = String(newCount);
  if (elProg) elProg.textContent = String(inProg);
  if (elRes) elRes.textContent = String(resolved);

  messagesRender();
}

function messagesFilter(filter) {
  currentFilter = filter;
  ["all", "new", "progress", "resolved"].forEach(function(f) {
    var btn = document.getElementById("filter-" + f);
    if (btn) {
      btn.style.background = "";
      btn.style.color = "";
    }
  });
  var active = document.getElementById("filter-" + (filter === "in_progress" ? "progress" : filter));
  if (active) {
    active.style.background = "var(--navy)";
    active.style.color = "white";
  }
  messagesRender();
}

function messageStatusMeta(status) {
  if (status === "new") return { color: "var(--red-text)", bg: "rgba(192,57,43,0.1)", label: "New" };
  if (status === "in_progress") return { color: "var(--gold)", bg: "rgba(184,150,62,0.12)", label: "In Progress" };
  if (status === "resolved") return { color: "var(--green-text)", bg: "rgba(27,94,32,0.1)", label: "Resolved" };
  return { color: "var(--light)", bg: "rgba(143,165,184,0.16)", label: String(status || "Unknown") };
}

function messagesRender() {
  var filtered = currentFilter === "all"
    ? allMessages
    : allMessages.filter(function(m) { return m.status === currentFilter; });

  var el = document.getElementById("messages-list");
  if (!el) return;
  if (!filtered || filtered.length === 0) {
    el.innerHTML = "<div style='text-align:center;padding:2rem;color:var(--light);font-size:13px;'>No messages found.</div>";
    return;
  }

  el.innerHTML = filtered.map(function(m) {
    var meta = messageStatusMeta(m.status);
    var dt = m.created_at ? new Date(m.created_at) : new Date();
    var date = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    var safeId = String(m.id || "").replace(/'/g, "\\'");
    return "<div style='background:white;border:1px solid var(--border);border-radius:10px;padding:1.25rem 1.5rem;margin-bottom:0.85rem;border-left:3px solid " + meta.color + ";'>" +
      "<div style='display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;'>" +
        "<div>" +
          "<div style='font-size:15px;font-weight:600;color:var(--navy);'>" + escHtml(m.dealership_name || "Unknown") + "</div>" +
          "<div style='font-size:12px;color:var(--light);margin-top:2px;'>" + escHtml(m.request_type || "General") + " · " + escHtml(date) + "</div>" +
        "</div>" +
        "<span style='font-size:11px;font-weight:600;color:" + meta.color + ";background:" + meta.bg + ";padding:3px 12px;border-radius:20px;border:1px solid " + meta.color + ";'>" + escHtml(meta.label) + "</span>" +
      "</div>" +
      "<div style='font-size:13.5px;color:var(--mid);line-height:1.7;margin-bottom:1rem;padding:0.75rem 1rem;background:var(--silver-bg);border-radius:6px;'>" +
        escHtml(m.message || "") +
      "</div>" +
      "<div style='display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;'>" +
        "<select onchange=\"messagesUpdateStatus('" + safeId + "', this.value)\" style='padding:6px 10px;border:1px solid var(--border);border-radius:5px;font-size:12.5px;font-family:inherit;color:var(--navy);'>" +
          "<option value='new'" + (m.status === "new" ? " selected" : "") + ">New</option>" +
          "<option value='in_progress'" + (m.status === "in_progress" ? " selected" : "") + ">In Progress</option>" +
          "<option value='resolved'" + (m.status === "resolved" ? " selected" : "") + ">Resolved</option>" +
        "</select>" +
        "<input type='text' placeholder='Add a note (optional)...' id='note-" + safeId + "' value=\"" + escHtml(m.admin_notes || "") + "\" style='flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border);border-radius:5px;font-size:12.5px;font-family:inherit;'>" +
        "<button onclick=\"messagesSaveNote('" + safeId + "')\" style='background:var(--navy);color:white;border:none;padding:6px 16px;border-radius:5px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;'>Save Note</button>" +
      "</div>" +
    "</div>";
  }).join("");
}

async function messagesUpdateStatus(id, status) {
  await fetch(SUPABASE_URL + "/rest/v1/dealer_messages?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ status: status })
  });
  await adminLoadMessages();
}

async function messagesSaveNote(id) {
  var note = document.getElementById("note-" + id);
  if (!note) return;
  await fetch(SUPABASE_URL + "/rest/v1/dealer_messages?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ admin_notes: note.value })
  });
  note.style.borderColor = "var(--green-text)";
  setTimeout(function() { note.style.borderColor = ""; }, 1500);
}

function generateUsername(dealershipName) {
  var s = String(dealershipName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 20);
  return s || "dealer" + Math.floor(1000 + Math.random() * 8999);
}

function generateTempPassword() {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var result = "WSP-";
  for (var i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

var applicationsLastData = { pending: [], active: [], declined: [], inactive: [] };

function formatApplicationDate(iso) {
  if (!iso) return "—";
  try {
    var d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch (e) {
    return "—";
  }
}

function applicationsUpdateTabBadge(count) {
  var badge = document.getElementById("dealers-pending-badge");
  if (!badge) return;
  var n = Math.max(0, parseInt(count, 10) || 0);
  if (n > 0) {
    badge.textContent = String(n);
    badge.style.display = "block";
    badge.title = n + " pending application" + (n === 1 ? "" : "s");
  } else {
    badge.textContent = "";
    badge.style.display = "none";
  }
}

async function adminLoadBadgeCounts() {
  if (!currentDealer || !currentDealer.isAdmin) return;
  try {
    var res1 = await fetch(
      SUPABASE_URL + "/rest/v1/dealer_applications?status=eq.pending&select=id",
      { headers: authHeaders() }
    );
    var apps = await res1.json() || [];
    var dealerBadge = document.getElementById("dealers-pending-badge");
    if (dealerBadge) {
      dealerBadge.textContent = apps.length;
      dealerBadge.style.display = apps.length > 0 ? "block" : "none";
    }

    var res2 = await fetch(
      SUPABASE_URL + "/rest/v1/dealer_messages?status=eq.new&select=id",
      { headers: authHeaders() }
    );
    var msgs = await res2.json() || [];
    var msgBadge = document.getElementById("messages-badge");
    if (msgBadge) {
      msgBadge.textContent = msgs.length;
      msgBadge.style.display = msgs.length > 0 ? "block" : "none";
    }
  } catch (e) {
    /* ignore */
  }
}

async function applicationsEnsureUniqueUsername(base) {
  var u = base;
  var tryNum = 0;
  while (tryNum < 40) {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/dealers?username=eq." + encodeURIComponent(u) + "&select=id",
      { headers: supabaseHeaders() }
    );
    var rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return u;
    tryNum++;
    u = base.substring(0, 14) + tryNum + Math.floor(Math.random() * 99);
  }
  return base + Math.floor(Math.random() * 90000 + 10000);
}

async function applicationsRefreshTabBadgeOnly() {
  if (!currentDealer || !currentDealer.isAdmin) return;
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/dealer_applications?status=eq.pending&select=id",
      { headers: supabaseHeaders() }
    );
    var rows = await res.json();
    applicationsUpdateTabBadge(Array.isArray(rows) ? rows.length : 0);
  } catch (e) {
    applicationsUpdateTabBadge(0);
  }
}

function normalizeHin(s) {
  return String(s || "").trim().toUpperCase();
}

function ticketBillable(t) {
  var st = (t.status || "pending").toLowerCase();
  return st === "approved" || st === "pending";
}

async function verifyHINForEnrollment(hin, firstName, lastName, dealerName) {
  if (!hin || hin.trim() === "") {
    return { allowed: false, message: "Hull ID (HIN) is required. No HIN, no enrollment." };
  }
  hin = hin.toUpperCase().trim();
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/contracts?hin=eq." + encodeURIComponent(hin) + "&select=*",
      { headers: authHeaders() }
    );
    var existing = await res.json();
    if (!existing || existing.length === 0) return { allowed: true };
    var active = existing.filter(function(c) { return c.status === "active"; });
    var existingName = (existing[0].customer_first_name + " " + existing[0].customer_last_name).toLowerCase().trim();
    var newName = (firstName + " " + lastName).toLowerCase().trim();
    var sameCustomer = existingName === newName;
    if (sameCustomer && active.length > 0) {
      return { allowed: false, message: "This boat already has an active contract. It expires on " + active[0].end_date + ". Please wait until expiry to renew." };
    }
    if (!sameCustomer && active.length > 0) {
      await logHINConflict(hin, dealerName, firstName + " " + lastName, existing[0].customer_first_name + " " + existing[0].customer_last_name, "active", "HIN has active contract under different customer");
      return { allowed: false, message: "This HIN is registered to another customer with an active contract. Contracts do not transfer with ownership. Please contact Whitestone Partners at support@whitestone-partners.com to resolve." };
    }
    return { allowed: true, isRenewal: sameCustomer, isNewOwner: !sameCustomer };
  } catch (e) {
    return { allowed: true };
  }
}

async function verifyHINForTicket(hin) {
  if (!hin || hin.trim() === "") {
    return { valid: false, message: "HIN is required to submit a ticket." };
  }
  hin = hin.toUpperCase().trim();
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/contracts?hin=eq." + encodeURIComponent(hin) + "&select=*",
      { headers: authHeaders() }
    );
    var contracts = await res.json();
    if (!contracts || contracts.length === 0) {
      return { valid: false, message: "No contract found for this HIN. Please enroll this customer first." };
    }
    var active = contracts.filter(function(c) { return c.status === "active"; });
    if (active.length === 0) {
      return { valid: false, expired: true, message: "This customer's contract has expired. Please re-enroll them before submitting a ticket.", customer: contracts[0].customer_first_name + " " + contracts[0].customer_last_name };
    }
    return { valid: true, contract: active[0], customer: active[0].customer_first_name + " " + active[0].customer_last_name };
  } catch (e) {
    return { valid: true };
  }
}

async function logHINConflict(hin, dealerName, attemptedCustomer, existingCustomer, contractStatus, reason) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/hin_conflicts", {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        hin: hin,
        attempted_by_dealer: dealerName,
        attempted_customer_name: attemptedCustomer,
        existing_customer_name: existingCustomer,
        existing_contract_status: contractStatus,
        reason: reason,
        resolved: false
      })
    });
  } catch (e) {}
}

async function writeAuditLog(entityType, entityId, action, oldValue, newValue, dealerName, customerName, notes) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/audit_log", {
      method: "POST",
      headers: authHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        entity_type: entityType,
        entity_id: entityId || null,
        action: action,
        old_value: oldValue || null,
        new_value: newValue || null,
        dealer_name: dealerName || null,
        customer_name: customerName || null,
        notes: notes || null,
        performed_by: window.currentDealer ? window.currentDealer.name : "unknown"
      })
    });
  } catch (e) {}
}

async function verifyCustomerContract(firstName, lastName, hin, dealerName) {
  return verifyHINForTicket(hin);
}

function contractCardStatus(c) {
  var st = String(c.status || "").toLowerCase();
  var end = c.end_date ? new Date(c.end_date) : null;
  if (end) end.setHours(0, 0, 0, 0);
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  if (st === "cancelled") return { label: "Expired", cls: "badge-contract-expired", sort: 3 };
  if (st !== "active") return { label: "Expired", cls: "badge-contract-expired", sort: 3 };
  if (!end) return { label: "Active", cls: "badge-contract-active", sort: 0 };
  var days = Math.round((end - now) / 86400000);
  if (days < 0) return { label: "Expired", cls: "badge-contract-expired", sort: 3 };
  if (days <= 30) return { label: "Expiring Soon", cls: "badge-contract-soon", sort: 1 };
  return { label: "Active", cls: "badge-contract-active", sort: 0 };
}

var pricingModelServices = [];
var pricingProfitChartInstance = null;
var pricingControlsBound = false;
var pricingTabInitialized = false;
var pricingSupabaseLoadPromise = null;
var pricingState = {
  dealerId: null,
  dealerName: null,
  originalRates: {},
  currentRates: {},
  confirmed: false,
  locked: false,
  pricingId: null
};

var PRICING_RETAIL_1YR = 3699;
var PRICING_RETAIL_2YR = 6798;
var PRICING_RETAIL_3YR = 9297;

function pricingDefaultServices() {
  return [
    { name: "Summer Prep", retail: 299, marketAvg: 299, hours: null, yearly: true },
    { name: "Impeller Service", retail: 399, marketAvg: 380, hours: 50, yearly: true },
    { name: "Engine Oil Service", retail: 398, marketAvg: 326, hours: 50, yearly: true },
    { name: "Fuel Filter Service", retail: 298, marketAvg: 185, hours: 150, yearly: false },
    { name: "Transmission Oil", retail: 275, marketAvg: 295, hours: 100, yearly: true },
    { name: "Outdrive Service", retail: 389, marketAvg: 380, hours: 100, yearly: true },
    { name: "Shaft Alignment", retail: 319, marketAvg: 435, hours: 150, yearly: true },
    { name: "Winterization", retail: 299, marketAvg: 430, hours: null, yearly: true },
    { name: "V-Drive Service", retail: 215, marketAvg: 372, hours: 200, yearly: true },
    { name: "Ballast Cartridge", retail: 800, marketAvg: 800, hours: 100, yearly: false }
  ];
}

function pricingDedupeModelServices(services) {
  if (!Array.isArray(services)) return services;
  var seen = {};
  return services.filter(function(s) {
    var key = (s.name || s.id || "").toString().toLowerCase().trim();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function pricingDefaultRates() {
  return {
    reimbursement_rate: 150,
    commission_pct: 20,
    contract_retail_1yr: PRICING_RETAIL_1YR,
    contract_retail_2yr: PRICING_RETAIL_2YR,
    contract_retail_3yr: PRICING_RETAIL_3YR
  };
}

function pricingCurrentRetail(years) {
  var key = "contract_retail_" + years + "yr";
  var fallback = years === 1 ? PRICING_RETAIL_1YR : years === 2 ? PRICING_RETAIL_2YR : PRICING_RETAIL_3YR;
  var source = pricingState && pricingState.currentRates ? pricingState.currentRates : null;
  return source && source[key] ? Number(source[key]) : fallback;
}

function pricingFormatCycle(s) {
  var y = s.yearly;
  var hn = Number(s.hours);
  var h = s.hours != null && String(s.hours).trim() !== "" && !isNaN(hn) && hn > 0;
  if (y && h) return "Yearly / every " + hn + " hrs";
  if (h) return "Every " + hn + " hrs";
  if (y) return "Yearly";
  return "—";
}

function pricingWpCap(mkt) {
  var m = parseFloat(mkt) || 0;
  return Math.round(m * 0.8 * 100) / 100;
}

function pricingWpMarginCell(mkt) {
  var m = parseFloat(mkt) || 0;
  return Math.round((m - pricingWpCap(m)) * 100) / 100;
}

function pricingSumBaseline() {
  return pricingModelServices.reduce(function(sum, s) {
    return sum + (parseFloat(s.retail) || 0);
  }, 0);
}

function pricingSaveSliderPrefs() {
  try {
    var c = document.getElementById("pricing-slider-commission");
    var cl = document.getElementById("pricing-slider-claims");
    if (c) localStorage.setItem("wsp_pricing_commission", c.value);
    if (cl) localStorage.setItem("wsp_pricing_claims", cl.value);
  } catch (e) {}
}

async function pricingLoadFromSupabase() {
  if (pricingSupabaseLoadPromise) return pricingSupabaseLoadPromise;
  pricingSupabaseLoadPromise = (async function() {
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/services?active=eq.true&select=*&order=sort_order.asc", {
        headers: supabaseHeaders()
      });
      var rows = await res.json();
      if (!res.ok) throw new Error();
      if (Array.isArray(rows) && rows.length) {
        pricingModelServices = rows.map(function(r) {
          return {
            _dbId: r.id,
            name: r.name || "",
            retail: parseFloat(r.retail_price) || 0,
            marketAvg: parseFloat(r.market_avg) || 0,
            hours: r.hours_interval != null && r.hours_interval !== "" ? Number(r.hours_interval) : null,
            yearly: r.is_yearly === true
          };
        });
      } else {
        pricingModelServices = pricingDefaultServices();
      }
      pricingModelServices = pricingDedupeModelServices(pricingModelServices);
    } catch (e) {
      pricingModelServices = pricingDedupeModelServices(pricingDefaultServices());
    }
    var c = document.getElementById("pricing-slider-commission");
    var cl = document.getElementById("pricing-slider-claims");
    var cv = localStorage.getItem("wsp_pricing_commission");
    var clv = localStorage.getItem("wsp_pricing_claims");
    if (c && cv !== null && cv !== "") c.value = cv;
    if (cl && clv !== null && clv !== "") cl.value = clv;
  })();
  return pricingSupabaseLoadPromise;
}

async function pricingLoadDealers() {
  var sel = document.getElementById("pricing-dealer-select");
  if (!sel) return;
  sel.innerHTML = "<option value=''>— Select a dealer —</option>";
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/dealers?is_admin=eq.false&active=eq.true&select=id,username,dealership_name&order=dealership_name.asc",
      { headers: authHeaders() }
    );
    var dealers = await res.json() || [];
    dealers.forEach(function(d) {
      var opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.dealership_name;
      opt.dataset.name = d.dealership_name;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

function pricingSetEditingLocked(isLocked) {
  ["pricing-slider-commission", "contract-price-1yr", "contract-price-2yr", "contract-price-3yr"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.disabled = !!isLocked;
  });
  var addBtn = document.getElementById("pricing-add-service");
  if (addBtn) addBtn.disabled = !!isLocked;
}

function pricingUpdateUIFromState() {
  var commSlider = document.getElementById("pricing-slider-commission");
  if (commSlider) commSlider.value = pricingState.currentRates.commission_pct || 20;
  var commLabel = document.getElementById("pricing-label-commission");
  if (commLabel) commLabel.textContent = String(pricingState.currentRates.commission_pct || 20);
  ["1yr", "2yr", "3yr"].forEach(function(yr) {
    var key = "contract_retail_" + yr;
    var inp = document.getElementById("contract-price-" + yr);
    if (inp) inp.value = pricingState.currentRates[key] || pricingDefaultRates()[key];
  });
  pricingSetEditingLocked(pricingState.locked);
  pricingCheckUnsavedChanges();
  pricingUpdateAll();
}

function pricingUpdateLockStatus() {
  var lockEl = document.getElementById("pricing-lock-status");
  if (!lockEl) return;
  lockEl.style.display = "block";
  if (pricingState.locked) {
    lockEl.style.background = "#fff0f0";
    lockEl.style.color = "#c0392b";
    lockEl.style.border = "1px solid #fcc";
    lockEl.textContent = "🔒 Pricing locked — confirmed";
  } else if (pricingState.confirmed) {
    lockEl.style.background = "#f0f9f4";
    lockEl.style.color = "#0F6E56";
    lockEl.style.border = "1px solid #a8d5b5";
    lockEl.textContent = "✓ Pricing confirmed";
  } else {
    lockEl.style.background = "#fff5f0";
    lockEl.style.color = "#BA7517";
    lockEl.style.border = "1px solid #f0d060";
    lockEl.textContent = "● Draft pricing — not confirmed";
  }
  var unlockBtn = document.getElementById("pricing-unlock-btn");
  var genBtn = document.getElementById("pricing-generate-btn");
  if (unlockBtn) unlockBtn.style.display = pricingState.confirmed ? "inline-block" : "none";
  if (genBtn) genBtn.style.display = pricingState.confirmed ? "inline-block" : "none";
}

function pricingBuildChanges() {
  var labels = {
    reimbursement_rate: "Base Reimbursement Rate",
    commission_pct: "Commission %",
    contract_retail_1yr: "1-Year Contract Price",
    contract_retail_2yr: "2-Year Contract Price",
    contract_retail_3yr: "3-Year Contract Price"
  };
  var changes = [];
  Object.keys(pricingState.currentRates || {}).forEach(function(key) {
    if (pricingState.currentRates[key] !== pricingState.originalRates[key]) {
      changes.push({ key: key, label: labels[key] || key, old: pricingState.originalRates[key], next: pricingState.currentRates[key] });
    }
  });
  return changes;
}

function pricingCheckUnsavedChanges() {
  var hasChanges = JSON.stringify(pricingState.currentRates || {}) !== JSON.stringify(pricingState.originalRates || {});
  var confirmBtn = document.getElementById("pricing-confirm-btn");
  if (confirmBtn) {
    confirmBtn.style.opacity = hasChanges ? "1" : "0.5";
    confirmBtn.textContent = hasChanges ? "Review & Confirm Changes" : "No Changes to Confirm";
  }
}

async function pricingLoadDealerRates(dealerId, dealerName) {
  if (!dealerId) return;
  pricingState.dealerId = dealerId;
  pricingState.dealerName = dealerName;
  var record = null;
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/dealer_pricing?dealer_id=eq." + dealerId + "&select=*&limit=1",
      { headers: authHeaders() }
    );
    var records = await res.json();
    record = records && records.length > 0 ? records[0] : null;
    if (!record) {
      var createRes = await fetch(SUPABASE_URL + "/rest/v1/dealer_pricing", {
        method: "POST",
        headers: authHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          dealer_id: dealerId,
          dealership_name: dealerName,
          service_name: "Default Rate Card",
          reimbursement_rate: 150,
          commission_pct: 20,
          contract_retail_1yr: 3699,
          contract_retail_2yr: 6798,
          contract_retail_3yr: 9297,
          confirmed: false,
          locked: false
        })
      });
      var created = await createRes.json();
      record = Array.isArray(created) ? created[0] : created;
    }
  } catch (e) {
    record = null;
  }
  var defaults = pricingDefaultRates();
  pricingState.pricingId = record ? record.id : null;
  pricingState.confirmed = !!(record && record.confirmed);
  pricingState.locked = !!(record && record.locked);
  pricingState.originalRates = {
    reimbursement_rate: record && record.reimbursement_rate != null ? Number(record.reimbursement_rate) : defaults.reimbursement_rate,
    commission_pct: record && record.commission_pct != null ? Number(record.commission_pct) : defaults.commission_pct,
    contract_retail_1yr: record && record.contract_retail_1yr != null ? Number(record.contract_retail_1yr) : defaults.contract_retail_1yr,
    contract_retail_2yr: record && record.contract_retail_2yr != null ? Number(record.contract_retail_2yr) : defaults.contract_retail_2yr,
    contract_retail_3yr: record && record.contract_retail_3yr != null ? Number(record.contract_retail_3yr) : defaults.contract_retail_3yr
  };
  pricingState.currentRates = Object.assign({}, pricingState.originalRates);
  pricingUpdateUIFromState();
  pricingUpdateLockStatus();
  pricingLoadHistory(dealerId);
}

var pricingSyncTimer = null;
function pricingSyncServicesDebounced() {
  clearTimeout(pricingSyncTimer);
  pricingSyncTimer = setTimeout(function() {
    pricingPersistAllServicesToSupabase();
  }, 600);
}

async function pricingPersistAllServicesToSupabase() {
  for (var i = 0; i < pricingModelServices.length; i++) {
    var s = pricingModelServices[i];
    var payload = {
      name: String(s.name || "Service").trim() || "Service",
      retail_price: parseFloat(s.retail) || 0,
      market_avg: parseFloat(s.marketAvg) || 0,
      hours_interval: s.hours != null && s.hours !== "" && !isNaN(Number(s.hours)) ? Number(s.hours) : null,
      is_yearly: !!s.yearly,
      active: true,
      sort_order: i
    };
    try {
      if (s._dbId) {
        await fetch(SUPABASE_URL + "/rest/v1/services?id=eq." + encodeURIComponent(s._dbId), {
          method: "PATCH",
          headers: supabaseHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify(payload)
        });
      } else {
        if (!String(s.name || "").trim() && !(parseFloat(s.retail) > 0)) continue;
        var res = await fetch(SUPABASE_URL + "/rest/v1/services", {
          method: "POST",
          headers: supabaseHeaders({ Prefer: "return=representation" }),
          body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (res.ok && data && data[0] && data[0].id) s._dbId = data[0].id;
      }
    } catch (e) {}
  }
}

function pricingRenderServicesTable() {
  var tbody = document.getElementById("pricing-services-tbody");
  if (!tbody) return;
  pricingModelServices = pricingDedupeModelServices(pricingModelServices);
  var html = "";
  pricingModelServices.forEach(function(s, i) {
    var cap = pricingWpCap(s.marketAvg);
    var mar = pricingWpMarginCell(s.marketAvg);
    html += "<tr data-idx='" + i + "'>";
    html += "<td><input type='text' class='pricing-in-name' data-idx='" + i + "' value='" + escHtml(s.name) + "' /></td>";
    html += "<td><span class='pricing-dollar'>$</span><input type='number' class='pricing-in-retail' data-idx='" + i + "' min='0' step='1' value='" + (parseFloat(s.retail) || 0) + "' /></td>";
    html += "<td><span class='pricing-dollar'>$</span><input type='number' class='pricing-in-mkt' data-idx='" + i + "' min='0' step='1' value='" + (parseFloat(s.marketAvg) || 0) + "' /></td>";
    html += "<td><input type='number' class='pricing-in-hours' data-idx='" + i + "' min='0' step='1' placeholder='hrs' value='" + (s.hours != null && s.hours !== "" ? s.hours : "") + "' /></td>";
    html += "<td style='text-align:center'><input type='checkbox' class='pricing-in-yearly' data-idx='" + i + "' " + (s.yearly ? "checked" : "") + " /></td>";
    html += "<td class='pricing-cycle-cell'>" + escHtml(pricingFormatCycle(s)) + "</td>";
    html += "<td class='pricing-wp-cap'>$" + cap.toLocaleString() + "</td>";
    html += "<td class='pricing-wp-margin-cell'>$" + mar.toLocaleString() + "</td>";
    html += "<td><button type='button' class='btn-sm btn-remove pricing-btn-remove' data-idx='" + i + "'>Remove</button></td>";
    html += "</tr>";
  });
  tbody.innerHTML = html;
}

function pricingSyncRowFromDom(idx) {
  var s = pricingModelServices[idx];
  if (!s) return;
  var row = document.querySelector("#pricing-services-tbody tr[data-idx='" + idx + "']");
  if (!row) return;
  var n = row.querySelector(".pricing-in-name");
  var r = row.querySelector(".pricing-in-retail");
  var m = row.querySelector(".pricing-in-mkt");
  var h = row.querySelector(".pricing-in-hours");
  var y = row.querySelector(".pricing-in-yearly");
  if (n) s.name = n.value;
  if (r) s.retail = parseFloat(r.value) || 0;
  if (m) s.marketAvg = parseFloat(m.value) || 0;
  if (h) {
    var hv = h.value.trim();
    s.hours = hv === "" ? null : parseFloat(hv);
  }
  if (y) s.yearly = y.checked;
}

function pricingUpdateCycleCells() {
  var rows = document.querySelectorAll("#pricing-services-tbody tr");
  rows.forEach(function(row) {
    var idx = parseInt(row.getAttribute("data-idx"), 10);
    if (isNaN(idx) || !pricingModelServices[idx]) return;
    pricingSyncRowFromDom(idx);
    var cell = row.querySelector(".pricing-cycle-cell");
    var cap = row.querySelector(".pricing-wp-cap");
    var mar = row.querySelector(".pricing-wp-margin-cell");
    if (cell) cell.textContent = pricingFormatCycle(pricingModelServices[idx]);
    if (cap) cap.textContent = "$" + pricingWpCap(pricingModelServices[idx].marketAvg).toLocaleString();
    if (mar) mar.textContent = "$" + pricingWpMarginCell(pricingModelServices[idx].marketAvg).toLocaleString();
  });
}

async function pricingRemoveService(idx) {
  var s = pricingModelServices[idx];
  if (s && s._dbId) {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/services?id=eq." + encodeURIComponent(s._dbId), {
        method: "DELETE",
        headers: supabaseHeaders()
      });
    } catch (e) {}
  }
  pricingModelServices.splice(idx, 1);
  pricingRenderServicesTable();
  pricingUpdateAll();
  pricingSyncServicesDebounced();
}

function pricingAddService() {
  pricingModelServices.push({ name: "", retail: 0, marketAvg: 0, hours: null, yearly: false });
  pricingRenderServicesTable();
  pricingUpdateAll();
}

function pricingBindTableDelegation() {
  var tbody = document.getElementById("pricing-services-tbody");
  if (!tbody || tbody.dataset.delegationBound === "1") return;
  tbody.dataset.delegationBound = "1";
  tbody.addEventListener("input", function(e) {
    var t = e.target;
    var idx = t.getAttribute("data-idx");
    if (idx == null) return;
    idx = parseInt(idx, 10);
    pricingSyncRowFromDom(idx);
    pricingSyncServicesDebounced();
    pricingUpdateCycleCells();
    pricingUpdateAll();
  });
  tbody.addEventListener("change", function(e) {
    var t = e.target;
    if (t.classList.contains("pricing-in-yearly")) {
      var idx = parseInt(t.getAttribute("data-idx"), 10);
      pricingSyncRowFromDom(idx);
      pricingSyncServicesDebounced();
      pricingUpdateCycleCells();
      pricingUpdateAll();
    }
  });
  tbody.addEventListener("click", function(e) {
    if (e.target.classList.contains("pricing-btn-remove")) {
      var idx = parseInt(e.target.getAttribute("data-idx"), 10);
      if (!isNaN(idx)) pricingRemoveService(idx);
    }
  });
}

function pricingBindControlsOnce() {
  if (pricingControlsBound) return;
  pricingControlsBound = true;
  var c = document.getElementById("pricing-slider-commission");
  var cl = document.getElementById("pricing-slider-claims");
  var addBtn = document.getElementById("pricing-add-service");
  if (c) {
    c.addEventListener("input", function() {
      if (pricingState.locked) return;
      document.getElementById("pricing-label-commission").textContent = c.value;
      pricingState.currentRates.commission_pct = parseFloat(c.value) || 0;
      pricingSaveSliderPrefs();
      pricingUpdateAll();
      pricingCheckUnsavedChanges();
    });
  }
  if (cl) {
    cl.addEventListener("input", function() {
      document.getElementById("pricing-label-claims").textContent = cl.value;
      pricingSaveSliderPrefs();
      pricingUpdateAll();
    });
  }
  if (addBtn) addBtn.addEventListener("click", pricingAddService);
  pricingBindTableDelegation();
}

function pricingBindStage2Controls() {
  var sel = document.getElementById("pricing-dealer-select");
  if (sel && sel.dataset.bound !== "1") {
    sel.dataset.bound = "1";
    sel.addEventListener("change", function() {
      var dealerId = this.value;
      var dealerName = this.options[this.selectedIndex] ? this.options[this.selectedIndex].dataset.name : "";
      if (!dealerId) return;
      pricingLoadDealerRates(dealerId, dealerName);
    });
  }
  ["1yr", "2yr", "3yr"].forEach(function(yr) {
    var inp = document.getElementById("contract-price-" + yr);
    if (!inp || inp.dataset.bound === "1") return;
    inp.dataset.bound = "1";
    inp.addEventListener("input", function() {
      if (pricingState.locked) return;
      var key = "contract_retail_" + yr;
      pricingState.currentRates[key] = parseFloat(this.value) || 0;
      var changed = pricingState.currentRates[key] !== pricingState.originalRates[key];
      this.style.borderColor = changed ? "#BA7517" : "";
      this.style.background = changed ? "#fffbf0" : "";
      pricingUpdateAll();
      pricingCheckUnsavedChanges();
    });
  });
  var toggle = document.getElementById("pricing-history-toggle");
  if (toggle && toggle.dataset.bound !== "1") {
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", function() {
      var panel = document.getElementById("pricing-history-panel");
      var arrow = document.getElementById("history-arrow");
      if (!panel || !arrow) return;
      if (panel.style.display === "none" || !panel.style.display) {
        panel.style.display = "block";
        arrow.textContent = "▼";
        pricingLoadHistory(pricingState.dealerId);
      } else {
        panel.style.display = "none";
        arrow.textContent = "▶";
      }
    });
  }
  var c1 = document.getElementById("confirm-check-1");
  var c2 = document.getElementById("confirm-check-2");
  var saveBtn = document.getElementById("pricing-modal-save");
  [c1, c2].forEach(function(el) {
    if (!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("change", function() {
      if (!saveBtn) return;
      var both = !!(c1 && c1.checked && c2 && c2.checked);
      saveBtn.disabled = !both;
      saveBtn.style.opacity = both ? "1" : "0.4";
    });
  });
}

function pricingDestroyProfitChart() {
  if (pricingProfitChartInstance) {
    pricingProfitChartInstance.destroy();
    pricingProfitChartInstance = null;
  }
}

function pricingRenderProfitChart() {
  var canvas = document.getElementById("pricing-profit-chart");
  if (!canvas || typeof Chart === "undefined") return;
  var baseline = pricingSumBaseline();
  var cEl = document.getElementById("pricing-slider-commission");
  var comm = cEl ? parseFloat(cEl.value) : 20;
  if (isNaN(comm)) comm = 20;
  var retail1 = pricingCurrentRetail(1);
  var net1 = retail1 - retail1 * (comm / 100);
  var labels = [];
  var data = [];
  var colors = [];
  for (var r = 40; r <= 100; r += 5) {
    labels.push(r + "%");
    var profit = Math.round(net1 - baseline * (r / 100));
    data.push(profit);
    colors.push(profit >= 0 ? "#22c55e" : "#ef4444");
  }
  pricingDestroyProfitChart();
  pricingProfitChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "WP profit (1-yr)",
        data: data,
        borderColor: "#b8963e",
        backgroundColor: "rgba(184,150,62,0.1)",
        tension: 0.2,
        fill: false,
        pointRadius: 5,
        pointBackgroundColor: colors,
        pointBorderColor: colors
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return "Profit: $" + ctx.parsed.y.toLocaleString();
            }
          }
        }
      },
      scales: {
        y: {
          ticks: { color: "#6b8599", callback: function(v) { return "$" + v; } },
          grid: { color: "rgba(130,160,180,0.15)" }
        },
        x: { ticks: { color: "#6b8599" }, grid: { display: false } }
      }
    }
  });
}

function pricingUpdateBreakevenNote(baseline, commPct) {
  var el = document.getElementById("pricing-breakeven-note");
  if (!el) return;
  var retail1 = pricingCurrentRetail(1);
  var net1 = retail1 - retail1 * (commPct / 100);
  var profits = [];
  for (var r = 40; r <= 100; r += 5) {
    profits.push(Math.round(net1 - baseline * (r / 100)));
  }
  var allPos = profits.every(function(p) { return p > 0; });
  var allNeg = profits.every(function(p) { return p < 0; });
  if (baseline <= 0) {
    el.textContent = "Add retail prices to model baseline cost.";
    el.style.color = "#6b8599";
    return;
  }
  if (allPos) {
    el.textContent = "Profitable at all modeled claims rates (40%–100%).";
    el.style.color = "#1b5e20";
    return;
  }
  if (allNeg) {
    el.textContent = "Loss at all modeled claims rates — review baseline or pricing.";
    el.style.color = "#c0392b";
    return;
  }
  var be = net1 / baseline * 100;
  el.textContent = "Breakeven claims rate ≈ " + be.toFixed(1) + "% (where 1-yr WP profit crosses $0).";
  el.style.color = "#c0392b";
}

function pricingFillContractLines(elId, retail, months, years) {
  var el = document.getElementById(elId);
  if (!el) return;
  var cEl = document.getElementById("pricing-slider-commission");
  var clEl = document.getElementById("pricing-slider-claims");
  var comm = cEl ? parseFloat(cEl.value) : 20;
  var claims = clEl ? parseFloat(clEl.value) : 70;
  if (isNaN(comm)) comm = 20;
  if (isNaN(claims)) claims = 70;
  var baseline = pricingSumBaseline();
  var monthly = retail / months;
  var prepay = retail * 0.95;
  var commission = retail * (comm / 100);
  var serviceCost = baseline * (claims / 100) * years;
  var profit = retail - commission - serviceCost;
  var marginPct = retail > 0 ? (profit / retail) * 100 : 0;
  var profitPerYear = profit / years;
  var pcls = profit >= 0 ? "profit-pos" : "profit-neg";
  var html = "";
  html += "<div><span>Monthly payment</span><span>$" + monthly.toFixed(2) + "</span></div>";
  html += "<div><span>Prepay (5% discount)</span><span>$" + Math.round(prepay).toLocaleString() + "</span></div>";
  html += "<div><span>Commission (one-time)</span><span>$" + Math.round(commission).toLocaleString() + "</span></div>";
  html += "<div><span>Est. service cost (" + years + " yr)</span><span>$" + Math.round(serviceCost).toLocaleString() + "</span></div>";
  html += "<div><span>Total WP profit</span><span class='" + pcls + "'>$" + Math.round(profit).toLocaleString() + "</span></div>";
  html += "<div><span>Margin %</span><span class='" + pcls + "'>" + marginPct.toFixed(1) + "%</span></div>";
  html += "<div><span>Profit per year</span><span class='" + pcls + "'>$" + Math.round(profitPerYear).toLocaleString() + "</span></div>";
  el.innerHTML = html;
}

function pricingUpdateAll() {
  var baseline = pricingSumBaseline();
  var cEl = document.getElementById("pricing-slider-commission");
  var clEl = document.getElementById("pricing-slider-claims");
  var comm = cEl ? parseFloat(cEl.value) : 20;
  var claims = clEl ? parseFloat(clEl.value) : 70;
  if (isNaN(comm)) comm = 20;
  if (isNaN(claims)) claims = 70;
  if (document.getElementById("pricing-label-commission")) document.getElementById("pricing-label-commission").textContent = String(comm);
  if (document.getElementById("pricing-label-claims")) document.getElementById("pricing-label-claims").textContent = String(claims);
  var annualCost = baseline * (claims / 100);
  var RETAIL1 = pricingCurrentRetail(1);
  var RETAIL2 = pricingCurrentRetail(2);
  var RETAIL3 = pricingCurrentRetail(3);
  var oneTimeComm = RETAIL1 * (comm / 100);
  var wpMargin1 = RETAIL1 - oneTimeComm - annualCost;
  var sb = document.getElementById("pricing-stat-baseline");
  var sa = document.getElementById("pricing-stat-annual");
  var sc = document.getElementById("pricing-stat-commission");
  var sw = document.getElementById("pricing-stat-wp-margin");
  var wrap = document.getElementById("pricing-stat-wp-wrap");
  if (sb) sb.textContent = "$" + Math.round(baseline).toLocaleString();
  if (sa) sa.textContent = "$" + Math.round(annualCost).toLocaleString();
  if (sc) sc.textContent = "$" + Math.round(oneTimeComm).toLocaleString();
  if (sw) sw.textContent = "$" + Math.round(wpMargin1).toLocaleString();
  if (wrap) wrap.className = "stat-card pricing-stat " + (wpMargin1 >= 0 ? "positive" : "negative");
  var c1 = document.getElementById("pricing-c1-retail");
  var c2 = document.getElementById("pricing-c2-retail");
  var c3 = document.getElementById("pricing-c3-retail");
  if (c1) c1.textContent = "$" + Math.round(RETAIL1).toLocaleString();
  if (c2) c2.textContent = "$" + Math.round(RETAIL2).toLocaleString();
  if (c3) c3.textContent = "$" + Math.round(RETAIL3).toLocaleString();
  pricingFillContractLines("pricing-c1-lines", RETAIL1, 12, 1);
  pricingFillContractLines("pricing-c2-lines", RETAIL2, 24, 2);
  pricingFillContractLines("pricing-c3-lines", RETAIL3, 36, 3);
  pricingUpdateBreakevenNote(baseline, comm);
  pricingDestroyProfitChart();
  pricingRenderProfitChart();
}

function pricingInitOnTab() {
  if (!pricingTabInitialized) {
    pricingTabInitialized = true;
    pricingBindControlsOnce();
    pricingBindStage2Controls();
    pricingLoadDealers();
    var tbody = document.getElementById("pricing-services-tbody");
    if (tbody) tbody.innerHTML = "<tr><td colspan='9'>Loading services…</td></tr>";
    pricingLoadFromSupabase()
      .then(function() {
        pricingRenderServicesTable();
        var c = document.getElementById("pricing-slider-commission");
        var cl = document.getElementById("pricing-slider-claims");
        if (c && document.getElementById("pricing-label-commission")) document.getElementById("pricing-label-commission").textContent = c.value;
        if (cl && document.getElementById("pricing-label-claims")) document.getElementById("pricing-label-claims").textContent = cl.value;
        pricingUpdateAll();
      })
      .catch(function() {
        pricingRenderServicesTable();
        pricingUpdateAll();
      });
  } else {
    pricingBindStage2Controls();
    pricingLoadDealers();
    var c2 = document.getElementById("pricing-slider-commission");
    var cl2 = document.getElementById("pricing-slider-claims");
    if (c2 && document.getElementById("pricing-label-commission")) document.getElementById("pricing-label-commission").textContent = c2.value;
    if (cl2 && document.getElementById("pricing-label-claims")) document.getElementById("pricing-label-claims").textContent = cl2.value;
    pricingUpdateAll();
  }
}

function applyAdminTabVisibility() {
  applicationsRefreshTabBadgeOnly();
}

function resetAdminTabVisibility() {
  applicationsUpdateTabBadge(0);
}

function adminNormalizeName(s) {
  return String(s || "").trim().toLowerCase();
}

function adminNetworkCustomerKey(t) {
  var d = String(t.dealership || "").trim().toLowerCase();
  var ck = customerKey(t);
  if (!ck) return "";
  return d + "|" + ck;
}

function adminIsInLast30Days(t) {
  var d = parseTicketDate(t);
  if (!d) return false;
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  cutoff.setHours(0, 0, 0, 0);
  return d >= cutoff;
}

function adminIsThisMonth(t) {
  var d = parseTicketDate(t);
  if (!d) return false;
  var n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
}

function adminTicketsForDealer(dealerName) {
  var want = adminNormalizeName(dealerName);
  return adminNetworkTickets.filter(function(t) {
    return adminNormalizeName(t.dealership) === want;
  });
}

function adminFetchAllTickets() {
  return fetch(SUPABASE_URL + "/rest/v1/tickets?select=*&order=created_at.desc", {
    headers: supabaseHeaders()
  })
    .then(function(r) {
      if (!r.ok) throw new Error();
      return r.json();
    })
    .then(function(rows) {
      return Array.isArray(rows) ? rows.map(mapTicketFromRow) : [];
    })
    .catch(function() { return []; });
}

function adminCountServicesCompleted(tickets) {
  var n = 0;
  tickets.forEach(function(t) {
    var st = (t.serviceType || "").trim();
    if (!st) { n += 1; return; }
    var parts = st.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    n += parts.length || 1;
  });
  return n;
}

function adminFetchContractsSummary() {
  return fetch(SUPABASE_URL + "/rest/v1/contracts?status=eq.active&select=id,retail_price", {
    headers: supabaseHeaders()
  })
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (!Array.isArray(rows)) return { count: 0, revenue: 0 };
      var revenue = rows.reduce(function(s, x) { return s + (parseFloat(x.retail_price) || 0); }, 0);
      return { count: rows.length, revenue: revenue };
    })
    .catch(function() { return { count: 0, revenue: 0 }; });
}

function adminFetchReimbursementsPaidTotal() {
  return fetch(SUPABASE_URL + "/rest/v1/reimbursements?status=eq.paid&select=amount", {
    headers: supabaseHeaders()
  })
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (!Array.isArray(rows)) return { paidTotal: 0 };
      var t = rows.reduce(function(s, x) { return s + (parseFloat(x.amount) || 0); }, 0);
      return { paidTotal: t };
    })
    .catch(function() { return { paidTotal: 0 }; });
}

function adminFetchRenewalsContracts() {
  return fetch(SUPABASE_URL + "/rest/v1/contracts?status=eq.active&select=*", {
    headers: supabaseHeaders()
  })
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (!Array.isArray(rows)) return [];
      var now = new Date();
      now.setHours(0, 0, 0, 0);
      return rows.filter(function(c) {
        if (!c.end_date) return false;
        var d = new Date(c.end_date);
        d.setHours(0, 0, 0, 0);
        var days = Math.round((d - now) / 86400000);
        return days >= 0 && days <= 90;
      });
    })
    .catch(function() { return []; });
}

function fetchDealersSupabase() {
  return fetch(SUPABASE_URL + "/rest/v1/dealers?select=*&order=created_at.asc", {
    headers: supabaseHeaders()
  })
    .then(function(r) { return r.json(); })
    .then(function(rows) { return Array.isArray(rows) ? rows : []; })
    .catch(function() { return []; });
}

function adminFetchAllContracts() {
  return fetch(SUPABASE_URL + "/rest/v1/contracts?select=*&order=created_at.desc", {
    headers: supabaseHeaders()
  })
    .then(function(r) {
      if (!r.ok) throw new Error();
      return r.json();
    })
    .then(function(rows) {
      return Array.isArray(rows) ? rows : [];
    })
    .catch(function() {
      return [];
    });
}

function adminRenderStats() {
  var c = adminDashboardMetrics.count;
  var revenue = adminDashboardMetrics.revenue;
  var paidReimb = adminReimburseMetrics.paidTotal;
  var commission = revenue * ADMIN_COMMISSION_RATE;
  var margin = revenue - paidReimb - commission;
  var elC = document.getElementById("admin-stat-contracts");
  var elR = document.getElementById("admin-stat-revenue");
  var elB = document.getElementById("admin-stat-reimb");
  var elM = document.getElementById("admin-stat-margin");
  if (elC) elC.textContent = c.toLocaleString();
  if (elR) elR.textContent = "$" + Math.round(revenue).toLocaleString();
  if (elB) elB.textContent = "$" + Math.round(paidReimb).toLocaleString();
  if (elM) elM.textContent = "$" + Math.round(margin).toLocaleString();
}

function adminRenderChart() {
  var canvas = document.getElementById("admin-network-chart");
  if (!canvas || typeof Chart === "undefined") return;
  var y = new Date().getFullYear();
  var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  adminNetworkTickets.forEach(function(t) {
    var d = parseTicketDate(t);
    if (!d || d.getFullYear() !== y) return;
    counts[d.getMonth()]++;
  });
  if (adminChartInstance) {
    adminChartInstance.destroy();
    adminChartInstance = null;
  }
  adminChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
      datasets: [{
        label: "Tickets",
        data: counts,
        backgroundColor: "#b8963e",
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { color: "#6b8599" }, grid: { color: "rgba(130,160,180,0.15)" } },
        x: { ticks: { color: "#6b8599" }, grid: { display: false } }
      }
    }
  });
}

function adminRenderLeaderboard() {
  var rows = [];
  dealerRowsCache.forEach(function(dealer) {
    if (dealer.is_admin || !dealer.active) return;
    var tk = adminTicketsForDealer(dealer.dealership_name);
    var count = tk.length;
    var lastDate = null;
    tk.forEach(function(t) {
      var dt = parseTicketDate(t);
      if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
    });
    var lastStr = lastDate ? lastDate.toLocaleDateString() : "—";
    var estCont = count > 0 ? Math.ceil(count / 3) : 0;
    var billCount = tk.filter(ticketBillable).length;
    var estReimb = billCount * ADMIN_AVG_REIMB;
    var statusBadge;
    var statusClass;
    if (count === 0) {
      statusBadge = "No data";
      statusClass = "badge-nodata";
    } else {
      var daysSince = (new Date() - lastDate) / 86400000;
      if (daysSince <= 30) {
        statusBadge = "Active";
        statusClass = "badge-active";
      } else {
        statusBadge = "Inactive";
        statusClass = "admin-lb-inactive";
      }
    }
    rows.push({
      name: dealer.dealership_name,
      count: count,
      estCont: estCont,
      estReimb: estReimb,
      lastStr: lastStr,
      statusBadge: statusBadge,
      statusClass: statusClass
    });
  });
  rows.sort(function(a, b) { return b.count - a.count; });
  var tbody = document.getElementById("admin-leaderboard-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  rows.forEach(function(r, idx) {
    var tr = document.createElement("tr");
    if (idx === 0 && r.count > 0) tr.className = "admin-row-top";
    var rankCell = String(idx + 1);
    if (idx === 0 && r.count > 0) rankCell += " <span class='top-badge'>Top Performer</span>";
    tr.innerHTML = "<td>" + rankCell + "</td>" +
      "<td>" + escHtml(r.name) + "</td>" +
      "<td>" + r.count + "</td>" +
      "<td>" + r.estCont + "</td>" +
      "<td>$" + r.estReimb.toLocaleString() + "</td>" +
      "<td>" + escHtml(r.lastStr) + "</td>" +
      "<td><span class='" + r.statusClass + "'>" + r.statusBadge + "</span></td>";
    tbody.appendChild(tr);
  });
}

function adminRenderFlags() {
  var follow = [];
  var good = [];
  dealerRowsCache.forEach(function(dealer) {
    if (dealer.is_admin || !dealer.active) return;
    var tk = adminTicketsForDealer(dealer.dealership_name);
    var last30 = tk.filter(adminIsInLast30Days).length;
    if (last30 === 0) follow.push(dealer.dealership_name);
    var thisMo = tk.filter(adminIsThisMonth).length;
    if (thisMo >= 3) good.push(dealer.dealership_name);
  });
  var flEl = document.getElementById("admin-followup-list");
  var gEl = document.getElementById("admin-performing-list");
  if (flEl) {
    if (follow.length === 0) flEl.innerHTML = "<div class='admin-pill-empty'>None — all dealers have recent ticket activity.</div>";
    else flEl.innerHTML = follow.map(function(n) {
      return "<div class='admin-pill admin-pill-warn'><strong>" + escHtml(n) + "</strong><span>Call them</span></div>";
    }).join("");
  }
  if (gEl) {
    if (good.length === 0) gEl.innerHTML = "<div class='admin-pill-empty'>None yet this month.</div>";
    else gEl.innerHTML = good.map(function(n) {
      return "<div class='admin-pill admin-pill-good'><strong>" + escHtml(n) + "</strong></div>";
    }).join("");
  }
}

function adminRenderRenewalsNetwork() {
  var el = document.getElementById("admin-renewals-body");
  if (!el) return;
  if (!adminRenewalContracts.length) {
    el.innerHTML = "<div class='renewals-empty'>No renewals due in the next 90 days.</div>";
    return;
  }
  var rows = adminRenewalContracts.map(function(c) {
    var name = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim() || "Customer";
    var dealership = (c.dealership_name || "—").trim();
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var d = new Date(c.end_date);
    d.setHours(0, 0, 0, 0);
    var days = Math.round((d - now) / 86400000);
    var badgeClass = days <= 30 ? "urgent" : days <= 60 ? "soon" : "upcoming";
    return { name: name, dealership: dealership, days: days, badgeClass: badgeClass };
  });
  rows.sort(function(a, b) { return a.days - b.days; });
  el.innerHTML = rows.map(function(r) {
    return "<div class='admin-renewal-row'><div><div class='renewal-name'>" + escHtml(r.name) + "</div><div class='renewal-boat'>" + escHtml(r.dealership) + "</div></div><span class='renewal-badge " + r.badgeClass + "'>" + r.days + " days until renewal</span></div>";
  }).join("");
}

function adminRenderFinancialHealth() {
  var tk = adminNetworkTickets;
  var totalT = tk.length;
  var contracts = totalT > 0 ? Math.ceil(totalT / 3) : 0;
  var possible = contracts * 10;
  var completed = adminCountServicesCompleted(tk);
  var rate = possible > 0 ? (completed / possible) * 100 : 0;
  var claimsEl = document.getElementById("admin-health-claims");
  var barEl = document.getElementById("admin-health-bar");
  var warnEl = document.getElementById("admin-health-warning");
  var projEl = document.getElementById("admin-health-projected");
  if (claimsEl) claimsEl.textContent = rate.toFixed(1) + "%";
  if (barEl) {
    barEl.style.width = Math.min(100, Math.max(0, rate)) + "%";
    barEl.className = "admin-health-bar-fill " + (rate < 70 ? "health-green" : rate <= 85 ? "health-amber" : "health-red");
  }
  if (warnEl) {
    warnEl.style.display = rate >= 78 && rate <= 85 ? "block" : "none";
  }
  var last30 = tk.filter(adminIsInLast30Days).filter(ticketBillable).length;
  var projected = last30 * ADMIN_AVG_REIMB;
  if (projEl) projEl.textContent = "$" + Math.round(projected).toLocaleString() + " / mo est. (billable tickets, last 30 days)";
}

function formatContractDateShort(ds) {
  if (!ds) return "—";
  try {
    return new Date(ds).toLocaleDateString();
  } catch (e) {
    return String(ds);
  }
}

function renderAdminMasterTable() {
  var tbody = document.getElementById("admin-master-tbody");
  var inp = document.getElementById("admin-customer-search");
  if (!tbody) return;
  if (tbody.dataset.clickBound !== "1") {
    tbody.dataset.clickBound = "1";
    tbody.addEventListener("click", function(e) {
      var tr = e.target.closest("tr.admin-mc-summary");
      if (!tr) return;
      var next = tr.nextElementSibling;
      if (next && next.classList.contains("admin-mc-detail")) {
        next.style.display = next.style.display === "none" ? "table-row" : "none";
      }
    });
  }
  if (inp && inp.dataset.bound !== "1") {
    inp.dataset.bound = "1";
    inp.addEventListener("input", function() {
      renderAdminMasterTable();
    });
  }
  var q = (inp && inp.value ? inp.value : "").toLowerCase().trim();
  var rows = adminContractsCache.filter(function(c) {
    if (!q) return true;
    var blob = [
      c.customer_first_name,
      c.customer_last_name,
      c.customer_email,
      c.customer_phone,
      c.boat_make,
      c.boat_model,
      c.boat_year,
      c.hin,
      c.dealership_name,
      c.engine_type,
      c.notes
    ]
      .map(function(x) {
        return String(x || "").toLowerCase();
      })
      .join(" ");
    return blob.indexOf(q) !== -1;
  });
  if (rows.length === 0) {
    tbody.innerHTML = "<tr><td colspan='8' style='text-align:center;padding:1rem;color:var(--light);'>No contracts match your search.</td></tr>";
    return;
  }
  var html = "";
  rows.forEach(function(c) {
    var name = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim() || "—";
    var boat = [c.boat_make, c.boat_model, c.boat_year].filter(Boolean).join(" ") || "—";
    var st = contractCardStatus(c);
    html += "<tr class='admin-mc-summary'>";
    html += "<td>" + escHtml(name) + "</td>";
    html += "<td>" + escHtml(c.dealership_name || "—") + "</td>";
    html += "<td>" + escHtml(boat) + "</td>";
    html += "<td>" + escHtml(c.hin || "—") + "</td>";
    html += "<td>" + escHtml(String(c.contract_type || "—")) + "</td>";
    html += "<td><span class='" + escHtml(st.cls) + "' style='font-size:11px;'>" + escHtml(st.label) + "</span></td>";
    html += "<td>" + escHtml(formatContractDateShort(c.start_date)) + "</td>";
    html += "<td>" + escHtml(formatContractDateShort(c.end_date)) + "</td>";
    html += "</tr>";
    html += "<tr class='admin-mc-detail' style='display:none'><td colspan='8'>";
    html += "<div class='admin-mc-detail-inner'>";
    html += "<div><span>Email</span>" + escHtml(c.customer_email || "—") + "</div>";
    html += "<div><span>Phone</span>" + escHtml(c.customer_phone || "—") + "</div>";
    html += "<div><span>Engine type</span>" + escHtml(c.engine_type || "—") + "</div>";
    html += "<div><span>HIN</span>" + escHtml(c.hin || "—") + "</div>";
    html += "<div style='grid-column:1/-1;'><span>Notes</span>" + escHtml(c.notes || "—") + "</div>";
    html += "</div></td></tr>";
  });
  tbody.innerHTML = html;
}

async function loadAdminHinConflicts() {
  var el = document.getElementById("admin-hin-conflicts-body");
  if (!el) return;
  el.textContent = "Loading…";
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/hin_conflicts?resolved=eq.false&select=*&order=created_at.desc",
      { headers: supabaseHeaders() }
    );
    var rows = await res.json();
    if (!res.ok) throw new Error();
    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = "<div class='admin-hin-empty'>No HIN conflicts — all clear.</div>";
      return;
    }
    el.innerHTML = rows
      .map(function(r) {
        var dt = r.created_at ? new Date(r.created_at).toLocaleString() : "—";
        return (
          "<div class='admin-hin-conflict-row' data-hin-cid='" +
          escHtml(String(r.id)) +
          "'>" +
          "<div><strong>HIN</strong> " +
          escHtml(r.hin || "—") +
          "</div>" +
          "<div style='font-size:12px;margin-top:0.35rem;'>Dealer: " +
          escHtml(r.attempted_by_dealer || "—") +
          " · Attempted: " +
          escHtml(r.attempted_customer_name || "—") +
          "</div>" +
          "<div style='font-size:12px;'>Existing customer: " +
          escHtml(r.existing_customer_name || "—") +
          " (" +
          escHtml(r.existing_contract_status || "—") +
          ")</div>" +
          "<div style='font-size:11px;color:var(--light);margin-top:0.25rem;'>" +
          escHtml(r.reason || "") +
          " · " +
          escHtml(dt) +
          "</div>" +
          "<button type='button' class='btn-hin-resolve' data-hin-cid='" +
          escHtml(String(r.id)) +
          "'>Mark resolved</button>" +
          "</div>"
        );
      })
      .join("");
    el.querySelectorAll(".btn-hin-resolve").forEach(function(btn) {
      btn.addEventListener("click", async function() {
        var id = btn.getAttribute("data-hin-cid");
        try {
          var patch = await fetch(SUPABASE_URL + "/rest/v1/hin_conflicts?id=eq." + encodeURIComponent(id), {
            method: "PATCH",
            headers: supabaseHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ resolved: true, resolved_by: "admin", resolved_at: new Date().toISOString() })
          });
          if (!patch.ok) throw new Error();
          await writeAuditLog("hin_conflict", id, "conflict_resolved", null, null, "admin", null, null);
          loadAdminHinConflicts();
        } catch (e) {
          alert("Could not update. Please try again.");
        }
      });
    });
  } catch (e) {
    el.innerHTML = "<div class='admin-hin-empty'>Could not load HIN conflicts. If this is new, run the SQL migration for <code>hin_conflicts</code> in Supabase.</div>";
  }
}

async function adminLoadActivityFeed() {
  var el = document.getElementById("activity-feed-admin");
  if (!el) return;
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/audit_log?select=*&order=created_at.desc&limit=25",
      { headers: authHeaders() }
    );
    var logs = await res.json() || [];
    if (!logs || logs.length === 0) {
      el.innerHTML = "<div style='color:var(--light);font-size:13px;padding:1rem 0;'>No activity yet.</div>";
      return;
    }
    var actionIcons = {
      ticket_submitted: { icon: "📋", color: "#1a5276" },
      ticket_approved: { icon: "✓", color: "#0F6E56" },
      ticket_rejected: { icon: "✗", color: "#c0392b" },
      reimbursement_paid: { icon: "💰", color: "#0F6E56" },
      reimbursement_rejected: { icon: "↩", color: "#c0392b" },
      customer_enrolled: { icon: "⚓", color: "#b8963e" },
      application_approved: { icon: "🤝", color: "#0F6E56" },
      application_declined: { icon: "✗", color: "#c0392b" },
      conflict_resolved: { icon: "🔓", color: "#0F6E56" }
    };
    el.innerHTML = logs.map(function(l) {
      var meta = actionIcons[l.action] || { icon: "●", color: "#6b8599" };
      var label = String(l.action || "activity").replace(/_/g, " ");
      return "<div style='display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);'>" +
        "<div style='width:24px;height:24px;border-radius:50%;background:" + meta.color + ";color:white;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;'>" + meta.icon + "</div>" +
        "<div style='flex:1;'>" +
        "<span style='font-size:13px;font-weight:500;color:var(--navy);'>" + escHtml(label) + "</span>" +
        (l.dealer_name ? "<span style='font-size:12px;color:var(--light);'> — " + escHtml(l.dealer_name) + "</span>" : "") +
        (l.customer_name ? "<span style='font-size:12px;color:var(--light);'> · " + escHtml(l.customer_name) + "</span>" : "") +
        "<div style='font-size:11px;color:var(--light);'>" + escHtml(new Date(l.created_at).toLocaleString()) + "</div>" +
        "</div></div>";
    }).join("");
  } catch (e) {
    el.innerHTML = "<div style='color:var(--light);font-size:13px;padding:1rem 0;'>Could not load activity feed.</div>";
  }
}

async function adminLoadRecentPricingChanges() {
  var el = document.getElementById("admin-pricing-feed");
  if (!el) return;
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/audit_log?entity_type=eq.pricing&select=*&order=created_at.desc&limit=20",
      { headers: authHeaders() }
    );
    var logs = await res.json() || [];
    if (!logs.length) {
      el.innerHTML = "<div style='color:var(--light);font-size:13px;padding:0.5rem 0;'>No pricing changes yet.</div>";
      return;
    }
    el.innerHTML = logs.map(function(l) {
      var label = String(l.action || "pricing update").replace(/_/g, " ");
      return "<div style='padding:8px 0;border-bottom:1px solid var(--border);'>" +
        "<div style='font-size:13px;color:var(--navy);font-weight:500;'>" + escHtml(label) + "</div>" +
        "<div style='font-size:12px;color:var(--light);'>" + escHtml(l.dealer_name || "—") + " · " + escHtml(new Date(l.created_at).toLocaleString()) + "</div>" +
        "</div>";
    }).join("");
  } catch (e) {
    el.innerHTML = "<div style='color:var(--light);font-size:13px;padding:0.5rem 0;'>Could not load pricing changes.</div>";
  }
}

async function pricingLoadHistory() {
  if (!pricingState.dealerName) return;
  var el = document.getElementById("pricing-history-panel");
  if (!el) return;
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/audit_log?entity_type=eq.pricing&dealer_name=eq." + encodeURIComponent(pricingState.dealerName) + "&select=*&order=created_at.desc&limit=30",
      { headers: authHeaders() }
    );
    var logs = await res.json() || [];
    if (!logs || logs.length === 0) {
      el.innerHTML = "<div style='font-size:13px;color:var(--light);padding:0.5rem 0;'>No pricing history yet.</div>";
      return;
    }
    el.innerHTML = "<div style='border-left:2px solid var(--border);padding-left:1rem;'>" +
      logs.map(function(l) {
        var actionColors = { pricing_confirmed: "#0F6E56", pricing_unlocked: "#c0392b", pricing_rate_changed: "#BA7517", contract_price_changed: "#BA7517", contract_generated: "#1a5276" };
        var color = actionColors[l.action] || "#6b8599";
        var label = String(l.action || "pricing change").replace(/_/g, " ");
        return "<div style='margin-bottom:0.75rem;position:relative;'>" +
          "<div style='position:absolute;left:-1.3rem;top:4px;width:10px;height:10px;border-radius:50%;background:" + color + ";'></div>" +
          "<div style='font-size:12px;font-weight:600;color:" + color + ";'>" + escHtml(label) + "</div>" +
          "<div style='font-size:11px;color:var(--light);'>" + escHtml(new Date(l.created_at).toLocaleString()) + (l.performed_by ? " · " + escHtml(l.performed_by) : "") + "</div>" +
          "</div>";
      }).join("") +
      "</div>";
  } catch (e) {
    el.innerHTML = "<div style='font-size:13px;color:var(--light);padding:0.5rem 0;'>Could not load pricing history.</div>";
  }
}

function generateDealerContractPDF() {
  var dealer = pricingState.dealerName;
  var rates = pricingState.currentRates || pricingDefaultRates();
  if (!dealer) return;
  var now = new Date();
  var dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  var version = "v" + now.getFullYear() + ("0" + (now.getMonth() + 1)).slice(-2) + ("0" + now.getDate()).slice(-2);
  var pct = String(rates.commission_pct != null ? rates.commission_pct : "");
  var r1 = Math.round(rates.contract_retail_1yr || 0).toLocaleString();
  var r2 = Math.round(rates.contract_retail_2yr || 0).toLocaleString();
  var r3 = Math.round(rates.contract_retail_3yr || 0).toLocaleString();
  var reimb = Math.round(rates.reimbursement_rate || 0).toLocaleString();
  var dealerEsc = escHtml(dealer);
  var html = "<!DOCTYPE html>\n" +
"<html>\n" +
"<head>\n" +
"<meta charset=\"UTF-8\">\n" +
"<title>Whitestone Partners — Dealer Services Agreement</title>\n" +
"<style>\n" +
"  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600&family=DM+Sans:wght@300;400;500&display=swap');\n" +
"  * { box-sizing: border-box; margin: 0; padding: 0; }\n" +
"  body { font-family: 'DM Sans', Georgia, serif; font-size: 10.5pt; line-height: 1.7; color: #1a1a1a; background: white; }\n" +
"  .page { max-width: 750px; margin: 0 auto; padding: 60px 70px; }\n" +
"  .header { text-align: center; border-bottom: 3px solid #0c1e2e; padding-bottom: 28px; margin-bottom: 32px; }\n" +
"  .header-logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26pt; font-weight: 300; color: #0c1e2e; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }\n" +
"  .header-sub { font-size: 8pt; letter-spacing: 0.2em; text-transform: uppercase; color: #b8963e; margin-bottom: 16px; }\n" +
"  .doc-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18pt; font-weight: 600; color: #0c1e2e; margin-bottom: 6px; }\n" +
"  .doc-meta { font-size: 8.5pt; color: #6b8599; }\n" +
"  .conf-badge { display: inline-block; background: #0c1e2e; color: white; font-size: 7.5pt; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; padding: 4px 14px; border-radius: 2px; margin-top: 10px; }\n" +
"  .section { margin-bottom: 28px; }\n" +
"  .section-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 13pt; font-weight: 600; color: #0c1e2e; border-bottom: 1.5px solid #b8963e; padding-bottom: 5px; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.06em; }\n" +
"  .section-number { color: #b8963e; margin-right: 8px; }\n" +
"  .clause { margin-bottom: 10px; }\n" +
"  .clause-num { font-weight: 600; color: #0c1e2e; margin-right: 6px; }\n" +
"  p { margin-bottom: 10px; font-size: 10pt; }\n" +
"  .pricing-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 9.5pt; }\n" +
"  .pricing-table th { background: #0c1e2e; color: white; padding: 7px 12px; text-align: left; font-size: 8pt; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }\n" +
"  .pricing-table td { padding: 7px 12px; border-bottom: 1px solid #eef0f3; }\n" +
"  .pricing-table tr:nth-child(even) td { background: #f8f9fb; }\n" +
"  .highlight-box { background: #f0f4f8; border: 1px solid #c5d4e0; border-left: 4px solid #0c1e2e; border-radius: 4px; padding: 14px 18px; margin: 14px 0; font-size: 9.5pt; }\n" +
"  .party-line { font-size: 10.5pt; margin-bottom: 6px; }\n" +
"  .party-label { font-weight: 600; color: #0c1e2e; }\n" +
"  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #dde3ea; display: flex; justify-content: space-between; align-items: center; }\n" +
"  .footer-left { font-size: 7.5pt; color: #9aafbf; }\n" +
"  .footer-right { font-size: 7.5pt; color: #b8963e; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }\n" +
"  .gold-bar { height: 4px; background: linear-gradient(90deg, #b8963e, #d4ac52, #b8963e); }\n" +
"  @media print { body { font-size: 10pt; } .page { padding: 40px 50px; } }\n" +
"</style>\n" +
"</head>\n" +
"<body>\n" +
"<div class=\"gold-bar\"></div>\n" +
"<div class=\"page\">\n" +
"  <div class=\"header\">\n" +
"    <div class=\"header-logo-text\">Whitestone Partners</div>\n" +
"    <div class=\"header-sub\">Certified Marine Dealer Program</div>\n" +
"    <div class=\"doc-title\">Dealer Services Agreement</div>\n" +
"    <div class=\"doc-meta\">Confidential — For authorized dealer use only · Generated " + escHtml(dateStr) + " · " + escHtml(version) + "</div>\n" +
"    <div><span class=\"conf-badge\">Confidential</span></div>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"party-line\"><span class=\"party-label\">Dealer:</span> " + dealerEsc + "</div>\n" +
"    <div class=\"party-line\"><span class=\"party-label\">Agreement date:</span> " + escHtml(dateStr) + "</div>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">2.1</span>Dealer commission</div>\n" +
"    <p>The dealer earns a one-time commission of <strong>" + escHtml(pct) + "%</strong> on qualifying contract sales in accordance with Whitestone Partners program rules.</p>\n" +
"    <table class=\"pricing-table\">\n" +
"      <thead><tr><th>Term</th><th>Contract retail price</th></tr></thead>\n" +
"      <tbody>\n" +
"        <tr><td>1-year contract</td><td>$" + escHtml(r1) + "</td></tr>\n" +
"        <tr><td>2-year contract</td><td>$" + escHtml(r2) + "</td></tr>\n" +
"        <tr><td>3-year contract</td><td>$" + escHtml(r3) + "</td></tr>\n" +
"      </tbody>\n" +
"    </table>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">2.2</span>Service reimbursements</div>\n" +
"    <p>The dealer is reimbursed at a rate of <strong>$" + escHtml(reimb) + "</strong> per approved service ticket submitted through the Whitestone Partners portal.</p>\n" +
"    <div class=\"highlight-box\"><strong>Documentation:</strong> Service records must be logged in the Whitestone Partners system for reimbursement eligibility.</div>\n" +
"  </div>\n" +
"  <div class=\"footer\">\n" +
"    <div class=\"footer-left\">Whitestone Partners LLC &nbsp;|&nbsp; St. George, Utah &nbsp;|&nbsp; support@whitestone-partners.com</div>\n" +
"    <div class=\"footer-right\">Dealer copy</div>\n" +
"  </div>\n" +
"</div>\n" +
"<div class=\"gold-bar\"></div>\n" +
"<script>\n" +
"  window.onload = function() { window.print(); }\n" +
"</script>\n" +
"</body>\n" +
"</html>";
  var printWindow = window.open("", "_blank", "width=900,height=700");
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
  writeAuditLog("pricing", pricingState.pricingId, "contract_generated", null, { dealer: dealer, version: version, date: dateStr }, dealer, null, "Dealer contract PDF generated");
}

function downloadCustomerContract() {
  var html = "<!DOCTYPE html>\n" +
"<html>\n" +
"<head>\n" +
"<meta charset=\"UTF-8\">\n" +
"<title>Whitestone Partners — Annual Boat Service Contract</title>\n" +
"<style>\n" +
"  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600&family=DM+Sans:wght@300;400;500&display=swap');\n" +
"  * { box-sizing: border-box; margin: 0; padding: 0; }\n" +
"  body { font-family: 'DM Sans', Georgia, serif; font-size: 10.5pt; line-height: 1.7; color: #1a1a1a; background: white; }\n" +
"  .page { max-width: 750px; margin: 0 auto; padding: 60px 70px; }\n" +
"  .header { text-align: center; border-bottom: 3px solid #0c1e2e; padding-bottom: 28px; margin-bottom: 32px; }\n" +
"  .header-logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26pt; font-weight: 300; color: #0c1e2e; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }\n" +
"  .header-sub { font-size: 8pt; letter-spacing: 0.2em; text-transform: uppercase; color: #b8963e; margin-bottom: 16px; }\n" +
"  .doc-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18pt; font-weight: 600; color: #0c1e2e; margin-bottom: 6px; }\n" +
"  .doc-meta { font-size: 8.5pt; color: #6b8599; }\n" +
"  .owner-badge { display: inline-block; background: #b8963e; color: white; font-size: 7.5pt; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; padding: 4px 14px; border-radius: 2px; margin-top: 10px; }\n" +
"  .section { margin-bottom: 28px; }\n" +
"  .section-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 13pt; font-weight: 600; color: #0c1e2e; border-bottom: 1.5px solid #b8963e; padding-bottom: 5px; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.06em; }\n" +
"  .section-number { color: #b8963e; margin-right: 8px; }\n" +
"  .clause { margin-bottom: 10px; }\n" +
"  .clause-num { font-weight: 600; color: #0c1e2e; margin-right: 6px; }\n" +
"  p { margin-bottom: 10px; font-size: 10pt; }\n" +
"  .services-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 9.5pt; }\n" +
"  .services-table th { background: #0c1e2e; color: white; padding: 7px 12px; text-align: left; font-size: 8pt; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }\n" +
"  .services-table td { padding: 7px 12px; border-bottom: 1px solid #eef0f3; }\n" +
"  .services-table tr:nth-child(even) td { background: #f8f9fb; }\n" +
"  .services-table .num { color: #b8963e; font-weight: 600; width: 30px; }\n" +
"  .services-table .freq { color: #6b8599; font-size: 8.5pt; }\n" +
"  .highlight-box { background: #f8f5ee; border: 1px solid #e0c97a; border-left: 4px solid #b8963e; border-radius: 4px; padding: 14px 18px; margin: 14px 0; font-size: 9.5pt; }\n" +
"  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #dde3ea; display: flex; justify-content: space-between; align-items: center; }\n" +
"  .footer-left { font-size: 7.5pt; color: #9aafbf; }\n" +
"  .footer-right { font-size: 7.5pt; color: #b8963e; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }\n" +
"  .gold-bar { height: 4px; background: linear-gradient(90deg, #b8963e, #d4ac52, #b8963e); }\n" +
"  .tagline { text-align: center; font-family: 'Cormorant Garamond', Georgia, serif; font-size: 13pt; font-style: italic; color: #0c1e2e; margin: 28px 0; padding: 16px; border-top: 1px solid #eef0f3; border-bottom: 1px solid #eef0f3; }\n" +
"  @media print { body { font-size: 10pt; } .page { padding: 40px 50px; } }\n" +
"</style>\n" +
"</head>\n" +
"<body>\n" +
"<div class=\"gold-bar\"></div>\n" +
"<div class=\"page\">\n" +
"  <div class=\"header\">\n" +
"    <div class=\"header-logo-text\">Whitestone Partners</div>\n" +
"    <div class=\"header-sub\">Certified Marine Dealer Program</div>\n" +
"    <div class=\"doc-title\">Annual Boat Service Contract</div>\n" +
"    <div class=\"doc-meta\">Boat Owner Copy — Keep for Your Records</div>\n" +
"    <div><span class=\"owner-badge\">Boat Owner Copy</span></div>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">1.</span>What's Covered</div>\n" +
"    <p>Your Whitestone Partners annual service contract covers the following ten (10) maintenance services performed by your assigned certified dealer:</p>\n" +
"    <table class=\"services-table\">\n" +
"      <thead><tr><th>#</th><th>Service</th><th>Frequency</th></tr></thead>\n" +
"      <tbody>\n" +
"        <tr><td class=\"num\">01</td><td>Summer Prep</td><td class=\"freq\">Yearly</td></tr>\n" +
"        <tr><td class=\"num\">02</td><td>Impeller Service</td><td class=\"freq\">Start of season / every 50 hrs</td></tr>\n" +
"        <tr><td class=\"num\">03</td><td>Engine Oil Service</td><td class=\"freq\">Yearly / every 50 hrs</td></tr>\n" +
"        <tr><td class=\"num\">04</td><td>Fuel Filter Service</td><td class=\"freq\">Every 150 hrs</td></tr>\n" +
"        <tr><td class=\"num\">05</td><td>Transmission Oil Service</td><td class=\"freq\">Yearly / every 100 hrs</td></tr>\n" +
"        <tr><td class=\"num\">06</td><td>Outdrive Service</td><td class=\"freq\">Yearly / every 100 hrs</td></tr>\n" +
"        <tr><td class=\"num\">07</td><td>Shaft Alignment</td><td class=\"freq\">Yearly / every 150 hrs</td></tr>\n" +
"        <tr><td class=\"num\">08</td><td>Winterization</td><td class=\"freq\">Yearly</td></tr>\n" +
"        <tr><td class=\"num\">09</td><td>V-Drive Service</td><td class=\"freq\">Yearly / every 200 hrs (V-drive vessels only)</td></tr>\n" +
"        <tr><td class=\"num\">10</td><td>Ballast Cartridge Service</td><td class=\"freq\">Every 100 hrs (ballast-equipped vessels only)</td></tr>\n" +
"      </tbody>\n" +
"    </table>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">2.</span>What's Not Covered</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.1</span>Parts replacement beyond normal service items included in the covered services above.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.2</span>Damage resulting from misuse, neglect, accidents, collision, or weather events.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.3</span>Pre-existing conditions at the time of enrollment.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.4</span>Services not listed in Section 1 of this contract.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.5</span>Commercial vessel use of any kind.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">2.6</span>Services performed by non-certified Whitestone Partners dealers.</div>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">3.</span>Your Contract Terms</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">3.1</span><strong>Vessel Tie.</strong> This contract is tied to your boat's Hull Identification Number (HIN) and is not transferable to a new owner upon sale of the vessel.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">3.2</span><strong>No Cash Value.</strong> Unused services do not roll over to the next contract period and carry no cash value.</div>\n" +
"    <div class=\"clause\"><span class=\"clause-num\">3.3</span><strong>Assigned Dealer.</strong> All covered services must be performed by your assigned Whitestone Partners certified dealer.</div>\n" +
"    <div class=\"highlight-box\"><strong>Service Documentation:</strong> Every completed service is logged in the Whitestone Partners system, creating a complete documented service history for your vessel — a valuable asset when it comes time to sell your boat.</div>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">4.</span>Scheduling Service</div>\n" +
"    <p>Contact your assigned dealer to schedule each covered service. Your dealer will submit service records through the Whitestone Partners portal after each visit, maintaining your complete service history automatically.</p>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">5.</span>Cancellation Policy</div>\n" +
"    <p>Cancellation requests submitted within 30 days of contract activation will receive a full refund minus the value of any services already performed. After 30 days from activation, no refund is available. All cancellation requests must be submitted in writing to support@whitestone-partners.com.</p>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">6.</span>Limitation of Liability</div>\n" +
"    <p>Whitestone Partners' total liability under this contract shall not exceed the original contract purchase price. Whitestone is not liable for incidental or consequential damages, including but not limited to loss of use of your vessel.</p>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">7.</span>Dispute Resolution</div>\n" +
"    <p>Disputes shall first be submitted to good-faith negotiation between the parties. If unresolved within 30 days, binding arbitration in Washington County, Utah shall govern. The laws of the State of Utah apply to this contract.</p>\n" +
"  </div>\n" +
"  <div class=\"section\">\n" +
"    <div class=\"section-title\"><span class=\"section-number\">8.</span>Contact</div>\n" +
"    <p><strong>Whitestone Partners LLC</strong><br>St. George, Utah<br>support@whitestone-partners.com<br>whitestone-partners.com</p>\n" +
"  </div>\n" +
"  <div class=\"tagline\">\"The contract that brings your customers back. Every season.\"</div>\n" +
"  <div class=\"footer\">\n" +
"    <div class=\"footer-left\">Whitestone Partners LLC &nbsp;|&nbsp; St. George, Utah &nbsp;|&nbsp; support@whitestone-partners.com</div>\n" +
"    <div class=\"footer-right\">Boat Owner Copy</div>\n" +
"  </div>\n" +
"</div>\n" +
"<div class=\"gold-bar\"></div>\n" +
"<script>\n" +
"  window.onload = function() { window.print(); }\n" +
"</script>\n" +
"</body>\n" +
"</html>";
  var printWindow = window.open("", "_blank", "width=900,height=700");
  printWindow.document.write(html);
  printWindow.document.close();
}

window.downloadCustomerContract = downloadCustomerContract;

function startOfDay(d) {
  var x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysUntilNextAnniversary(enrollDate) {
  var now = startOfDay(new Date());
  var m = enrollDate.getMonth();
  var day = enrollDate.getDate();
  var y = now.getFullYear();
  var next = startOfDay(new Date(y, m, day));
  if (next < now) next = startOfDay(new Date(y + 1, m, day));
  return Math.round((next - now) / 86400000);
}

window.financialsSetPeriod = function(period) {
  currentFinPeriod = period;
  ["week", "month", "year", "all"].forEach(function(p) {
    var btn = document.getElementById("fin-btn-" + p);
    if (btn) btn.classList.toggle("active", p === period);
  });
  window.financialsLoad();
};

window.financialsShowSection = function(section) {
  currentFinSection = section;
  ["overview", "revenue", "reimbursements", "contracts", "projections"].forEach(function(s) {
    var el = document.getElementById("fin-section-" + s);
    var nav = document.getElementById("fin-nav-" + s);
    if (el) el.style.display = s === section ? "block" : "none";
    if (nav) nav.classList.toggle("active", s === section);
  });
};

function financialsGetDateFilter() {
  var now = new Date();
  var start = null;
  if (currentFinPeriod === "week") {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (currentFinPeriod === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (currentFinPeriod === "year") {
    start = new Date(now.getFullYear(), 0, 1);
  }
  return start ? start.toISOString() : null;
}

window.financialsLoad = async function() {
  var dateFilter = financialsGetDateFilter();

  var contractsUrl = SUPABASE_URL + "/rest/v1/contracts?select=*";
  if (dateFilter) contractsUrl += "&created_at=gte." + dateFilter;
  var contractsRes = await fetch(contractsUrl, { headers: authHeaders() });
  var contracts = await contractsRes.json() || [];

  var reimbUrl = SUPABASE_URL + "/rest/v1/reimbursements?select=*";
  if (dateFilter) reimbUrl += "&created_at=gte." + dateFilter;
  var reimbRes = await fetch(reimbUrl, { headers: authHeaders() });
  var reimbs = await reimbRes.json() || [];

  var pricingRes = await fetch(
    SUPABASE_URL + "/rest/v1/dealer_pricing?select=*",
    { headers: authHeaders() }
  );
  var pricing = await pricingRes.json() || [];

  var wholesaleTotal = contracts.reduce(function(total, c) {
    var dealerPricing = pricing.find(function(p) {
      return p.dealership_name === c.dealership_name;
    });
    if (!dealerPricing) return total;
    var priceMap = {
      "1yr": dealerPricing.contract_retail_1yr || 3325,
      "2yr": dealerPricing.contract_retail_2yr || 6650,
      "3yr": dealerPricing.contract_retail_3yr || 9975
    };
    return total + (priceMap[c.contract_type] || 0);
  }, 0);

  var paidReimbs = reimbs.filter(function(r) { return r.status === "paid"; });
  var pendingReimbs = reimbs.filter(function(r) {
    return r.status === "pending" || r.status === "approved";
  });
  var reimbTotal = paidReimbs.reduce(function(a, r) { return a + (r.amount || 150); }, 0);
  var outstandingTotal = pendingReimbs.reduce(function(a, r) { return a + (r.amount || 150); }, 0);
  var netProfit = wholesaleTotal - reimbTotal;

  var wEl = document.getElementById("fin-wholesale");
  if (wEl) wEl.textContent = "$" + wholesaleTotal.toLocaleString();
  var wsSub = document.getElementById("fin-wholesale-sub");
  if (wsSub) wsSub.textContent = contracts.length + " contract" + (contracts.length !== 1 ? "s" : "");
  var rEl = document.getElementById("fin-reimbursed");
  if (rEl) rEl.textContent = "$" + reimbTotal.toLocaleString();
  var rsSub = document.getElementById("fin-reimbursed-sub");
  if (rsSub) rsSub.textContent = paidReimbs.length + " ticket" + (paidReimbs.length !== 1 ? "s" : "") + " paid";
  var oEl = document.getElementById("fin-outstanding");
  if (oEl) oEl.textContent = "$" + outstandingTotal.toLocaleString();

  var profitEl = document.getElementById("fin-profit");
  if (profitEl) {
    profitEl.style.color = netProfit >= 0 ? "var(--green-text)" : "var(--red)";
    profitEl.textContent = (netProfit < 0 ? "-$" : "$") + Math.abs(netProfit).toLocaleString();
  }

  var transEl = document.getElementById("fin-recent-transactions");
  var allTrans = [];
  contracts.forEach(function(c) {
    allTrans.push({
      type: "contract",
      date: c.created_at,
      label: "Contract enrolled — " + c.dealership_name,
      sub: c.customer_first_name + " " + c.customer_last_name + " · " + (c.contract_type || "1yr"),
      amount: "+$" + (function() {
        var dp = pricing.find(function(p) { return p.dealership_name === c.dealership_name; });
        var pm = {
          "1yr": dp ? dp.contract_retail_1yr : 3325,
          "2yr": dp ? dp.contract_retail_2yr : 6650,
          "3yr": dp ? dp.contract_retail_3yr : 9975
        };
        return (pm[c.contract_type] || 0).toLocaleString();
      })(),
      color: "var(--green-text)"
    });
  });
  paidReimbs.forEach(function(r) {
    allTrans.push({
      type: "reimbursement",
      date: r.paid_date || r.created_at,
      label: "Reimbursement paid — " + (r.dealership_name || ""),
      sub: "Ticket approved",
      amount: "-$" + (r.amount || 150).toLocaleString(),
      color: "var(--red)"
    });
  });

  allTrans.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  allTrans = allTrans.slice(0, 20);

  if (transEl) {
    if (allTrans.length === 0) {
      transEl.innerHTML = "<div style=\"text-align:center;padding:2rem;color:var(--light);font-size:13px;\">No transactions yet.</div>";
    } else {
      transEl.innerHTML = allTrans.map(function(t) {
        var date = new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        return "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:0.85rem 0;border-bottom:1px solid var(--border);\">" +
          "<div>" +
            "<div style=\"font-size:13.5px;font-weight:500;color:var(--navy);\">" + t.label + "</div>" +
            "<div style=\"font-size:12px;color:var(--light);\">" + t.sub + " · " + date + "</div>" +
          "</div>" +
          "<div style=\"font-size:15px;font-weight:600;color:" + t.color + ";font-family:'Cormorant Garamond',serif;\">" + t.amount + "</div>" +
        "</div>";
      }).join("");
    }
  }

  var revenueByDealer = {};
  contracts.forEach(function(c) {
    var dp = pricing.find(function(p) { return p.dealership_name === c.dealership_name; });
    var pm = {
      "1yr": dp ? dp.contract_retail_1yr : 3325,
      "2yr": dp ? dp.contract_retail_2yr : 6650,
      "3yr": dp ? dp.contract_retail_3yr : 9975
    };
    var amt = pm[c.contract_type] || 0;
    revenueByDealer[c.dealership_name] = (revenueByDealer[c.dealership_name] || 0) + amt;
  });

  var revEl = document.getElementById("fin-revenue-by-dealer");
  var dealerRevList = Object.keys(revenueByDealer).sort(function(a, b) {
    return revenueByDealer[b] - revenueByDealer[a];
  });
  if (revEl) {
    if (dealerRevList.length === 0) {
      revEl.innerHTML = "<div style=\"text-align:center;padding:2rem;color:var(--light);font-size:13px;\">No revenue data yet.</div>";
    } else {
      var maxRev = Math.max.apply(null, dealerRevList.map(function(d) { return revenueByDealer[d]; }));
      revEl.innerHTML = dealerRevList.map(function(dealer) {
        var amt = revenueByDealer[dealer];
        var pct = Math.round(amt / maxRev * 100);
        return "<div style=\"margin-bottom:1rem;\">" +
          "<div style=\"display:flex;justify-content:space-between;margin-bottom:4px;\">" +
            "<span style=\"font-size:13px;color:var(--navy);font-weight:500;\">" + dealer + "</span>" +
            "<span style=\"font-size:13px;font-weight:600;color:var(--gold);\">$" + amt.toLocaleString() + "</span>" +
          "</div>" +
          "<div style=\"height:6px;background:var(--silver-bg);border-radius:3px;\"><div style=\"height:100%;width:" + pct + "%;background:var(--gold);border-radius:3px;\"></div></div>" +
        "</div>";
      }).join("");
    }
  }

  var revenueByType = { "1yr": 0, "2yr": 0, "3yr": 0 };
  contracts.forEach(function(c) {
    var dp = pricing.find(function(p) { return p.dealership_name === c.dealership_name; });
    var pm = {
      "1yr": dp ? dp.contract_retail_1yr : 3325,
      "2yr": dp ? dp.contract_retail_2yr : 6650,
      "3yr": dp ? dp.contract_retail_3yr : 9975
    };
    revenueByType[c.contract_type] = (revenueByType[c.contract_type] || 0) + (pm[c.contract_type] || 0);
  });

  var typeEl = document.getElementById("fin-revenue-by-type");
  if (typeEl) {
    typeEl.innerHTML = ["1yr", "2yr", "3yr"].map(function(type) {
      var count = contracts.filter(function(c) { return c.contract_type === type; }).length;
      return "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:0.85rem 0;border-bottom:1px solid var(--border);\">" +
        "<div><div style=\"font-size:13.5px;font-weight:500;color:var(--navy);\">" + type.toUpperCase() + " Contract</div>" +
        "<div style=\"font-size:12px;color:var(--light);\">" + count + " enrolled</div></div>" +
        "<div style=\"font-size:15px;font-weight:600;color:var(--gold);font-family:'Cormorant Garamond',serif;\">$" + revenueByType[type].toLocaleString() + "</div>" +
      "</div>";
    }).join("");
  }

  var reimbEl = document.getElementById("fin-reimbursements-breakdown");
  if (reimbEl) {
    if (reimbs.length === 0) {
      reimbEl.innerHTML = "<div style=\"text-align:center;padding:2rem;color:var(--light);font-size:13px;\">No reimbursement data yet.</div>";
    } else {
      var byDealer = {};
      reimbs.forEach(function(r) {
        if (!byDealer[r.dealership_name]) byDealer[r.dealership_name] = { paid: 0, pending: 0 };
        if (r.status === "paid") byDealer[r.dealership_name].paid += (r.amount || 150);
        else byDealer[r.dealership_name].pending += (r.amount || 150);
      });
      reimbEl.innerHTML = "<table style=\"width:100%;border-collapse:collapse;font-size:13px;\">" +
        "<thead><tr>" +
          "<th style=\"text-align:left;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Dealer</th>" +
          "<th style=\"text-align:right;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Paid</th>" +
          "<th style=\"text-align:right;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Outstanding</th>" +
        "</tr></thead><tbody>" +
        Object.keys(byDealer).map(function(dealer) {
          return "<tr>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);font-weight:500;color:var(--navy);\">" + dealer + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--green-text);font-weight:600;\">$" + byDealer[dealer].paid.toLocaleString() + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--amber);font-weight:600;\">$" + byDealer[dealer].pending.toLocaleString() + "</td>" +
          "</tr>";
        }).join("") +
        "</tbody></table>";
    }
  }

  var contractsEl = document.getElementById("fin-contracts-breakdown");
  var active = contracts.filter(function(c) { return c.status === "active"; });
  var expiring = contracts.filter(function(c) {
    if (!c.end_date) return false;
    var days = Math.ceil((new Date(c.end_date) - new Date()) / 86400000);
    return days >= 0 && days <= 30;
  });
  var expired = contracts.filter(function(c) {
    return c.status === "expired" || (c.end_date && new Date(c.end_date) < new Date());
  });

  if (contractsEl) {
    contractsEl.innerHTML =
      "<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem;\">" +
        "<div style=\"text-align:center;background:var(--silver-bg);border-radius:8px;padding:1rem;\">" +
          "<div style=\"font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:300;color:var(--green);\">" + active.length + "</div>" +
          "<div style=\"font-size:11px;color:var(--light);\">Active</div>" +
        "</div>" +
        "<div style=\"text-align:center;background:var(--silver-bg);border-radius:8px;padding:1rem;\">" +
          "<div style=\"font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:300;color:var(--amber);\">" + expiring.length + "</div>" +
          "<div style=\"font-size:11px;color:var(--light);\">Expiring (30 days)</div>" +
        "</div>" +
        "<div style=\"text-align:center;background:var(--silver-bg);border-radius:8px;padding:1rem;\">" +
          "<div style=\"font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:300;color:var(--red);\">" + expired.length + "</div>" +
          "<div style=\"font-size:11px;color:var(--light);\">Expired</div>" +
        "</div>" +
      "</div>" +
      (contracts.length === 0
        ? "<div style=\"text-align:center;padding:2rem;color:var(--light);font-size:13px;\">No contracts yet.</div>"
        : "<table style=\"width:100%;border-collapse:collapse;font-size:13px;\">" +
        "<thead><tr>" +
          "<th style=\"text-align:left;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Customer</th>" +
          "<th style=\"text-align:left;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Dealer</th>" +
          "<th style=\"text-align:right;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Type</th>" +
          "<th style=\"text-align:right;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Expires</th>" +
          "<th style=\"text-align:right;padding:8px;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--light);border-bottom:2px solid var(--border);\">Status</th>" +
        "</tr></thead><tbody>" +
        contracts.slice(0, 20).map(function(c) {
          var days = c.end_date ? Math.ceil((new Date(c.end_date) - new Date()) / 86400000) : null;
          var statusColor = days === null ? "var(--light)" : days < 0 ? "var(--red)" : days <= 30 ? "var(--amber)" : "var(--green)";
          var statusLabel = days === null ? "—" : days < 0 ? "Expired" : days <= 30 ? "Expiring" : "Active";
          return "<tr>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);font-weight:500;color:var(--navy);\">" + c.customer_first_name + " " + c.customer_last_name + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);color:var(--mid);font-size:12px;\">" + (c.dealership_name || "—") + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--gold);font-weight:600;\">" + (c.contract_type || "1yr").toUpperCase() + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:12px;color:var(--mid);\">" + (c.end_date ? new Date(c.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—") + "</td>" +
            "<td style=\"padding:9px 8px;border-bottom:1px solid var(--border);text-align:right;font-weight:600;color:" + statusColor + ";\">" + statusLabel + "</td>" +
          "</tr>";
        }).join("") +
        "</tbody></table>"
      );
  }

  var projEl = document.getElementById("fin-projections-content");
  if (projEl) {
    if (active.length === 0) {
      projEl.innerHTML = "<div style=\"text-align:center;padding:2rem;color:var(--light);font-size:13px;\">No active contracts to project from yet.</div>";
    } else {
      var avgWholesale = wholesaleTotal / Math.max(contracts.length, 1);
      var annualCost = active.length * 3325 * 0.8;
      var annualRevenue = active.length * avgWholesale;
      var projProfit = annualRevenue - annualCost;
      var renewalRevenue75 = active.length * 0.75 * avgWholesale;
      var renewalRevenue50 = active.length * 0.5 * avgWholesale;

      projEl.innerHTML =
        "<div style=\"display:flex;flex-direction:column;gap:1rem;\">" +
          "<div style=\"background:var(--silver-bg);border-radius:8px;padding:1.25rem;\">" +
            "<div style=\"font-size:12px;font-weight:600;color:var(--mid);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.75rem;\">Next 12 Months (current contracts)</div>" +
            "<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;text-align:center;\">" +
              "<div><div style=\"font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:300;color:var(--green);\">$" + Math.round(annualRevenue).toLocaleString() + "</div><div style=\"font-size:11px;color:var(--light);\">Expected revenue</div></div>" +
              "<div><div style=\"font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:300;color:var(--red);\">$" + Math.round(annualCost).toLocaleString() + "</div><div style=\"font-size:11px;color:var(--light);\">Expected costs</div></div>" +
              "<div><div style=\"font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:300;color:" + (projProfit >= 0 ? "var(--green)" : "var(--red)") + ";\">$" + Math.round(Math.abs(projProfit)).toLocaleString() + "</div><div style=\"font-size:11px;color:var(--light);\">Projected profit</div></div>" +
            "</div>" +
          "</div>" +
          "<div style=\"background:var(--silver-bg);border-radius:8px;padding:1.25rem;\">" +
            "<div style=\"font-size:12px;font-weight:600;color:var(--mid);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.75rem;\">Renewal Scenarios</div>" +
            "<div style=\"display:flex;flex-direction:column;gap:0.75rem;font-size:13.5px;\">" +
              "<div style=\"display:flex;justify-content:space-between;padding:0.75rem;background:white;border-radius:6px;\"><span style=\"color:var(--mid);\">75% renewal rate</span><span style=\"font-weight:600;color:var(--green);\">$" + Math.round(renewalRevenue75).toLocaleString() + "</span></div>" +
              "<div style=\"display:flex;justify-content:space-between;padding:0.75rem;background:white;border-radius:6px;\"><span style=\"color:var(--mid);\">50% renewal rate</span><span style=\"font-weight:600;color:var(--amber);\">$" + Math.round(renewalRevenue50).toLocaleString() + "</span></div>" +
            "</div>" +
          "</div>" +
        "</div>";
    }
  }
};

document.addEventListener("DOMContentLoaded", function() {

  var adminPanelLastNav = "dashboard";

  function resetLoginPanels() {
    document.getElementById("forgot-form-wrap").style.display = "none";
    document.getElementById("login-form-wrap").style.display = "block";
    document.getElementById("reset-ok").style.display = "none";
    document.getElementById("reset-err").style.display = "none";
  }

  function resetPortalState() {
    allTickets = [];
    adminNetworkTickets = [];
    adminDashboardMetrics = { count: 0, revenue: 0 };
    adminReimburseMetrics = { paidTotal: 0 };
    adminRenewalContracts = [];
    dealerRowsCache = [];
    adminContractsCache = [];
    dealerContractCount = 0;
    renewalContractsDealer = [];
    resetAdminTabVisibility();
    pricingTabInitialized = false;
    pricingSupabaseLoadPromise = null;
    pricingState = {
      dealerId: null,
      dealerName: null,
      originalRates: {},
      currentRates: {},
      confirmed: false,
      locked: false,
      pricingId: null
    };
    pricingDestroyProfitChart();
  }

  function onLoginSuccess() {
    window.currentDealer = currentDealer;
    if (currentDealer) window.authToken = currentDealer.token || window.authToken || null;
    document.getElementById("dealer-display").textContent = currentDealer ? currentDealer.name : "";
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("portal-screen").style.display = "block";
    document.getElementById("login-err").style.display = "none";
    resetLoginPanels();

    if (currentDealer && currentDealer.isAdmin) {
      document.getElementById("portal-screen").className = "mode-admin";
      document.getElementById("dealer-layout").style.display = "none";
      document.getElementById("admin-layout").style.display = "flex";
      document.querySelectorAll("#admin-sidebar .admin-nav-item").forEach(function(b) {
        b.classList.remove("active");
      });
      var dashNav = document.querySelector('#admin-sidebar .admin-nav-item[data-admin-panel="dashboard"]');
      if (dashNav) dashNav.classList.add("active");
      adminShowPanel("dashboard");
      adminLoadBadgeCounts();
    } else {
      document.getElementById("portal-screen").className = "mode-dealer";
      document.getElementById("dealer-layout").style.display = "flex";
      document.getElementById("admin-layout").style.display = "none";
      document.querySelectorAll(".sidebar-nav-item").forEach(function(b) {
        b.classList.remove("active");
      });
      var sbd = document.querySelector('.sidebar-nav-item[data-panel="dashboard"]');
      if (sbd) sbd.classList.add("active");
      window.switchTab("dashboard");
    }
  }

  supabase.auth.onAuthStateChange(async function(event, session) {
    if (session && session.access_token) {
      window.authToken = session.access_token;
      if (currentDealer) currentDealer.token = session.access_token;
    }

    if (event === "SIGNED_OUT") {
      window.authToken = null;
      if (currentDealer) currentDealer.token = null;
      return;
    }

    if (event === "PASSWORD_RECOVERY") {
      var newPassword = prompt("Enter your new password (minimum 8 characters):");
      if (newPassword && newPassword.length >= 8) {
        var updateResult = await supabase.auth.updateUser({ password: newPassword });
        if (updateResult.error) {
          console.error("Password update failed", updateResult.error);
          alert("Error updating password: " + updateResult.error.message);
        } else {
          alert("Password updated successfully! Please sign in with your new password.");
          await supabase.auth.signOut();
          location.reload();
        }
      }
    }
  });

  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("login-password").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });
  document.getElementById("login-email").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });

  document.getElementById("forgot-password-btn").addEventListener("click", function() {
    document.getElementById("login-form-wrap").style.display = "none";
    document.getElementById("forgot-form-wrap").style.display = "block";
  });

  document.getElementById("back-to-login-btn").addEventListener("click", function() {
    resetLoginPanels();
  });

  document.getElementById("reset-btn").addEventListener("click", async function() {
    var email = document.getElementById("reset-email").value.trim();
    var btn = document.getElementById("reset-btn");

    if (!email) {
      document.getElementById("reset-err").textContent = "Please enter your email address.";
      document.getElementById("reset-err").style.display = "block";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Sending...";
    document.getElementById("reset-ok").style.display = "none";
    document.getElementById("reset-err").style.display = "none";

    try {
      var resetResult = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: "https://whitestone-dealer-portal.vercel.app"
      });

      if (resetResult.error) {
        document.getElementById("reset-err").textContent = resetResult.error.message;
        document.getElementById("reset-err").style.display = "block";
        console.error("Password reset email failed", resetResult.error);
      } else {
        document.getElementById("reset-ok").style.display = "block";
      }
    } catch (err) {
      console.error("Unexpected password reset error", err);
      document.getElementById("reset-err").textContent = "Unable to send reset email right now. Please try again.";
      document.getElementById("reset-err").style.display = "block";
    }

    btn.disabled = false;
    btn.textContent = "Send Reset Link";
  });

  async function adminRefreshNetworkCaches() {
    if (!currentDealer || !currentDealer.isAdmin) return false;
    var loading = document.getElementById("admin-dashboard-loading");
    var content = document.getElementById("admin-dashboard-content");
    if (loading) loading.style.display = "block";
    if (content) content.style.display = "none";
    try {
      var mst = document.getElementById("admin-master-search-loading");
      if (mst) mst.style.display = "block";
      var results = await Promise.all([
        adminFetchAllTickets(),
        adminFetchContractsSummary(),
        adminFetchReimbursementsPaidTotal(),
        adminFetchRenewalsContracts(),
        fetchDealersSupabase(),
        adminFetchAllContracts()
      ]);
      if (mst) mst.style.display = "none";
      adminNetworkTickets = results[0] || [];
      adminDashboardMetrics = results[1];
      adminReimburseMetrics = results[2];
      adminRenewalContracts = results[3] || [];
      dealerRowsCache = results[4] || [];
      adminContractsCache = results[5] || [];
      var commEl = document.getElementById("pricing-slider-commission");
      if (commEl) {
        var v = parseFloat(commEl.value);
        if (!isNaN(v)) ADMIN_COMMISSION_RATE = v / 100;
      }
      if (loading) loading.style.display = "none";
      if (content) content.style.display = "block";
      return true;
    } catch (e) {
      var mst2 = document.getElementById("admin-master-search-loading");
      if (mst2) mst2.style.display = "none";
      adminNetworkTickets = [];
      dealerRowsCache = [];
      adminContractsCache = [];
      adminDashboardMetrics = { count: 0, revenue: 0 };
      adminReimburseMetrics = { paidTotal: 0 };
      adminRenewalContracts = [];
      if (loading) loading.style.display = "none";
      if (content) content.style.display = "block";
      return false;
    }
  }

  function adminRenderDashboardOnly() {
    adminRenderStats();
    adminRenderChart();
    adminRenderLeaderboard();
    adminRenderFlags();
    adminRenderRenewalsNetwork();
    adminRenderFinancialHealth();
    adminLoadActivityFeed();
    adminLoadRecentPricingChanges();
  }

  function adminRenderDealersOnly() {
    renderDealerTable();
    applicationsLoadPanel();
  }

  function adminRenderCustomersOnly() {
    renderAdminMasterTable();
    loadAdminHinConflicts();
  }

  async function adminLoadDashboardPanel() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    await adminRefreshNetworkCaches();
    adminRenderDashboardOnly();
  }

  async function adminLoadDealersPanel() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    await adminRefreshNetworkCaches();
    adminRenderDealersOnly();
  }

  async function adminLoadCustomersPanel() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    await adminRefreshNetworkCaches();
    adminRenderCustomersOnly();
  }

  async function adminLoadNetworkDashboard() {
    await adminRefreshNetworkCaches();
    adminRenderDashboardOnly();
    adminRenderCustomersOnly();
    adminRenderDealersOnly();
  }

  function adminShowSettingsModal() {
    var modal = document.getElementById("settings-modal");
    if (!modal) return;
    modal.style.display = "flex";
  }

  function adminShowPanel(panel) {
    if (!currentDealer || !currentDealer.isAdmin) return;
    if (panel === "settings") {
      adminShowSettingsModal();
      document.querySelectorAll("#admin-sidebar .admin-nav-item").forEach(function(b) {
        b.classList.remove("active");
      });
      var prevBtn = document.querySelector('#admin-sidebar .admin-nav-item[data-admin-panel="' + adminPanelLastNav + '"]');
      if (prevBtn) prevBtn.classList.add("active");
      return;
    }
    adminPanelLastNav = panel;
    document.querySelectorAll("#admin-content .admin-panel").forEach(function(p) {
      if (p.id === "admin-panel-settings") return;
      p.style.display = "none";
    });
    var el = document.getElementById("admin-panel-" + panel);
    if (el) el.style.display = "block";
    switch (panel) {
      case "dashboard":
        adminLoadDashboardPanel();
        break;
      case "dealers":
        adminLoadDealersPanel();
        break;
      case "customers":
        adminLoadCustomersPanel();
        break;
      case "claims":
        claimsLoadTab();
        break;
      case "financials":
        window.financialsShowSection("overview");
        window.financialsLoad();
        break;
      case "messages":
        adminLoadMessages();
        break;
      case "pricing":
        pricingInitOnTab();
        break;
      default:
        break;
    }
  }

  async function doLogin() {
    var email = document.getElementById("login-email").value.trim();
    var password = document.getElementById("login-password").value;
    var errEl = document.getElementById("login-err");
    var btn = document.getElementById("login-btn");

    if (!email || !password) {
      errEl.textContent = "Please enter your email and password.";
      errEl.style.display = "block";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Signing in...";
    errEl.style.display = "none";

    try {
      var signInResult = await supabase.auth.signInWithPassword({
        email: email,
        password: password
      });

      if (signInResult.error) {
        errEl.textContent = signInResult.error.message === "Invalid login credentials"
          ? "Incorrect email or password. Please try again."
          : signInResult.error.message;
        errEl.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Sign In";
        return;
      }

      var session = signInResult.data.session;
      var user = signInResult.data.user;
      window.authToken = session.access_token;

      var dealer = await fetchDealerByAuthId(user.id, session.access_token);
      if (!dealer) {
        errEl.textContent = "Account not found. Please contact support@whitestone-partners.com.";
        errEl.style.display = "block";
        await supabase.auth.signOut();
        btn.disabled = false;
        btn.textContent = "Sign In";
        return;
      }

      currentDealer = buildDealerSession(dealer, session);
      window.onLoginSuccess();
      btn.disabled = false;
      btn.textContent = "Sign In";
    } catch (e) {
      console.error("Login failed", e);
      errEl.textContent = "Something went wrong. Please try again.";
      errEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  }

  function switchTab(name) {
    if (currentDealer && currentDealer.isAdmin) return;
    document.querySelectorAll("#dealer-main-content .tab-panel").forEach(function(p) {
      p.classList.remove("active");
    });
    document.querySelectorAll(".sidebar-nav-item").forEach(function(b) {
      b.classList.remove("active");
    });
    var sb = document.querySelector('.sidebar-nav-item[data-panel="' + name + '"]');
    if (sb) sb.classList.add("active");
    var panel = document.getElementById("panel-" + name);
    if (panel) panel.classList.add("active");
    if (name === "dashboard") loadDashboard();
    if (name === "history") loadTickets();
    if (name === "customers") loadCustomersTab();
  }

  window.switchTab = switchTab;
  window.onLoginSuccess = onLoginSuccess;

  supabase.auth.getSession().then(async function(result) {
    var session = result && result.data ? result.data.session : null;
    if (!session) return;
    try {
      window.authToken = session.access_token;
      var dealer = await fetchDealerByAuthId(session.user.id, session.access_token);
      if (!dealer) {
        console.error("No active dealer record found for session", session.user.id);
        await supabase.auth.signOut();
        return;
      }
      currentDealer = buildDealerSession(dealer, session);
      window.onLoginSuccess();
    } catch (err) {
      console.error("Failed to restore session", err);
    }
  });

  function animateEarningsTo(targetDollars, el) {
    if (!el) return;
    if (earningsAnimRaf) cancelAnimationFrame(earningsAnimRaf);
    var start = performance.now();
    var duration = 1500;
    var from = 0;
    function tick(now) {
      var p = Math.min(1, (now - start) / duration);
      var eased = 1 - (1 - p) * (1 - p);
      var val = Math.round(from + (targetDollars - from) * eased);
      el.textContent = "$" + val.toLocaleString();
      if (p < 1) earningsAnimRaf = requestAnimationFrame(tick);
      else earningsAnimRaf = null;
    }
    earningsAnimRaf = requestAnimationFrame(tick);
  }

  function renderSparkline(ticketsInPeriod) {
    var el = document.getElementById("earnings-sparkline");
    if (!el) return;
    var buckets = {};
    var labels = [];
    var y = new Date().getFullYear();
    var mo;
    if (dashboardPeriod === "year") {
      for (mo = 0; mo < 12; mo++) {
        var keyY = y + "-" + pad2(mo + 1);
        buckets[keyY] = 0;
        labels.push(keyY);
      }
    } else {
      var now = new Date();
      for (var i = 11; i >= 0; i--) {
        var dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var keyA = dt.getFullYear() + "-" + pad2(dt.getMonth() + 1);
        buckets[keyA] = 0;
        labels.push(keyA);
      }
    }
    ticketsInPeriod.filter(ticketBillable).forEach(function(t) {
      var d = parseTicketDate(t);
      if (!d) return;
      var keyB = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
      if (Object.prototype.hasOwnProperty.call(buckets, keyB)) buckets[keyB] += 150;
    });
    var maxAmt = 1;
    labels.forEach(function(k) {
      var v = buckets[k] || 0;
      if (v > maxAmt) maxAmt = v;
    });
    var html = "";
    labels.forEach(function(k) {
      var amt = buckets[k] || 0;
      var h = maxAmt > 0 ? Math.max(8, Math.round((amt / maxAmt) * 100)) : 8;
      html += "<div class='spark-bar-wrap' title='" + escHtml(k + ": $" + amt) + "'><div class='spark-bar' style='height:" + h + "%'></div></div>";
    });
    el.innerHTML = html;
  }

  function updateDashboardStats() {
    var filtered = allTickets.filter(function(t) { return ticketMatchesPeriod(t, dashboardPeriod); });
    var billableTickets = filtered.filter(function(t) {
      var s = (t.status || "pending").toLowerCase();
      return s === "approved" || s === "pending";
    });
    var ticketCount = filtered.length;
    var contractsAllTime = countUniqueCustomers(allTickets);
    var y = new Date().getFullYear();
    var stTix = document.getElementById("stat-tickets");
    var stHint = document.getElementById("stat-tickets-hint");
    var stCust = document.getElementById("stat-customers");
    var earnEl = document.getElementById("stat-earnings");
    var earnHint = document.getElementById("stat-earnings-hint");
    if (stTix) stTix.textContent = String(ticketCount);
    if (stHint) stHint.textContent = dashboardPeriod === "year" ? "Submitted in " + y : "All submitted tickets";
    if (stCust) stCust.textContent = String(dealerContractCount > 0 ? dealerContractCount : contractsAllTime);
    var earnings = billableTickets.length * 150;
    if (earnHint) {
      earnHint.textContent = "~$150 avg per ticket (approved + pending)";
    }
    animateEarningsTo(earnings, earnEl);
    renderSparkline(filtered);
  }

  function renderTierUI() {
    var contracts = dealerContractCount > 0 ? dealerContractCount : countUniqueCustomers(allTickets);
    var meta = getTierMeta(contracts);
    var titleEl = document.getElementById("tier-title");
    var subEl = document.getElementById("tier-subtitle");
    var iconWrap = document.getElementById("tier-icon-wrap");
    var iconEl = document.getElementById("tier-icon");
    var progWrap = document.getElementById("tier-progress-wrap");
    var progFill = document.getElementById("tier-progress-fill");
    var progLabel = document.getElementById("tier-progress-label");
    var platMsg = document.getElementById("tier-platinum-msg");
    if (!titleEl) return;
    titleEl.textContent = meta.title;
    if (subEl) subEl.textContent = contracts + " enrolled customer" + (contracts === 1 ? "" : "s") + " on file";
    if (iconWrap) iconWrap.style.borderColor = meta.color;
    if (iconEl) iconEl.style.color = meta.color;
    var st = getTierProgressState(contracts);
    if (st.platinum) {
      if (progWrap) progWrap.style.display = "none";
      if (platMsg) {
        platMsg.style.display = "block";
        platMsg.textContent = "You've reached the highest tier. Thank you for your outstanding partnership with Whitestone Partners.";
      }
    } else {
      if (progWrap) progWrap.style.display = "block";
      if (platMsg) platMsg.style.display = "none";
      if (progFill) progFill.style.width = Math.max(0, Math.min(100, st.pct)) + "%";
      if (progLabel) progLabel.textContent = st.need + " more contract" + (st.need === 1 ? "" : "s") + " to " + st.nextName;
    }
  }

  function renderRenewalsUI() {
    var el = document.getElementById("renewals-container");
    if (!el) return;
    if (currentDealer && currentDealer.isAdmin) return;
    if (!renewalContractsDealer.length) {
      el.innerHTML = "<div class='renewals-empty'>No renewals due in the next 90 days — you're all caught up.</div>";
      return;
    }
    var rows = renewalContractsDealer.map(function(c) {
      var name = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim() || "Customer";
      var boatParts = [c.boat_make, c.boat_model, c.boat_year].filter(function(x) { return String(x || "").trim(); });
      var boat = boatParts.length ? boatParts.join(" ") : "—";
      var now = new Date();
      now.setHours(0, 0, 0, 0);
      var d = new Date(c.end_date);
      d.setHours(0, 0, 0, 0);
      var days = Math.round((d - now) / 86400000);
      var badgeClass = days <= 30 ? "urgent" : days <= 60 ? "soon" : "upcoming";
      return { name: name, boat: boat, days: days, badgeClass: badgeClass };
    });
    rows.sort(function(a, b) { return a.days - b.days; });
    var html = "";
    rows.forEach(function(r) {
      html += "<div class='renewal-row'><div class='renewal-main'><div class='renewal-name'>" + escHtml(r.name) + "</div>";
      html += "<div class='renewal-boat'>" + escHtml(r.boat) + "</div></div><div class='renewal-meta'>";
      html += "<span class='renewal-badge " + r.badgeClass + "'>" + r.days + " days until renewal</span>";
      html += "<button type='button' class='btn-reenroll'>Re-enroll</button></div></div>";
    });
    el.innerHTML = html;
  }

  async function loadDashboard() {
    var renewalsEl = document.getElementById("renewals-container");
    if (!currentDealer || !renewalsEl) return;
    var stTixL = document.getElementById("stat-tickets");
    var stCustL = document.getElementById("stat-customers");
    var earnElL = document.getElementById("stat-earnings");
    if (stTixL) stTixL.textContent = "…";
    if (stCustL) stCustL.textContent = "…";
    if (earnElL) earnElL.textContent = "…";
    renewalsEl.innerHTML = "<div class='renewals-loading'>Loading renewal dates…</div>";
    try {
      var tUrl = currentDealer.isAdmin
        ? SUPABASE_URL + "/rest/v1/tickets?select=*&order=created_at.desc"
        : SUPABASE_URL + "/rest/v1/tickets?dealership_name=eq." + encodeURIComponent(currentDealer.name) + "&select=*&order=created_at.desc";
      var tRes = await fetch(tUrl, { headers: supabaseHeaders() });
      var tRows = await tRes.json();
      if (!tRes.ok) throw new Error();
      allTickets = Array.isArray(tRows) ? tRows.map(mapTicketFromRow) : [];
      dealerContractCount = 0;
      renewalContractsDealer = [];
      if (!currentDealer.isAdmin) {
        var cUrl = SUPABASE_URL + "/rest/v1/contracts?dealership_name=eq." + encodeURIComponent(currentDealer.name) + "&status=eq.active&select=id";
        var cRes = await fetch(cUrl, { headers: supabaseHeaders() });
        var cRows = await cRes.json();
        if (cRes.ok && Array.isArray(cRows)) dealerContractCount = cRows.length;
        var renUrl = SUPABASE_URL + "/rest/v1/contracts?dealership_name=eq." + encodeURIComponent(currentDealer.name) + "&status=eq.active&select=*";
        var renRes = await fetch(renUrl, { headers: supabaseHeaders() });
        var renRows = await renRes.json();
        if (renRes.ok && Array.isArray(renRows)) {
          var now = new Date();
          now.setHours(0, 0, 0, 0);
          renewalContractsDealer = renRows.filter(function(c) {
            if (!c.end_date) return false;
            var d = new Date(c.end_date);
            d.setHours(0, 0, 0, 0);
            var days = Math.round((d - now) / 86400000);
            return days >= 0 && days <= 90;
          });
        }
      }
      renderTierUI();
      updateDashboardStats();
      renderRenewalsUI();
      if (currentDealer && !currentDealer.isAdmin) updateSidebarInfo();
    } catch (e) {
      allTickets = [];
      dealerContractCount = 0;
      renewalContractsDealer = [];
      renderTierUI();
      updateDashboardStats();
      renewalsEl.innerHTML = "<div class='renewals-empty'>Could not load data. Please try again.</div>";
      if (currentDealer && !currentDealer.isAdmin) updateSidebarInfo();
    }
  }

  function updateSidebarInfo() {
    var nameEl = document.getElementById("sidebar-dealer-name");
    var tierEl = document.getElementById("sidebar-dealer-tier");
    if (nameEl && currentDealer) nameEl.textContent = currentDealer.name;
    if (tierEl && currentDealer) {
      var contracts = dealerContractCount > 0 ? dealerContractCount : countUniqueCustomers(allTickets || []);
      tierEl.textContent = getTierMeta(contracts).title;
    }
  }

  async function doLogout() {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error("Logout failed", err);
    }
    currentDealer = null;
    window.currentDealer = null;
    window.authToken = null;
    resetPortalState();
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("portal-screen").style.display = "none";
    document.getElementById("portal-screen").className = "";
    document.getElementById("dealer-layout").style.display = "none";
    document.getElementById("admin-layout").style.display = "none";
    document.getElementById("login-email").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-err").style.display = "none";
    var sm = document.getElementById("settings-modal");
    if (sm) sm.style.display = "none";
    resetLoginPanels();
  }

  document.getElementById("logout-btn").addEventListener("click", doLogout);
  document.getElementById("sidebar-logout").addEventListener("click", doLogout);
  document.getElementById("admin-logout-btn").addEventListener("click", doLogout);

  document.querySelectorAll(".sidebar-nav-item").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var panel = this.getAttribute("data-panel");
      document.querySelectorAll(".sidebar-nav-item").forEach(function(b) {
        b.classList.remove("active");
      });
      this.classList.add("active");
      window.switchTab(panel);
    });
  });

  var adminSidebarEl = document.getElementById("admin-sidebar");
  if (adminSidebarEl) {
    adminSidebarEl.addEventListener("click", function(e) {
      var btn = e.target.closest(".admin-nav-item");
      if (!btn || !adminSidebarEl.contains(btn)) return;
      var panel = btn.getAttribute("data-admin-panel");
      if (!panel) return;
      adminSidebarEl.querySelectorAll(".admin-nav-item").forEach(function(b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      adminShowPanel(panel);
    });
  }

  var settingsModalEl = document.getElementById("settings-modal");
  if (settingsModalEl) {
    document.getElementById("settings-modal-close").addEventListener("click", function() {
      settingsModalEl.style.display = "none";
    });
    settingsModalEl.addEventListener("click", function(e) {
      if (e.target === settingsModalEl) settingsModalEl.style.display = "none";
    });
  }

  document.querySelectorAll("#dashboard-period-toggle .period-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      document.querySelectorAll("#dashboard-period-toggle .period-btn").forEach(function(b) { b.classList.remove("active"); });
      btn.classList.add("active");
      dashboardPeriod = btn.getAttribute("data-period") || "year";
      updateDashboardStats();
    });
  });

  document.getElementById("qa-ticket").addEventListener("click", function() { window.switchTab("ticket"); });
  document.getElementById("qa-enroll").addEventListener("click", function() { window.switchTab("enroll"); });

  function prefillEnrollFromContract(c) {
    if (!c) return;
    document.getElementById("e-fname").value = c.customer_first_name || "";
    document.getElementById("e-lname").value = c.customer_last_name || "";
    document.getElementById("e-email").value = c.customer_email || "";
    document.getElementById("e-phone").value = c.customer_phone || "";
    document.getElementById("e-make").value = c.boat_make || "";
    document.getElementById("e-model").value = c.boat_model || "";
    document.getElementById("e-year").value = c.boat_year || "";
    document.getElementById("e-hin").value = normalizeHin(c.hin || "");
    var herr = document.getElementById("e-hin-error");
    if (herr) {
      herr.style.display = "none";
      herr.textContent = "";
    }
    document.getElementById("e-err").style.display = "none";
    document.getElementById("enroll-link-box").style.display = "none";
    window.switchTab("enroll");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderCustomerCards() {
    var box = document.getElementById("customers-container");
    var qs = document.getElementById("customer-search");
    if (!box) return;
    var q = (qs && qs.value ? qs.value : "").toLowerCase().trim();
    var list = dealerContractsCache.filter(function(c) {
      if (!q) return true;
      var blob = [c.customer_first_name, c.customer_last_name, c.boat_make, c.boat_model, c.hin, c.boat_year]
        .map(function(x) {
          return String(x || "").toLowerCase();
        })
        .join(" ");
      return blob.indexOf(q) !== -1;
    });
    if (list.length === 0) {
      if (!dealerContractsCache.length) {
        box.innerHTML =
          "<div class='renewals-empty'>No customers enrolled yet. Use the Enroll Customer tab to add your first customer.</div>";
      } else {
        box.innerHTML = "<div class='renewals-empty'>No customers match your search.</div>";
      }
      return;
    }
    var html = "";
    list.forEach(function(c) {
      var name = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim() || "Customer";
      var boat = [c.boat_make, c.boat_model, c.boat_year].filter(Boolean).join(" ") || "—";
      var st = contractCardStatus(c);
      var enrolled = formatContractDateShort(c.start_date);
      var expires = formatContractDateShort(c.end_date);
      var ctype = String(c.contract_type || "—");
      html += "<div class='customer-card' data-contract-id='" + escHtml(String(c.id)) + "'>";
      html += "<div class='customer-card-name'>" + escHtml(name) + " <span class='" + st.cls + "'>" + escHtml(st.label) + "</span></div>";
      html += "<div class='customer-card-meta'>";
      html += "<div class='customer-card-row'><strong>Boat</strong> · " + escHtml(boat) + "</div>";
      html += "<div class='customer-card-row'><strong>HIN</strong> · " + escHtml(normalizeHin(c.hin || "")) + "</div>";
      html += "<div class='customer-card-row'><strong>Contract</strong> · " + escHtml(ctype) + "</div>";
      html += "<div class='customer-card-row'><strong>Enrolled</strong> · " + escHtml(enrolled) + "</div>";
      html += "<div class='customer-card-row'><strong>Expires</strong> · " + escHtml(expires) + "</div>";
      html += "</div>";
      if (st.sort === 3) {
        html +=
          "<button type='button' class='btn-reenroll-sm' data-contract-id='" +
          escHtml(String(c.id)) +
          "'>Re-enroll</button>";
      }
      html += "</div>";
    });
    box.innerHTML = html;
  }

  function bindCustomerSearchOnce() {
    var qs = document.getElementById("customer-search");
    if (!qs || qs.dataset.bound === "1") return;
    qs.dataset.bound = "1";
    qs.addEventListener("input", function() {
      renderCustomerCards();
    });
  }

  async function loadCustomersTab() {
    var box = document.getElementById("customers-container");
    if (!box || !currentDealer) return;
    box.innerHTML = "<div class='customers-loading'>Loading customers…</div>";
    try {
      var url =
        SUPABASE_URL +
        "/rest/v1/contracts?dealership_name=eq." +
        encodeURIComponent(currentDealer.name) +
        "&select=*&order=created_at.desc";
      var res = await fetch(url, { headers: supabaseHeaders() });
      var rows = await res.json();
      if (!res.ok) throw new Error();
      dealerContractsCache = Array.isArray(rows) ? rows : [];
      dealerContractsCache.sort(function(a, b) {
        var sa = contractCardStatus(a).sort;
        var sb = contractCardStatus(b).sort;
        if (sa !== sb) return sa - sb;
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });
      renderCustomerCards();
      bindCustomerSearchOnce();
    } catch (e) {
      box.innerHTML = "<div class='renewals-empty'>Could not load customers. Please try again.</div>";
    }
  }

  document.getElementById("customers-container").addEventListener("click", function(e) {
    var btn = e.target.closest(".btn-reenroll-sm");
    if (!btn) return;
    var id = btn.getAttribute("data-contract-id");
    var c = dealerContractsCache.find(function(x) {
      return String(x.id) === String(id);
    });
    prefillEnrollFromContract(c);
  });

  document.getElementById("renewals-container").addEventListener("click", function(e) {
    if (e.target && e.target.classList.contains("btn-reenroll")) window.switchTab("enroll");
  });

  // SERVICE BUTTONS
  document.querySelectorAll(".tb").forEach(function(btn) {
    btn.addEventListener("click", function() {
      btn.classList.toggle("sel");
      if (document.querySelectorAll(".tb.sel").length === 0) btn.classList.add("sel");
    });
  });

  // FAQ
  document.querySelectorAll("[data-dfaq]").forEach(function(el) {
    el.addEventListener("click", function() {
      var id = el.getAttribute("data-dfaq");
      var ans = document.getElementById("dfaq" + id);
      var arr = document.getElementById("darr" + id);
      if (ans.classList.contains("open")) {
        ans.classList.remove("open"); arr.classList.remove("open");
      } else {
        document.querySelectorAll(".faq-a").forEach(function(a) { a.classList.remove("open"); });
        document.querySelectorAll(".faq-arrow").forEach(function(a) { a.classList.remove("open"); });
        ans.classList.add("open"); arr.classList.add("open");
      }
    });
  });

  // RATE SHEET DOWNLOAD
  document.getElementById("rate-dl-btn").addEventListener("click", function() {
    var link = document.createElement("a");
    link.href = "assets/documents/whitestone-partners-dealer-rate-sheet.pdf";
    link.download = "Whitestone_Partners_Dealer_Rate_Sheet.pdf";
    link.click();
  });
  var resourcesRateBtn = document.getElementById("resources-rate-dl-btn");
  if (resourcesRateBtn) {
    resourcesRateBtn.addEventListener("click", function() {
      var link = document.createElement("a");
      link.href = "assets/documents/whitestone-partners-dealer-rate-sheet.pdf";
      link.download = "Whitestone_Partners_Dealer_Rate_Sheet.pdf";
      link.click();
    });
  }

  var pricingConfirmBtn = document.getElementById("pricing-confirm-btn");
  if (pricingConfirmBtn) {
    pricingConfirmBtn.addEventListener("click", function() {
      if (!pricingState.dealerName) { alert("Please select a dealer first."); return; }
      if (pricingState.locked) { alert("Pricing is locked. Unlock it before making changes."); return; }
      var changes = pricingBuildChanges();
      if (changes.length === 0) { alert("No changes to confirm."); return; }
      document.getElementById("pricing-modal-dealer-name").textContent = "Dealer: " + pricingState.dealerName;
      document.getElementById("confirm-check-2-label").textContent = "I confirm these rates are correct for " + pricingState.dealerName;
      var tableHtml = "<table style='width:100%;border-collapse:collapse;'>" +
        "<thead><tr style='background:#f0f4f8;'><th style='padding:8px;text-align:left;font-size:12px;color:var(--mid);'>Field</th><th style='padding:8px;text-align:right;font-size:12px;color:var(--mid);'>Before</th><th style='padding:8px;text-align:right;font-size:12px;color:var(--mid);'>After</th></tr></thead><tbody>";
      changes.forEach(function(c) {
        tableHtml += "<tr style='border-bottom:1px solid var(--border);'><td style='padding:8px;font-size:13px;'>" + escHtml(c.label) +
          "</td><td style='padding:8px;text-align:right;font-size:13px;color:#c0392b;'>$" + escHtml(String(c.old)) +
          "</td><td style='padding:8px;text-align:right;font-size:13px;color:#0F6E56;font-weight:600;'>$" + escHtml(String(c.next)) + "</td></tr>";
      });
      tableHtml += "</tbody></table>";
      document.getElementById("pricing-changes-table").innerHTML = tableHtml;
      document.getElementById("confirm-check-1").checked = false;
      document.getElementById("confirm-check-2").checked = false;
      var saveBtn = document.getElementById("pricing-modal-save");
      saveBtn.disabled = true;
      saveBtn.style.opacity = "0.4";
      document.getElementById("pricing-confirm-modal").style.display = "flex";
    });
  }

  var modalCancel = document.getElementById("pricing-modal-cancel");
  if (modalCancel) {
    modalCancel.addEventListener("click", function() {
      document.getElementById("pricing-confirm-modal").style.display = "none";
    });
  }

  var modalSave = document.getElementById("pricing-modal-save");
  if (modalSave) {
    modalSave.addEventListener("click", async function() {
      if (this.disabled || !pricingState.pricingId) return;
      this.textContent = "Saving...";
      this.disabled = true;
      var updates = Object.assign({}, pricingState.currentRates, {
        confirmed: true,
        locked: true,
        confirmed_at: new Date().toISOString(),
        confirmed_by: "admin"
      });
      try {
        await fetch(SUPABASE_URL + "/rest/v1/dealer_pricing?id=eq." + pricingState.pricingId, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(updates)
        });
        var changes = pricingBuildChanges();
        for (var i = 0; i < changes.length; i++) {
          var action = changes[i].key.indexOf("contract_retail_") === 0 ? "contract_price_changed" : "pricing_rate_changed";
          await writeAuditLog("pricing", pricingState.pricingId, action, { value: changes[i].old }, { value: changes[i].next }, pricingState.dealerName, null, changes[i].label);
        }
        pricingState.originalRates = Object.assign({}, pricingState.currentRates);
        pricingState.confirmed = true;
        pricingState.locked = true;
        ["1yr", "2yr", "3yr"].forEach(function(yr) {
          var inp = document.getElementById("contract-price-" + yr);
          if (inp) { inp.style.borderColor = ""; inp.style.background = ""; }
        });
        document.getElementById("pricing-confirm-modal").style.display = "none";
        pricingUpdateLockStatus();
        pricingCheckUnsavedChanges();
        await writeAuditLog("pricing", pricingState.pricingId, "pricing_confirmed", null, { dealer: pricingState.dealerName, rates: pricingState.currentRates }, pricingState.dealerName, null, "Pricing confirmed and locked by admin");
        alert("Pricing confirmed and locked for " + pricingState.dealerName + ". You can now generate their contract.");
      } catch (e) {
        alert("Could not save pricing changes. Please try again.");
      }
      this.textContent = "Confirm & Save";
    });
  }

  var unlockBtn = document.getElementById("pricing-unlock-btn");
  if (unlockBtn) {
    unlockBtn.addEventListener("click", function() {
      document.getElementById("unlock-dealer-name-input").value = "";
      document.getElementById("pricing-unlock-modal").style.display = "flex";
    });
  }
  var unlockCancel = document.getElementById("unlock-cancel-btn");
  if (unlockCancel) {
    unlockCancel.addEventListener("click", function() {
      document.getElementById("pricing-unlock-modal").style.display = "none";
    });
  }
  var unlockConfirm = document.getElementById("unlock-confirm-btn");
  if (unlockConfirm) {
    unlockConfirm.addEventListener("click", async function() {
      var typed = document.getElementById("unlock-dealer-name-input").value.trim().toLowerCase();
      var expected = (pricingState.dealerName || "").toLowerCase();
      if (typed !== expected) {
        alert("Dealer name does not match. Please type exactly: " + pricingState.dealerName);
        return;
      }
      if (!pricingState.pricingId) return;
      try {
        await fetch(SUPABASE_URL + "/rest/v1/dealer_pricing?id=eq." + pricingState.pricingId, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ locked: false, confirmed: false })
        });
        pricingState.locked = false;
        pricingState.confirmed = false;
        document.getElementById("pricing-unlock-modal").style.display = "none";
        pricingUpdateLockStatus();
        await writeAuditLog("pricing", pricingState.pricingId, "pricing_unlocked", null, null, pricingState.dealerName, null, "Pricing unlocked for editing");
        alert("Pricing unlocked. You can now make changes.");
      } catch (e) {
        alert("Could not unlock pricing. Please try again.");
      }
    });
  }

  var generateBtn = document.getElementById("pricing-generate-btn");
  if (generateBtn) {
    generateBtn.addEventListener("click", function() {
      if (!pricingState.dealerName) { alert("Please select a dealer first."); return; }
      if (!pricingState.confirmed) { alert("Please confirm pricing before generating a contract."); return; }
      generateDealerContractPDF();
    });
  }

  function ticketStatusHtml(t) {
    var st = String(t.status || "pending").toLowerCase();
    if (st === "approved") return "<div class='ticket-status ticket-status-approved'>🟢 Approved · $150 reimbursement</div>";
    if (st === "rejected") {
      var rr = t.rejectionReason ? " — " + escHtml(t.rejectionReason) : "";
      return "<div class='ticket-status ticket-status-rejected'>🔴 Rejected" + rr + "</div>";
    }
    return "<div class='ticket-status ticket-status-pending'>🟡 Pending — Under review</div>";
  }

  async function updateTicketContractIndicator() {
    var hinEl = document.getElementById("t-hin");
    var el = document.getElementById("t-hin-status");
    if (!el || !hinEl) return;
    var hin = normalizeHin(hinEl.value);
    if (!hin) {
      el.textContent = "";
      return;
    }
    el.textContent = "Checking...";
    el.style.color = "#6b8599";
    try {
      var r = await verifyHINForTicket(hin);
      if (r.valid) {
        el.textContent = "✓ Active contract — " + (r.customer || "");
        el.style.color = "#0F6E56";
      } else if (r.expired) {
        el.textContent = "⚠ Contract expired — " + (r.customer || "customer") + ". Please re-enroll.";
        el.style.color = "#BA7517";
      } else {
        el.textContent = "✗ " + (r.message || "No contract found.");
        el.style.color = "#c0392b";
      }
    } catch (e) {
      el.textContent = "✗ Could not verify HIN right now.";
      el.style.color = "#c0392b";
    }
  }

  (function bindTicketHinVerification() {
    var h = document.getElementById("t-hin");
    if (h) {
      h.addEventListener("input", function() {
        h.value = normalizeHin(h.value);
        var statusEl = document.getElementById("t-hin-status");
        if (statusEl) statusEl.textContent = "";
      });
      h.addEventListener("blur", updateTicketContractIndicator);
    }
  })();

  (function bindEnrollHinUppercase() {
    var h = document.getElementById("e-hin");
    if (h) {
      h.addEventListener("input", function() {
        h.value = normalizeHin(h.value);
        var herr = document.getElementById("e-hin-error");
        if (herr) herr.style.display = "none";
      });
    }
  })();

  // SERVICE TICKET
  document.getElementById("ticket-btn").addEventListener("click", async function() {
    var fname = document.getElementById("t-fname").value;
    var lname = document.getElementById("t-lname").value;
    if (!fname || !lname) { alert("Please enter the customer name."); return; }
    if (!currentDealer || !currentDealer.id) { alert("Session error. Please sign in again."); return; }
    var hinVal = normalizeHin(document.getElementById("t-hin").value);
    var hinResult = await verifyHINForTicket(hinVal);
    if (!hinResult.valid) {
      alert(hinResult.message);
      return;
    }
    var btn = document.getElementById("ticket-btn");
    btn.disabled = true; btn.textContent = "Submitting...";
    document.getElementById("t-ok").style.display = "none";
    document.getElementById("t-err").style.display = "none";
    var sels = document.querySelectorAll(".tb.sel");
    var services = Array.from(sels).map(function(b) { return b.textContent.trim(); }).join(", ");
    var ticketNum = "WSP-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
    var body = {
      ticket_number: ticketNum,
      dealer_id: currentDealer.id,
      dealership_name: currentDealer.name,
      technician: document.getElementById("t-tech").value,
      customer_first_name: fname,
      customer_last_name: lname,
      customer_email: document.getElementById("t-email").value,
      customer_phone: document.getElementById("t-phone").value,
      boat_make: document.getElementById("t-make").value,
      boat_model: document.getElementById("t-model").value,
      boat_year: document.getElementById("t-year").value,
      hin: hinVal,
      engine_hours: document.getElementById("t-hours").value,
      service_type: services || "General Service",
      service_date: document.getElementById("t-date").value,
      service_notes: document.getElementById("t-notes").value,
      status: "pending",
      reimbursement_amount: 150
    };
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/tickets", {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (!res.ok) throw new Error();
      var newTicket = Array.isArray(data) ? data[0] : data;
      await fetch(SUPABASE_URL + "/rest/v1/reimbursements", {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          ticket_id: newTicket.id,
          dealer_id: currentDealer.id,
          dealership_name: currentDealer.name,
          amount: 150,
          status: "pending"
        })
      });
      await writeAuditLog("ticket", newTicket.id, "ticket_submitted", null, { hin: hinVal, services: services }, currentDealer.name, fname + " " + lname, null);
      document.getElementById("t-num").textContent = ticketNum;
      document.getElementById("t-ok").style.display = "block";
      document.getElementById("t-err").style.display = "none";
      document.getElementById("t-ok").scrollIntoView({ behavior: "smooth", block: "center" });
      loadDashboard();
    } catch (e) {
      var terr = document.getElementById("t-err");
      if (terr) {
        terr.textContent = "Something went wrong. Please try again.";
        terr.style.display = "block";
      }
    }
    btn.disabled = false; btn.textContent = "Submit Service Ticket";
  });

  // ENROLL
  document.getElementById("enroll-btn").addEventListener("click", async function() {
    var fname = document.getElementById("e-fname").value;
    var lname = document.getElementById("e-lname").value;
    var email = document.getElementById("e-email").value;
    var hinErrEl = document.getElementById("e-hin-error");
    var hinVal = normalizeHin(document.getElementById("e-hin").value);
    if (hinErrEl) {
      hinErrEl.style.display = "none";
      hinErrEl.textContent = "";
    }
    document.getElementById("e-err").textContent = "Please fill in the customer's name and email before generating a link.";
    if (!fname || !email) {
      document.getElementById("e-err").style.display = "block";
      return;
    }
    if (!hinVal) {
      alert("Hull ID (HIN) is required. No HIN, no enrollment.");
      document.getElementById("e-hin").focus();
      if (hinErrEl) {
        hinErrEl.textContent = "Hull ID (HIN) is required. No HIN, no enrollment.";
        hinErrEl.style.display = "block";
      }
      return;
    }
    if (!currentDealer || !currentDealer.id) {
      document.getElementById("e-err").style.display = "block";
      return;
    }
    document.getElementById("e-err").style.display = "none";
    var btn = document.getElementById("enroll-btn");
    btn.disabled = true;
    btn.textContent = "Verifying…";
    var hinCheck = await verifyHINForEnrollment(
      hinVal,
      document.getElementById("e-fname").value,
      document.getElementById("e-lname").value,
      currentDealer.name
    );
    if (!hinCheck.allowed) {
      if (!hinErrEl) {
        hinErrEl = document.createElement("div");
        hinErrEl.id = "e-hin-error";
        hinErrEl.style.cssText = "font-size:13px;color:#c0392b;margin-top:6px;padding:8px 12px;background:#fff0f0;border-radius:4px;border-left:3px solid #c0392b;";
        document.getElementById("e-hin").parentNode.appendChild(hinErrEl);
      }
      hinErrEl.textContent = hinCheck.message || "Enrollment not allowed.";
      hinErrEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Generate Payment Link";
      return;
    }
    btn.textContent = "Saving…";
    var end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    var endStr = end.toISOString().split("T")[0];
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/contracts", {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          dealer_id: currentDealer.id,
          dealership_name: currentDealer.name,
          customer_first_name: document.getElementById("e-fname").value,
          customer_last_name: document.getElementById("e-lname").value,
          customer_email: document.getElementById("e-email").value,
          customer_phone: document.getElementById("e-phone").value,
          boat_make: document.getElementById("e-make").value,
          boat_model: document.getElementById("e-model").value,
          boat_year: document.getElementById("e-year").value,
          hin: hinVal,
          contract_type: "1yr",
          retail_price: 3699,
          start_date: new Date().toISOString().split("T")[0],
          end_date: endStr,
          status: "active"
        })
      });
      if (!res.ok) throw new Error();
      var contractRows = await res.json();
      var newContract = Array.isArray(contractRows) ? contractRows[0] : null;
      await writeAuditLog("contract", newContract ? newContract.id : null, "customer_enrolled", null, { hin: hinVal, customer: fname + " " + lname, contract_type: "1yr" }, currentDealer.name, fname + " " + lname, null);
      document.getElementById("enroll-link-box").style.display = "block";
      document.getElementById("enroll-link-box").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      document.getElementById("e-err").textContent = "Could not save enrollment. Please try again.";
      document.getElementById("e-err").style.display = "block";
    }
    btn.disabled = false;
    btn.textContent = "Generate Payment Link";
  });

  // PAST TICKETS
  async function loadTickets() {
    var container = document.getElementById("tickets-container");
    container.innerHTML = "<div class='tickets-loading'>Loading your tickets...</div>";
    if (!currentDealer || !currentDealer.name) {
      container.innerHTML = "<div class='no-tickets'>Sign in to view tickets.</div>";
      return;
    }
    try {
      var url = SUPABASE_URL + "/rest/v1/tickets?dealership_name=eq." + encodeURIComponent(currentDealer.name) + "&select=*&order=created_at.desc";
      var r = await fetch(url, { headers: supabaseHeaders() });
      var rows = await r.json();
      if (!r.ok) throw new Error();
      if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = "<div class='no-tickets'>No tickets submitted yet.</div>";
        return;
      }
      var html = "";
      rows.forEach(function(row) {
        var t = mapTicketFromRow(row);
        var services = t.serviceType ? t.serviceType.split(",") : [];
        var pillsHtml = services.map(function(s) { return "<span class='service-pill'>" + escHtml(s.trim()) + "</span>"; }).join("");
        html += "<div class='ticket-card'><div class='ticket-header'><span class='ticket-id'>" + escHtml(t.ticketNum || "") + "</span><span class='ticket-date'>" + escHtml(t.date || "") + "</span></div>";
        html += ticketStatusHtml(t);
        if (pillsHtml) html += "<div class='ticket-services'>" + pillsHtml + "</div>";
        html += "<div class='ticket-grid'>";
        html += "<div class='ticket-field'><label>Customer</label><p>" + escHtml((t.firstName || "") + " " + (t.lastName || "")) + "</p></div>";
        html += "<div class='ticket-field'><label>Email</label><p>" + escHtml(t.email || "—") + "</p></div>";
        html += "<div class='ticket-field'><label>Phone</label><p>" + escHtml(t.phone || "—") + "</p></div>";
        html += "<div class='ticket-field'><label>Boat</label><p>" + escHtml([t.boatMake, t.boatModel, t.year].filter(Boolean).join(" ") || "—") + "</p></div>";
        html += "<div class='ticket-field'><label>HIN</label><p>" + escHtml(t.hin || "—") + "</p></div>";
        html += "<div class='ticket-field'><label>Engine Hours</label><p>" + escHtml(t.engineHours || "—") + "</p></div>";
        html += "<div class='ticket-field'><label>Technician</label><p>" + escHtml(t.technician || "—") + "</p></div>";
        html += "</div>";
        if (t.serviceNotes) html += "<div class='ticket-notes'><label>Notes</label><p>" + escHtml(t.serviceNotes) + "</p></div>";
        html += "</div>";
      });
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = "<div class='no-tickets'>Could not load tickets. Please try again.</div>";
    }
  }

  async function claimsApprove(ticketId) {
    try {
      var url = SUPABASE_URL + "/rest/v1/tickets?id=eq." + encodeURIComponent(ticketId);
      var r1 = await fetch(url, {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ status: "approved" })
      });
      if (!r1.ok) throw new Error();
      await writeAuditLog("ticket", ticketId, "ticket_approved", { status: "pending" }, { status: "approved" }, "admin", null, null);
      await claimsLoadTab();
    } catch (e) {
      alert("Could not approve. Please try again.");
    }
  }

  async function claimsReject(ticketId, reason) {
    try {
      var url = SUPABASE_URL + "/rest/v1/tickets?id=eq." + encodeURIComponent(ticketId);
      var r1 = await fetch(url, {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ status: "rejected", rejection_reason: reason })
      });
      if (!r1.ok) throw new Error();
      await fetch(SUPABASE_URL + "/rest/v1/reimbursements?ticket_id=eq." + encodeURIComponent(ticketId), {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ status: "rejected" })
      });
      await writeAuditLog("reimbursement", ticketId, "reimbursement_rejected", { status: "pending" }, { status: "rejected" }, "admin", null, reason);
      await writeAuditLog("ticket", ticketId, "ticket_rejected", { status: "pending" }, { status: "rejected", reason: reason }, "admin", null, reason);
      await claimsLoadTab();
    } catch (e) {
      alert("Could not reject. Please try again.");
    }
  }

  async function claimsMarkDealerPaid(dealershipName) {
    try {
      var resT = await fetch(SUPABASE_URL + "/rest/v1/tickets?status=eq.approved&select=id", { headers: supabaseHeaders() });
      var approved = await resT.json();
      var approvedIds = new Set((Array.isArray(approved) ? approved : []).map(function(x) { return x.id; }));
      var resR = await fetch(
        SUPABASE_URL + "/rest/v1/reimbursements?dealership_name=eq." + encodeURIComponent(dealershipName) + "&status=eq.pending&select=*",
        { headers: supabaseHeaders() }
      );
      var reims = await resR.json();
      if (!resR.ok) throw new Error();
      var list = (Array.isArray(reims) ? reims : []).filter(function(r) { return approvedIds.has(r.ticket_id); });
      var today = new Date().toISOString().split("T")[0];
      for (var i = 0; i < list.length; i++) {
        await fetch(SUPABASE_URL + "/rest/v1/reimbursements?id=eq." + encodeURIComponent(list[i].id), {
          method: "PATCH",
          headers: supabaseHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ status: "paid", paid_date: today })
        });
        await writeAuditLog("reimbursement", list[i].id, "reimbursement_paid", { status: "pending" }, { status: "paid", paid_date: today }, list[i].dealership_name || dealershipName, null, null);
      }
      await claimsLoadTab();
    } catch (e) {
      alert("Could not update. Please try again.");
    }
  }

  async function claimsLoadPending() {
    var el = document.getElementById("claims-pending-body");
    if (!el) return;
    el.innerHTML = "Loading…";
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/tickets?status=eq.pending&select=*&order=created_at.desc", {
        headers: supabaseHeaders()
      });
      var rows = await res.json();
      if (!res.ok) throw new Error();
      if (!Array.isArray(rows) || rows.length === 0) {
        el.innerHTML = "<div class='renewals-empty'>No pending tickets.</div>";
        return;
      }
      var html = "";
      rows.forEach(function(row) {
        var t = mapTicketFromRow(row);
        var services = (t.serviceType || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
        var pillsHtml = services.map(function(s) { return "<span class='service-pill'>" + escHtml(s) + "</span>"; }).join("");
        var boat = [t.boatMake, t.boatModel, t.year].filter(Boolean).join(" ");
        var subDate = row.created_at ? new Date(row.created_at).toLocaleString() : "—";
        html += "<div class='claims-queue-row' data-ticket-id='" + escHtml(String(row.id)) + "'>";
        html += "<div class='claims-queue-head'><div><strong>" + escHtml(t.ticketNum) + "</strong> <span class='claims-queue-meta'>" + escHtml(t.dealership) + "</span></div>";
        html += "<div>" + escHtml(subDate) + "</div></div>";
        html += "<div><strong>" + escHtml((t.firstName || "") + " " + (t.lastName || "")) + "</strong></div>";
        html += "<div style='font-size:12px;color:var(--mid);margin-top:0.25rem;'>" + escHtml(boat) + "</div>";
        if (pillsHtml) html += "<div class='ticket-services' style='margin-top:0.5rem;'>" + pillsHtml + "</div>";
        html += "<div style='margin-top:0.5rem;font-weight:600;color:var(--navy);'>$150 reimbursement</div>";
        html += "<div class='claims-queue-actions'>";
        html += "<button type='button' class='btn-claims-approve' data-tid='" + escHtml(String(row.id)) + "'>Approve</button>";
        html += "<input type='text' class='claims-reject-reason' placeholder='Rejection reason' />";
        html += "<button type='button' class='btn-claims-reject' data-tid='" + escHtml(String(row.id)) + "'>Reject</button>";
        html += "</div></div>";
      });
      el.innerHTML = html;
      el.querySelectorAll(".btn-claims-approve").forEach(function(btn) {
        btn.addEventListener("click", function() {
          claimsApprove(btn.getAttribute("data-tid"));
        });
      });
      el.querySelectorAll(".btn-claims-reject").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var row = btn.closest(".claims-queue-row");
          var tid = btn.getAttribute("data-tid");
          var inp = row ? row.querySelector(".claims-reject-reason") : null;
          var reason = inp ? inp.value.trim() : "";
          if (!reason) { alert("Enter a rejection reason."); return; }
          claimsReject(tid, reason);
        });
      });
    } catch (e) {
      el.innerHTML = "<div class='renewals-empty'>Could not load claims. Please try again.</div>";
    }
  }

  async function claimsLoadUnpaid() {
    var el = document.getElementById("claims-unpaid-body");
    if (!el) return;
    el.innerHTML = "Loading…";
    try {
      var resT = await fetch(SUPABASE_URL + "/rest/v1/tickets?status=eq.approved&select=id", { headers: supabaseHeaders() });
      var approved = await resT.json();
      var approvedIds = new Set((Array.isArray(approved) ? approved : []).map(function(x) { return x.id; }));
      var resR = await fetch(SUPABASE_URL + "/rest/v1/reimbursements?status=eq.pending&select=*", { headers: supabaseHeaders() });
      var reims = await resR.json();
      if (!resR.ok) throw new Error();
      var list = (Array.isArray(reims) ? reims : []).filter(function(r) { return approvedIds.has(r.ticket_id); });
      if (list.length === 0) {
        el.innerHTML = "<div class='renewals-empty'>No pending payouts.</div>";
        return;
      }
      var byDealer = {};
      list.forEach(function(r) {
        var dn = r.dealership_name || "—";
        if (!byDealer[dn]) byDealer[dn] = { name: dn, tickets: 0, amount: 0 };
        byDealer[dn].tickets += 1;
        byDealer[dn].amount += parseFloat(r.amount) || 0;
      });
      var html = "";
      Object.keys(byDealer).sort().forEach(function(k) {
        var g = byDealer[k];
        html += "<div class='claims-unpaid-group'>";
        html += "<div><strong>" + escHtml(g.name) + "</strong><br><span style='font-size:12px;color:var(--light);'>" + g.tickets + " approved ticket(s) · $" + Math.round(g.amount).toLocaleString() + " owed</span></div>";
        html += "<button type='button' class='btn-claims-paid' data-dealer-enc='" + encodeURIComponent(g.name) + "'>Mark as paid</button>";
        html += "</div>";
      });
      el.innerHTML = html;
      el.querySelectorAll(".btn-claims-paid").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var dn = decodeURIComponent(btn.getAttribute("data-dealer-enc") || "");
          if (!confirm("Mark all approved pending reimbursements for " + dn + " as paid?")) return;
          claimsMarkDealerPaid(dn);
        });
      });
    } catch (e) {
      el.innerHTML = "<div class='renewals-empty'>Could not load reimbursements.</div>";
    }
  }

  async function claimsLoadHistory() {
    var el = document.getElementById("claims-history-body");
    var totalEl = document.getElementById("claims-history-total");
    if (!el) return;
    el.innerHTML = "Loading…";
    if (totalEl) totalEl.textContent = "";
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/reimbursements?status=eq.paid&select=*&order=paid_date.desc", {
        headers: supabaseHeaders()
      });
      var rows = await res.json();
      if (!res.ok) throw new Error();
      var arr = Array.isArray(rows) ? rows : [];
      var y = new Date().getFullYear();
      var ytd = 0;
      arr.forEach(function(r) {
        if (r.paid_date && String(r.paid_date).indexOf(String(y)) === 0) ytd += parseFloat(r.amount) || 0;
      });
      if (totalEl) totalEl.textContent = "Total paid out year-to-date (" + y + "): $" + Math.round(ytd).toLocaleString();
      if (arr.length === 0) {
        el.innerHTML = "<div class='renewals-empty'>No paid reimbursements yet.</div>";
        return;
      }
      var ticketIds = arr.map(function(r) { return r.ticket_id; }).filter(Boolean);
      var ticketMap = {};
      if (ticketIds.length) {
        var uniq = Array.from(new Set(ticketIds.map(String)));
        var inList = uniq.join(",");
        var tres = await fetch(
          SUPABASE_URL + "/rest/v1/tickets?id=in.(" + inList + ")&select=id,ticket_number",
          { headers: supabaseHeaders() }
        );
        var trows = await tres.json();
        if (Array.isArray(trows)) trows.forEach(function(t) { ticketMap[t.id] = t.ticket_number; });
      }
      var html = "";
      arr.forEach(function(r) {
        var pd = r.paid_date ? new Date(r.paid_date).toLocaleDateString() : "—";
        var tn = ticketMap[r.ticket_id] || "—";
        html += "<div class='claims-history-row'>";
        html += "<span>" + escHtml(r.dealership_name || "—") + "</span>";
        html += "<span>$" + Math.round(parseFloat(r.amount) || 0).toLocaleString() + "</span>";
        html += "<span>" + escHtml(pd) + "</span>";
        html += "<span>" + escHtml(String(tn)) + "</span>";
        html += "</div>";
      });
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = "<div class='renewals-empty'>Could not load history.</div>";
      if (totalEl) totalEl.textContent = "";
    }
  }

  async function claimsLoadTab() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    await Promise.all([claimsLoadPending(), claimsLoadUnpaid(), claimsLoadHistory()]);
  }

  var applicationsGridBound = false;

  async function applicationsDoApprove(appId) {
    if (!currentDealer || !currentDealer.isAdmin) return;
    var app = applicationsLastData.pending.find(function(p) { return String(p.id) === String(appId); });
    if (!app) {
      alert("Application not found. Refresh and try again.");
      return;
    }

    try {
      var reviewedBy = currentDealer.username || "admin";
      var username = await applicationsEnsureUniqueUsername(generateUsername(app.dealership_name));
      var tempPassword = generateTempPassword();
      var detachedClient = createDetachedSupabaseClient();
      var signUpResult = await detachedClient.auth.signUp({
        email: app.email,
        password: tempPassword,
        options: {
          emailRedirectTo: "https://whitestone-dealer-portal.vercel.app"
        }
      });

      if (signUpResult.error) {
        console.error("Supabase auth signup failed", signUpResult.error);
        alert("Could not create the dealer's login account. Please try again.");
        return;
      }

      var authId = signUpResult.data && signUpResult.data.user ? signUpResult.data.user.id : null;
      var dealerBody = {
        username: username,
        password: tempPassword,
        dealership_name: app.dealership_name || "",
        location: app.location || "",
        phone: app.phone || "",
        email: app.email || "",
        auth_id: authId,
        active: true,
        is_admin: false
      };

      var postRes = await fetch(SUPABASE_URL + "/rest/v1/dealers", {
        method: "POST",
        headers: authHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(dealerBody)
      });
      if (!postRes.ok) {
        console.error("Dealer record creation failed", await postRes.text());
        alert("Could not create the dealer record after creating auth access. Please check Supabase and try again.");
        return;
      }

      var patchUrl = SUPABASE_URL + "/rest/v1/dealer_applications?id=eq." + encodeURIComponent(String(appId));
      var patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: authHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          reviewed_by: reviewedBy
        })
      });
      if (!patchRes.ok) {
        console.error("Application approval update failed", await patchRes.text());
        alert("Dealer account created, but the application status could not be updated. Please refresh and review it.");
        return;
      }

      await writeAuditLog(
        "application",
        appId,
        "application_approved",
        null,
        { dealer: app.dealership_name, email: app.email },
        app.dealership_name,
        null,
        "Dealer approved and Supabase Auth account created"
      );

      var welcomeMsg =
        "Welcome to the Whitestone Partners certified dealer network!\n\n" +
        "Your dealer portal access has been set up. Here are your login credentials:\n\n" +
        "Dealer Portal: https://whitestone-dealer-portal.vercel.app\n" +
        "Email: " + (app.email || "") + "\n" +
        "Temporary Password: " + tempPassword + "\n\n" +
        "Please sign in and reset your password if needed, or contact support@whitestone-partners.com if you have any questions.\n\n" +
        "Welcome to the network.\n" +
        "— Whitestone Partners Team";
      try {
        await fetch(FORMSPREE_CONTACT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            email: app.email,
            subject: "Welcome to Whitestone Partners",
            message: welcomeMsg
          })
        });
      } catch (e2) {
        console.error("Welcome email send failed", e2);
      }

      var toast = document.getElementById("applications-toast");
      if (toast) {
        toast.textContent = "Dealer approved. A welcome email with login instructions has been sent to " + (app.email || "") + ".";
        toast.style.display = "block";
        setTimeout(function() { toast.style.display = "none"; }, 9000);
      }

      await applicationsLoadPanel();
      if (currentDealer && currentDealer.isAdmin) {
        adminLoadNetworkDashboard();
      }
    } catch (err) {
      console.error("Dealer approval failed", err);
      alert("Something went wrong while approving this dealer. Please try again.");
    }
  }

  async function applicationsDoDecline(appId, reason) {
    if (!currentDealer || !currentDealer.isAdmin) return;
    var app = applicationsLastData.pending.find(function(p) { return String(p.id) === String(appId); });
    if (!app) return;
    var reviewedBy = currentDealer.username || "admin";
    var newNotes = app.notes || "";
    if (reason && String(reason).trim()) {
      newNotes = newNotes + (newNotes ? "\n" : "") + "[Declined by admin] " + String(reason).trim();
    }
    var patchUrl = SUPABASE_URL + "/rest/v1/dealer_applications?id=eq." + encodeURIComponent(String(appId));
    var patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        status: "declined",
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewedBy,
        notes: newNotes
      })
    });
    if (!patchRes.ok) {
      alert("Could not decline application.");
      return;
    }
    await applicationsLoadPanel();
  }

  async function applicationsLoadPanel() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    var loading = document.getElementById("applications-loading");
    var grid = document.getElementById("applications-grid");
    if (loading) loading.style.display = "block";
    if (grid) grid.style.display = "none";
    try {
      var resP = await fetch(
        SUPABASE_URL + "/rest/v1/dealer_applications?status=eq.pending&select=*&order=created_at.desc",
        { headers: supabaseHeaders() }
      );
      var pending = await resP.json();
      if (!resP.ok) throw new Error();
      pending = Array.isArray(pending) ? pending : [];

      var resA = await fetch(
        SUPABASE_URL + "/rest/v1/dealers?active=eq.true&is_admin=eq.false&select=*&order=dealership_name.asc",
        { headers: supabaseHeaders() }
      );
      var active = await resA.json();
      if (!resA.ok) throw new Error();
      active = Array.isArray(active) ? active : [];

      var resD = await fetch(
        SUPABASE_URL + "/rest/v1/dealer_applications?status=eq.declined&select=*&order=created_at.desc",
        { headers: supabaseHeaders() }
      );
      var declined = await resD.json();
      if (!resD.ok) throw new Error();
      declined = Array.isArray(declined) ? declined : [];

      var resI = await fetch(
        SUPABASE_URL + "/rest/v1/dealers?active=eq.false&is_admin=eq.false&select=*&order=dealership_name.asc",
        { headers: supabaseHeaders() }
      );
      var inactive = await resI.json();
      if (!resI.ok) throw new Error();
      inactive = Array.isArray(inactive) ? inactive : [];

      applicationsLastData = { pending: pending, active: active, declined: declined, inactive: inactive };
      applicationsUpdateTabBadge(pending.length);

      var elPend = document.getElementById("applications-count-pending");
      var elAct = document.getElementById("applications-count-active");
      var elThird = document.getElementById("applications-count-third");
      if (elPend) elPend.textContent = String(pending.length);
      if (elAct) elAct.textContent = String(active.length);
      if (elThird) elThird.textContent = String(declined.length + inactive.length);

      var pb = document.getElementById("applications-pending-body");
      if (pb) {
        if (!pending.length) {
          pb.innerHTML = "<div class='applications-muted'>No pending applications — you're all caught up.</div>";
        } else {
          pb.innerHTML = pending
            .map(function(app) {
              var aid = String(app.id);
              var safeId = escHtml(aid);
              return (
                "<div class='card application-card' data-application-id='" +
                safeId +
                "'>" +
                "<div class='application-card-title'>" +
                escHtml(app.dealership_name || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Contact:</strong> " +
                escHtml(app.contact_name || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Location:</strong> " +
                escHtml(app.location || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Email:</strong> <a href=\"mailto:" +
                escHtml(app.email || "") +
                "\">" +
                escHtml(app.email || "—") +
                "</a></div>" +
                "<div class='application-card-meta'><strong>Phone:</strong> " +
                escHtml(app.phone || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Notes:</strong> " +
                escHtml(app.notes || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Applied:</strong> " +
                escHtml(formatApplicationDate(app.created_at)) +
                "</div>" +
                "<div class='application-card-actions'>" +
                "<button type=\"button\" class=\"applications-btn-approve app-act-approve\" data-app-id=\"" +
                safeId +
                "\">Approve</button>" +
                "<button type=\"button\" class=\"btn-sm btn-remove app-act-decline-toggle\" data-app-id=\"" +
                safeId +
                "\">Decline</button>" +
                "</div>" +
                "<div class=\"applications-decline-box\" id=\"app-decline-" +
                safeId +
                "\" style=\"display:none\">" +
                "<input type=\"text\" class=\"app-decline-reason\" placeholder=\"Reason for declining (optional)\" data-app-id=\"" +
                safeId +
                "\" />" +
                "<button type=\"button\" class=\"btn-sm btn-remove app-act-decline-go\" data-app-id=\"" +
                safeId +
                "\">Confirm decline</button>" +
                "</div></div>"
              );
            })
            .join("");
        }
      }

      var ab = document.getElementById("applications-active-body");
      if (ab) {
        if (!active.length) {
          ab.innerHTML = "<div class='applications-muted'>No active dealers in this list.</div>";
        } else {
          ab.innerHTML = active
            .map(function(d) {
              var did = escHtml(String(d.id));
              return (
                "<div class='card application-card application-card-active'>" +
                "<div class='application-card-title'>" +
                escHtml(d.dealership_name || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Location:</strong> " +
                escHtml(d.location || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Email:</strong> " +
                escHtml(d.email || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Username:</strong> " +
                escHtml(d.username || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Joined:</strong> " +
                escHtml(formatApplicationDate(d.created_at)) +
                "</div>" +
                "<div class='application-card-actions'>" +
                "<button type=\"button\" class=\"btn-sm btn-remove app-act-deactivate\" data-dealer-id=\"" +
                did +
                "\" data-username=\"" +
                escHtml(d.username || "") +
                "\">Deactivate</button>" +
                "</div></div>"
              );
            })
            .join("");
        }
      }

      var tb = document.getElementById("applications-third-body");
      if (tb) {
        var thirdItems = [];
        declined.forEach(function(a) {
          thirdItems.push({
            kind: "declined_app",
            sort: new Date(a.reviewed_at || a.created_at).getTime(),
            row: a
          });
        });
        inactive.forEach(function(d) {
          thirdItems.push({
            kind: "inactive_dealer",
            sort: new Date(d.created_at).getTime(),
            row: d
          });
        });
        thirdItems.sort(function(x, y) { return y.sort - x.sort; });
        if (!thirdItems.length) {
          tb.innerHTML = "<div class='applications-muted'>No declined applications or inactive dealers.</div>";
        } else {
          tb.innerHTML = thirdItems
            .map(function(item) {
              if (item.kind === "declined_app") {
                var a = item.row;
                var aid = escHtml(String(a.id));
                return (
                  "<div class='card application-card application-card-third application-card-declined-app'>" +
                  "<div class='application-card-title'>" +
                  escHtml(a.dealership_name || "—") +
                  "</div>" +
                  "<div class='application-card-meta'><span class='applications-muted'>Declined application</span></div>" +
                  "<div class='application-card-meta'><strong>Email:</strong> " +
                  escHtml(a.email || "—") +
                  "</div>" +
                  "<div class='application-card-meta'><strong>Date:</strong> " +
                  escHtml(formatApplicationDate(a.reviewed_at || a.created_at)) +
                  "</div>" +
                  "<div class='application-card-actions'>" +
                  "<button type=\"button\" class=\"btn-add app-act-reconsider\" style=\"padding:8px 14px;font-size:12px;\" data-app-id=\"" +
                  aid +
                  "\">Reconsider</button>" +
                  "</div></div>"
                );
              }
              var d = item.row;
              var did = escHtml(String(d.id));
              var u = d.username || "";
              var dis =
                u === "admin"
                  ? " disabled style='opacity:0.45;cursor:not-allowed;'"
                  : "";
              return (
                "<div class='card application-card application-card-third application-card-inactive'>" +
                "<div class='application-card-title'>" +
                escHtml(d.dealership_name || "—") +
                "</div>" +
                "<div class='application-card-meta'><span class='applications-muted'>Inactive dealer</span></div>" +
                "<div class='application-card-meta'><strong>Email:</strong> " +
                escHtml(d.email || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Username:</strong> " +
                escHtml(u || "—") +
                "</div>" +
                "<div class='application-card-meta'><strong>Date:</strong> " +
                escHtml(formatApplicationDate(d.created_at)) +
                "</div>" +
                "<div class='application-card-actions'>" +
                "<button type=\"button\" class=\"btn-sm btn-remove app-act-reactivate\" data-dealer-id=\"" +
                did +
                "\" data-username=\"" +
                escHtml(u) +
                "\"" +
                dis +
                ">Reactivate</button>" +
                "</div></div>"
              );
            })
            .join("");
        }
      }

      if (loading) loading.style.display = "none";
      if (grid) grid.style.display = "grid";
    } catch (e) {
      if (loading) loading.style.display = "none";
      if (grid) grid.style.display = "none";
      var pb2 = document.getElementById("applications-pending-body");
      if (pb2) pb2.innerHTML = "<div class='applications-muted'>Could not load applications. Check the dealer_applications table and try again.</div>";
    }

    if (!applicationsGridBound && document.getElementById("applications-grid")) {
      applicationsGridBound = true;
      document.getElementById("applications-grid").addEventListener("click", function(ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        if (t.classList.contains("app-act-approve")) {
          var aid = t.getAttribute("data-app-id");
          if (aid && confirm("Create dealer account and send welcome email?")) applicationsDoApprove(aid);
          return;
        }
        if (t.classList.contains("app-act-decline-toggle")) {
          var did = t.getAttribute("data-app-id");
          var box = document.getElementById("app-decline-" + did);
          if (box) box.style.display = box.style.display === "none" ? "block" : "none";
          return;
        }
        if (t.classList.contains("app-act-decline-go")) {
          var aid2 = t.getAttribute("data-app-id");
          var reason = "";
          var inpDecl = null;
          document.querySelectorAll(".app-decline-reason").forEach(function(el) {
            if (el.getAttribute("data-app-id") === aid2) inpDecl = el;
          });
          if (inpDecl) reason = inpDecl.value;
          applicationsDoDecline(aid2, reason);
          return;
        }
        if (t.classList.contains("app-act-deactivate")) {
          var idDealer = t.getAttribute("data-dealer-id");
          var uname = t.getAttribute("data-username");
          if (uname === "admin") return;
          if (!confirm("Deactivate this dealer? They will not be able to sign in.")) return;
          fetch(SUPABASE_URL + "/rest/v1/dealers?id=eq." + encodeURIComponent(idDealer), {
            method: "PATCH",
            headers: supabaseHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ active: false })
          }).then(function(r) {
            if (r.ok) applicationsLoadPanel();
            else alert("Could not deactivate.");
          });
          return;
        }
        if (t.classList.contains("app-act-reactivate")) {
          if (t.disabled) return;
          var idR = t.getAttribute("data-dealer-id");
          fetch(SUPABASE_URL + "/rest/v1/dealers?id=eq." + encodeURIComponent(idR), {
            method: "PATCH",
            headers: supabaseHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ active: true })
          }).then(function(r) {
            if (r.ok) {
              applicationsLoadPanel();
              if (currentDealer && currentDealer.isAdmin) adminLoadNetworkDashboard();
            } else alert("Could not reactivate.");
          });
          return;
        }
        if (t.classList.contains("app-act-reconsider")) {
          var appRec = t.getAttribute("data-app-id");
          fetch(SUPABASE_URL + "/rest/v1/dealer_applications?id=eq." + encodeURIComponent(appRec), {
            method: "PATCH",
            headers: supabaseHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ status: "pending", reviewed_at: null, reviewed_by: null })
          }).then(function(r) {
            if (r.ok) applicationsLoadPanel();
            else alert("Could not update application.");
          });
        }
      });
    }
  }

  var supportSubmitBtn = document.getElementById("support-submit-btn");
  if (supportSubmitBtn) {
    supportSubmitBtn.addEventListener("click", async function() {
      var type = document.getElementById("support-type").value;
      var message = document.getElementById("support-message").value.trim();
      if (!type) { alert("Please select a request type."); return; }
      if (!message) { alert("Please enter a message."); return; }

      var btn = document.getElementById("support-submit-btn");
      var okEl = document.getElementById("support-ok");
      var errEl = document.getElementById("support-err");
      btn.disabled = true;
      btn.textContent = "Sending...";

      try {
        var res = await fetch(SUPABASE_URL + "/rest/v1/dealer_messages", {
          method: "POST",
          headers: authHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({
            dealer_id: currentDealer && currentDealer.id ? currentDealer.id : null,
            dealership_name: currentDealer ? currentDealer.name : "",
            request_type: type,
            message: message,
            status: "new"
          })
        });
        if (res.ok || res.status === 201) {
          if (okEl) okEl.style.display = "block";
          if (errEl) errEl.style.display = "none";
          document.getElementById("support-type").value = "";
          document.getElementById("support-message").value = "";
          if (currentDealer && currentDealer.isAdmin) adminLoadMessages();
        } else {
          if (errEl) errEl.style.display = "block";
        }
      } catch (e) {
        if (errEl) errEl.style.display = "block";
      }

      btn.disabled = false;
      btn.textContent = "Send Message";
    });
  }

  // CONTACT
  document.getElementById("dc-btn").addEventListener("click", function() {
    var name = document.getElementById("dc-name").value;
    var email = document.getElementById("dc-email").value;
    var msg = document.getElementById("dc-message").value;
    if (!name || !email || !msg) { alert("Please fill in all fields."); return; }
    var btn = document.getElementById("dc-btn");
    btn.disabled = true; btn.textContent = "Sending...";
    fetch(FORMSPREE_CONTACT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        "email": email,
        "Name": name,
        "Dealership": currentDealer ? currentDealer.name : "",
        "Subject": document.getElementById("dc-subject").value,
        "Message": msg
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) {
        document.getElementById("dc-ok").style.display = "block";
        document.getElementById("dc-err").style.display = "none";
      } else {
        document.getElementById("dc-err").style.display = "block";
        btn.disabled = false; btn.textContent = "Send Message";
      }
    })
    .catch(function() {
      document.getElementById("dc-err").style.display = "block";
      btn.disabled = false; btn.textContent = "Send Message";
    });
  });

  // ADMIN — RENDER DEALER TABLE
  async function renderDealerTable() {
    var tbody = document.getElementById("dealer-tbody");
    if (!tbody) return;
    tbody.innerHTML = "<tr><td colspan='4'>Loading dealers…</td></tr>";
    try {
      var rows = await fetchDealersSupabase();
      dealerRowsCache = rows;
      tbody.innerHTML = "";
      rows.forEach(function(d) {
        if (d.is_admin) return;
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><strong>" + escHtml(d.username) + "</strong></td>" +
          "<td>" + escHtml(d.dealership_name) + "</td>" +
          "<td><span class='" + (d.active ? "badge-active" : "badge-inactive") + "'>" + (d.active ? "Active" : "Inactive") + "</span></td>" +
          "<td><button class='btn-sm btn-remove' type='button' data-dealer-id='" + escHtml(String(d.id)) + "' data-username='" + escHtml(d.username) + "'" +
          (d.username === "admin" ? " disabled style='opacity:0.4;cursor:not-allowed;'" : "") +
          ">Remove</button></td>";
        tbody.appendChild(tr);
      });
      tbody.querySelectorAll(".btn-remove").forEach(function(btn) {
        btn.addEventListener("click", async function() {
          var user = btn.getAttribute("data-username");
          var id = btn.getAttribute("data-dealer-id");
          if (user === "admin") return;
          if (!confirm("Deactivate dealer '" + user + "'? They will no longer be able to sign in.")) return;
          try {
            var r = await fetch(SUPABASE_URL + "/rest/v1/dealers?id=eq." + encodeURIComponent(id), {
              method: "PATCH",
              headers: supabaseHeaders({ Prefer: "return=minimal" }),
              body: JSON.stringify({ active: false })
            });
            if (!r.ok) throw new Error();
            renderDealerTable();
            if (currentDealer && currentDealer.isAdmin) {
              adminLoadNetworkDashboard();
            }
          } catch (e) {
            alert("Could not update dealer. Please try again.");
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = "<tr><td colspan='4'>Could not load dealers.</td></tr>";
    }
  }

  // ADMIN — ADD DEALER
  document.getElementById("add-dealer-btn").addEventListener("click", async function() {
    var email = document.getElementById("new-username").value.trim().toLowerCase();
    var password = document.getElementById("new-password").value.trim();
    var name = document.getElementById("new-name").value.trim();
    var addOk = document.getElementById("add-ok");
    var addErr = document.getElementById("add-err");
    if (!email || !password || !name) { addErr.style.display = "block"; addOk.style.display = "none"; return; }
    if (email.indexOf("@") === -1) {
      addErr.textContent = "Enter an email address for the new dealer login.";
      addErr.style.display = "block";
      addOk.style.display = "none";
      return;
    }
    try {
      var baseUsername = generateUsername(email.split("@")[0] || name);
      var username = await applicationsEnsureUniqueUsername(baseUsername);
      var detachedClient = createDetachedSupabaseClient();
      var signUpResult = await detachedClient.auth.signUp({
        email: email,
        password: password,
        options: {
          emailRedirectTo: "https://whitestone-dealer-portal.vercel.app"
        }
      });
      if (signUpResult.error) throw signUpResult.error;

      var res = await fetch(SUPABASE_URL + "/rest/v1/dealers", {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          username: username,
          password: password,
          dealership_name: name,
          email: email,
          auth_id: signUpResult.data && signUpResult.data.user ? signUpResult.data.user.id : null,
          active: true,
          is_admin: false
        })
      });
      if (!res.ok) throw new Error();
      document.getElementById("new-username").value = "";
      document.getElementById("new-password").value = "";
      document.getElementById("new-name").value = "";
      addOk.style.display = "block"; addErr.style.display = "none";
      setTimeout(function() { addOk.style.display = "none"; }, 3000);
      renderDealerTable();
      if (currentDealer && currentDealer.isAdmin) adminLoadNetworkDashboard();
    } catch (e) {
      console.error("Could not add dealer", e);
      addErr.textContent = "Could not add dealer. Use a valid email and try again.";
      addErr.style.display = "block"; addOk.style.display = "none";
    }
  });

});