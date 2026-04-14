var SUPABASE_URL = "https://ypuohmiynnmbnlqfctlg.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwdW9obWl5bm5tYm5scWZjdGxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwODU4NzEsImV4cCI6MjA5MTY2MTg3MX0.HzrF_OCr2T9rKV9am90B2OvIQKjq28pObheMRps82AI";
var FORMSPREE_CONTACT = "https://formspree.io/f/mvzvzkqa";
var currentDealer = null;
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

var ADMIN_CONTRACT_AVG = 3699;
var ADMIN_AVG_REIMB = 150;
var ADMIN_COMMISSION_RATE = 0.2;

function supabaseHeaders(extra) {
  var h = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  };
  if (extra) {
    Object.keys(extra).forEach(function(k) { h[k] = extra[k]; });
  }
  return h;
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

function normalizeHin(s) {
  return String(s || "").trim().toUpperCase();
}

function ticketBillable(t) {
  var st = (t.status || "pending").toLowerCase();
  return st === "approved" || st === "pending";
}

async function verifyHIN(hin, customerFirstName, customerLastName, dealerName) {
  var hinU = normalizeHin(hin);
  var res = await fetch(
    SUPABASE_URL + "/rest/v1/contracts?hin=eq." + encodeURIComponent(hinU) + "&select=*",
    { headers: supabaseHeaders() }
  );
  var existing = await res.json();
  if (!res.ok || !Array.isArray(existing)) {
    return { allowed: false, message: "Could not verify HIN. Please try again." };
  }
  if (!existing || existing.length === 0) {
    return { allowed: true };
  }
  var activeContracts = existing.filter(function(c) { return String(c.status || "").toLowerCase() === "active"; });
  var existingCustomer =
    String(existing[0].customer_first_name || "").trim() + " " + String(existing[0].customer_last_name || "").trim();
  var newCustomer =
    String(customerFirstName || "").trim() + " " + String(customerLastName || "").trim();
  var isSameCustomer = existingCustomer.toLowerCase().trim() === newCustomer.toLowerCase().trim();
  if (isSameCustomer && activeContracts.length > 0) {
    return {
      allowed: false,
      reason: "active_same_customer",
      message:
        "This boat already has an active Whitestone contract. The current contract must expire before renewal. Contract ends: " +
        (activeContracts[0].end_date || "—")
    };
  }
  if (!isSameCustomer && activeContracts.length > 0) {
    await logHINConflict(
      hinU,
      dealerName,
      newCustomer.trim(),
      existingCustomer.trim(),
      "active",
      "HIN has active contract under different customer name"
    );
    return {
      allowed: false,
      reason: "active_different_customer",
      message:
        "This HIN is registered to another customer with an active contract. Contracts do not transfer with ownership. Please contact Whitestone Partners at sales@whitestone-partners.com to resolve."
    };
  }
  if (!isSameCustomer && activeContracts.length === 0) {
    return { allowed: true, isNewOwner: true };
  }
  if (isSameCustomer && activeContracts.length === 0) {
    return { allowed: true, isRenewal: true };
  }
  return { allowed: true };
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

async function verifyCustomerContract(firstName, lastName, hin, dealerName) {
  var hinU = normalizeHin(hin);
  if (!hinU) {
    return { valid: false, ui: "err", message: "HIN is required to submit a ticket." };
  }
  var res = await fetch(
    SUPABASE_URL + "/rest/v1/contracts?hin=eq." + encodeURIComponent(hinU) + "&status=eq.active&select=*",
    { headers: supabaseHeaders() }
  );
  var contracts = await res.json();
  if (!res.ok || !Array.isArray(contracts)) {
    return { valid: false, ui: "err", message: "Could not verify contract. Please try again." };
  }
  if (!contracts || contracts.length === 0) {
    var expRes = await fetch(
      SUPABASE_URL + "/rest/v1/contracts?hin=eq." + encodeURIComponent(hinU) + "&status=eq.expired&select=*",
      { headers: supabaseHeaders() }
    );
    var expContracts = await expRes.json();
    if (expRes.ok && Array.isArray(expContracts) && expContracts.length > 0) {
      return {
        valid: false,
        ui: "warn",
        message: "This customer's contract has expired. Please re-enroll them before submitting a ticket."
      };
    }
    return {
      valid: false,
      ui: "err",
      message: "No active contract found for this HIN. Please enroll this customer first."
    };
  }
  var c = contracts[0];
  var nameOnFile = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim().toLowerCase();
  var entered = ((firstName || "") + " " + (lastName || "")).trim().toLowerCase();
  if (nameOnFile !== entered) {
    return {
      valid: false,
      ui: "err",
      message: "The name entered does not match the customer on file for this HIN."
    };
  }
  var dispName = ((c.customer_first_name || "") + " " + (c.customer_last_name || "")).trim();
  return { valid: true, contract: c, displayName: dispName, ui: "ok" };
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
  } catch (e) {
    pricingModelServices = pricingDefaultServices();
  }
  var c = document.getElementById("pricing-slider-commission");
  var cl = document.getElementById("pricing-slider-claims");
  var cv = localStorage.getItem("wsp_pricing_commission");
  var clv = localStorage.getItem("wsp_pricing_claims");
  if (c && cv !== null && cv !== "") c.value = cv;
  if (cl && clv !== null && clv !== "") cl.value = clv;
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
      document.getElementById("pricing-label-commission").textContent = c.value;
      pricingSaveSliderPrefs();
      pricingUpdateAll();
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
  var net1 = PRICING_RETAIL_1YR - PRICING_RETAIL_1YR * (comm / 100);
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
  var net1 = PRICING_RETAIL_1YR - PRICING_RETAIL_1YR * (commPct / 100);
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
  var oneTimeComm = PRICING_RETAIL_1YR * (comm / 100);
  var wpMargin1 = PRICING_RETAIL_1YR - oneTimeComm - annualCost;
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
  pricingFillContractLines("pricing-c1-lines", PRICING_RETAIL_1YR, 12, 1);
  pricingFillContractLines("pricing-c2-lines", PRICING_RETAIL_2YR, 24, 2);
  pricingFillContractLines("pricing-c3-lines", PRICING_RETAIL_3YR, 36, 3);
  pricingUpdateBreakevenNote(baseline, comm);
  pricingDestroyProfitChart();
  pricingRenderProfitChart();
}

function pricingInitOnTab() {
  if (!pricingTabInitialized) {
    pricingTabInitialized = true;
    pricingBindControlsOnce();
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
    var c2 = document.getElementById("pricing-slider-commission");
    var cl2 = document.getElementById("pricing-slider-claims");
    if (c2 && document.getElementById("pricing-label-commission")) document.getElementById("pricing-label-commission").textContent = c2.value;
    if (cl2 && document.getElementById("pricing-label-claims")) document.getElementById("pricing-label-claims").textContent = cl2.value;
    pricingUpdateAll();
  }
}

function applyAdminTabVisibility() {
  document.querySelectorAll('[data-tab="ticket"], [data-tab="history"], [data-tab="contact"]').forEach(function(el) {
    el.style.display = "none";
  });
  var pr = document.querySelector('[data-tab="pricing"]');
  if (pr) pr.style.display = "block";
}

function resetAdminTabVisibility() {
  document.querySelectorAll('[data-tab="ticket"], [data-tab="history"], [data-tab="contact"]').forEach(function(el) {
    el.style.display = "";
  });
  var pr = document.querySelector('[data-tab="pricing"]');
  if (pr) pr.style.display = "none";
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
            body: JSON.stringify({ resolved: true })
          });
          if (!patch.ok) throw new Error();
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

document.addEventListener("DOMContentLoaded", function() {

  // LOGIN
  document.getElementById("login-btn").addEventListener("click", function() { doLogin(); });
  document.getElementById("username").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });
  document.getElementById("password").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });

  async function doLogin() {
    var user = document.getElementById("username").value.trim().toLowerCase();
    var pass = document.getElementById("password").value;
    var err = document.getElementById("login-err");
    try {
      var url = SUPABASE_URL + "/rest/v1/dealers?username=eq." + encodeURIComponent(user) + "&password=eq." + encodeURIComponent(pass) + "&active=eq.true&select=*";
      var response = await fetch(url, { headers: supabaseHeaders() });
      var dealers = await response.json();
      if (!response.ok) throw new Error();
      if (dealers && dealers.length > 0) {
        var dealer = dealers[0];
        currentDealer = {
          id: dealer.id,
          username: dealer.username,
          name: dealer.dealership_name,
          isAdmin: dealer.is_admin === true
        };
        document.getElementById("dealer-display").textContent = dealer.dealership_name;
        document.getElementById("login-screen").style.display = "none";
        document.getElementById("portal-screen").style.display = "block";
        err.style.display = "none";
        loadDashboard();
        if (currentDealer.isAdmin) {
          applyAdminTabVisibility();
          var tabs = document.getElementById("portal-tabs");
          var claimsTab = document.createElement("div");
          claimsTab.className = "tab admin-tab";
          claimsTab.setAttribute("data-tab", "claims");
          claimsTab.textContent = "Claims";
          tabs.appendChild(claimsTab);
          claimsTab.addEventListener("click", function() { switchTab("claims"); });
          var adminTab = document.createElement("div");
          adminTab.className = "tab admin-tab";
          adminTab.setAttribute("data-tab", "admin");
          adminTab.textContent = "Admin";
          tabs.appendChild(adminTab);
          adminTab.addEventListener("click", function() { switchTab("admin"); });
        }
      } else {
        err.style.display = "block";
      }
    } catch (e) {
      err.style.display = "block";
    }
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });
    document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.remove("active"); });
    var activeTab = document.querySelector("[data-tab='" + name + "']");
    if (activeTab) activeTab.classList.add("active");
    var panel = document.getElementById("panel-" + name);
    if (panel) panel.classList.add("active");
    if (name === "dashboard") loadDashboard();
    if (name === "history") loadTickets();
    if (name === "customers") loadCustomersTab();
    if (name === "pricing") pricingInitOnTab();
    if (name === "claims") claimsLoadTab();
    if (name === "admin") adminLoadNetworkDashboard();
  }

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
    var billableFiltered = filtered.filter(ticketBillable);
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
    var earnings = billableFiltered.length * 150;
    if (earnHint) {
      earnHint.textContent =
        "~$150 avg per ticket (approved + pending) · " + (dashboardPeriod === "year" ? "this calendar year" : "all time");
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
    } catch (e) {
      allTickets = [];
      dealerContractCount = 0;
      renewalContractsDealer = [];
      renderTierUI();
      updateDashboardStats();
      renewalsEl.innerHTML = "<div class='renewals-empty'>Could not load data. Please try again.</div>";
    }
  }

  document.getElementById("logout-btn").addEventListener("click", function() {
    currentDealer = null;
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("portal-screen").style.display = "none";
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";
    document.querySelectorAll(".admin-tab").forEach(function(t) { t.remove(); });
    resetAdminTabVisibility();
    pricingTabInitialized = false;
    pricingDestroyProfitChart();
  });

  document.querySelectorAll(".tab:not(.admin-tab)").forEach(function(tab) {
    tab.addEventListener("click", function() { switchTab(tab.getAttribute("data-tab")); });
  });

  document.querySelectorAll("#dashboard-period-toggle .period-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      document.querySelectorAll("#dashboard-period-toggle .period-btn").forEach(function(b) { b.classList.remove("active"); });
      btn.classList.add("active");
      dashboardPeriod = btn.getAttribute("data-period") || "year";
      updateDashboardStats();
    });
  });

  document.getElementById("qa-ticket").addEventListener("click", function() { switchTab("ticket"); });
  document.getElementById("qa-enroll").addEventListener("click", function() { switchTab("enroll"); });

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
    var herr = document.getElementById("e-hin-err");
    if (herr) {
      herr.style.display = "none";
      herr.textContent = "";
    }
    document.getElementById("e-err").style.display = "none";
    document.getElementById("enroll-link-box").style.display = "none";
    switchTab("enroll");
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
    if (e.target && e.target.classList.contains("btn-reenroll")) switchTab("enroll");
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
    var fn = document.getElementById("t-fname").value;
    var ln = document.getElementById("t-lname").value;
    var hinEl = document.getElementById("t-hin");
    var el = document.getElementById("t-contract-status");
    if (!el || !hinEl) return;
    var hin = normalizeHin(hinEl.value);
    if (!hin) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = "<span class='contract-verify-loading'>Checking contract…</span>";
    try {
      var r = await verifyCustomerContract(fn, ln, hin, currentDealer ? currentDealer.name : "");
      if (r.valid) {
        el.innerHTML =
          "<span class='contract-verify-ok'>🟢 Active contract found — " + escHtml(r.displayName || "") + "</span>";
      } else if (r.ui === "warn") {
        el.innerHTML = "<span class='contract-verify-warn'>🟡 Contract expired — please re-enroll</span>";
      } else {
        var msg = r.message || "";
        if (
          msg.indexOf("No active contract") !== -1 ||
          msg.indexOf("enroll") !== -1 ||
          msg.indexOf("Enroll") !== -1
        ) {
          el.innerHTML = "<span class='contract-verify-err'>🔴 No active contract — enrollment required</span>";
        } else {
          el.innerHTML = "<span class='contract-verify-err'>🔴 " + escHtml(msg) + "</span>";
        }
      }
    } catch (e) {
      el.innerHTML = "<span class='contract-verify-err'>Could not verify. Please try again.</span>";
    }
  }

  (function bindTicketHinVerification() {
    var h = document.getElementById("t-hin");
    if (h) {
      h.addEventListener("input", function() {
        h.value = normalizeHin(h.value);
      });
    }
    ["t-hin", "t-fname", "t-lname"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("blur", updateTicketContractIndicator);
    });
  })();

  (function bindEnrollHinUppercase() {
    var h = document.getElementById("e-hin");
    if (h) {
      h.addEventListener("input", function() {
        h.value = normalizeHin(h.value);
        var herr = document.getElementById("e-hin-err");
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
    var cv = await verifyCustomerContract(fname, lname, hinVal, currentDealer.name);
    if (!cv.valid) {
      document.getElementById("t-err").textContent = cv.message || "Cannot submit ticket.";
      document.getElementById("t-err").style.display = "block";
      document.getElementById("t-ok").style.display = "none";
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
    var hinErrEl = document.getElementById("e-hin-err");
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
    var hv = await verifyHIN(hinVal, fname, lname, currentDealer.name);
    if (!hv.allowed) {
      if (hinErrEl) {
        hinErrEl.textContent = hv.message || "Enrollment not allowed.";
        hinErrEl.style.display = "block";
      }
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

  async function adminLoadNetworkDashboard() {
    if (!currentDealer || !currentDealer.isAdmin) return;
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
      adminRenderStats();
      adminRenderChart();
      adminRenderLeaderboard();
      adminRenderFlags();
      adminRenderRenewalsNetwork();
      adminRenderFinancialHealth();
      renderDealerTable();
      renderAdminMasterTable();
      loadAdminHinConflicts();
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
      adminRenderStats();
      adminRenderChart();
      adminRenderLeaderboard();
      adminRenderFlags();
      adminRenderRenewalsNetwork();
      adminRenderFinancialHealth();
      renderDealerTable();
      renderAdminMasterTable();
      loadAdminHinConflicts();
    }
  }

  // ADMIN — ADD DEALER
  document.getElementById("add-dealer-btn").addEventListener("click", async function() {
    var username = document.getElementById("new-username").value.trim().toLowerCase();
    var password = document.getElementById("new-password").value.trim();
    var name = document.getElementById("new-name").value.trim();
    var addOk = document.getElementById("add-ok");
    var addErr = document.getElementById("add-err");
    if (!username || !password || !name) { addErr.style.display = "block"; addOk.style.display = "none"; return; }
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/dealers", {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          username: username,
          password: password,
          dealership_name: name,
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
      addErr.textContent = "Could not add dealer. Check fields and try again.";
      addErr.style.display = "block"; addOk.style.display = "none";
    }
  });

});