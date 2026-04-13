var SHEETS_URL = "PASTE_YOUR_APPS_SCRIPT_URL_HERE";
var FORMSPREE_CONTACT = "https://formspree.io/f/mvzvzkqa";
var currentDealer = null;
var allTickets = [];
var adminNetworkTickets = [];
var adminChartInstance = null;
var dashboardPeriod = "year";
var earningsAnimRaf = null;

var ADMIN_CONTRACT_AVG = 3699;
var ADMIN_AVG_REIMB = 150;
var ADMIN_COMMISSION_RATE = 0.2;

// Default dealers — stored in localStorage so admin changes persist
var DEFAULT_DEALERS = {
  "dealer1":  { password: "password1",   name: "Lake City Marine",         active: true },
  "dealer2":  { password: "password2",   name: "Desert Marine Group",       active: true },
  "dealer3":  { password: "password3",   name: "Placeholder Dealer 3",      active: true },
  "dealer4":  { password: "password4",   name: "Placeholder Dealer 4",      active: true },
  "dealer5":  { password: "password5",   name: "Placeholder Dealer 5",      active: true },
  "dealer6":  { password: "password6",   name: "Placeholder Dealer 6",      active: true },
  "dealer7":  { password: "password7",   name: "Placeholder Dealer 7",      active: true },
  "dealer8":  { password: "password8",   name: "Placeholder Dealer 8",      active: true },
  "dealer9":  { password: "password9",   name: "Placeholder Dealer 9",      active: true },
  "dealer10": { password: "password10",  name: "Placeholder Dealer 10",     active: true },
  "admin":    { password: "whitestone2026", name: "Whitestone Partners",     active: true, isAdmin: true }
};

function getDealers() {
  try {
    var stored = localStorage.getItem("wsp_dealers");
    return stored ? JSON.parse(stored) : DEFAULT_DEALERS;
  } catch(e) { return DEFAULT_DEALERS; }
}

function saveDealers(dealers) {
  try { localStorage.setItem("wsp_dealers", JSON.stringify(dealers)); } catch(e) {}
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function parseTicketDate(t) {
  var raw = String(t.serviceDate || t.date || t.submittedAt || "").trim();
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

function adminFetchAllTicketsFallback() {
  var dealers = getDealers();
  var names = Object.keys(dealers).filter(function(u) {
    return u !== "admin" && dealers[u].active;
  }).map(function(u) { return dealers[u].name; });
  if (names.length === 0) return Promise.resolve([]);
  var promises = names.map(function(name) {
    return fetch(SHEETS_URL + "?action=getTickets&dealer=" + encodeURIComponent(name))
      .then(function(r) { return r.json(); })
      .then(function(res) { return (res && res.success && res.tickets) ? res.tickets : []; })
      .catch(function() { return []; });
  });
  return Promise.all(promises).then(function(arrays) {
    var merged = [];
    arrays.forEach(function(a) { merged = merged.concat(a); });
    return merged;
  });
}

function adminFetchAllTickets() {
  return fetch(SHEETS_URL + "?action=getTickets&dealer=ALL")
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res && res.success && Array.isArray(res.tickets)) return res.tickets;
      return adminFetchAllTicketsFallback();
    })
    .catch(function() { return adminFetchAllTicketsFallback(); });
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

function adminRenderStats() {
  var tk = adminNetworkTickets;
  var totalT = tk.length;
  var contracts = totalT > 0 ? Math.ceil(totalT / 3) : 0;
  var revenue = contracts * ADMIN_CONTRACT_AVG;
  var reimb = totalT * ADMIN_AVG_REIMB;
  var commission = contracts * (ADMIN_CONTRACT_AVG * ADMIN_COMMISSION_RATE);
  var margin = revenue - reimb - commission;
  var elC = document.getElementById("admin-stat-contracts");
  var elR = document.getElementById("admin-stat-revenue");
  var elB = document.getElementById("admin-stat-reimb");
  var elM = document.getElementById("admin-stat-margin");
  if (elC) elC.textContent = contracts.toLocaleString();
  if (elR) elR.textContent = "$" + Math.round(revenue).toLocaleString();
  if (elB) elB.textContent = "$" + Math.round(reimb).toLocaleString();
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
  var dealers = getDealers();
  var rows = [];
  Object.keys(dealers).forEach(function(username) {
    if (username === "admin") return;
    var d = dealers[username];
    if (!d.active) return;
    var tk = adminTicketsForDealer(d.name);
    var count = tk.length;
    var lastDate = null;
    tk.forEach(function(t) {
      var dt = parseTicketDate(t);
      if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
    });
    var lastStr = lastDate ? lastDate.toLocaleDateString() : "—";
    var estCont = count > 0 ? Math.ceil(count / 3) : 0;
    var estReimb = count * ADMIN_AVG_REIMB;
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
      name: d.name,
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
  var dealers = getDealers();
  var follow = [];
  var good = [];
  Object.keys(dealers).forEach(function(username) {
    if (username === "admin") return;
    var d = dealers[username];
    if (!d.active) return;
    var tk = adminTicketsForDealer(d.name);
    var last30 = tk.filter(adminIsInLast30Days).length;
    if (last30 === 0) follow.push(d.name);
    var thisMo = tk.filter(adminIsThisMonth).length;
    if (thisMo >= 3) good.push(d.name);
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
  var byKey = {};
  adminNetworkTickets.forEach(function(t) {
    var k = adminNetworkCustomerKey(t);
    if (!k) return;
    var d = parseTicketDate(t);
    if (!d) return;
    if (!byKey[k] || d < byKey[k].enroll) byKey[k] = { enroll: d, t: t };
  });
  var rows = [];
  Object.keys(byKey).forEach(function(k) {
    var info = byKey[k];
    var days = daysUntilNextAnniversary(info.enroll);
    if (days < 0 || days > 90) return;
    var t = info.t;
    var name = ((t.firstName || "") + " " + (t.lastName || "")).trim() || "Customer";
    var dealership = (t.dealership || "—").trim();
    var badgeClass = days <= 30 ? "urgent" : days <= 60 ? "soon" : "upcoming";
    rows.push({ name: name, dealership: dealership, days: days, badgeClass: badgeClass });
  });
  rows.sort(function(a, b) { return a.days - b.days; });
  var el = document.getElementById("admin-renewals-body");
  if (!el) return;
  if (rows.length === 0) {
    el.innerHTML = "<div class='renewals-empty'>No renewals due in the next 90 days.</div>";
    return;
  }
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
  var last30 = tk.filter(adminIsInLast30Days).length;
  var projected = last30 * ADMIN_AVG_REIMB;
  if (projEl) projEl.textContent = "$" + Math.round(projected).toLocaleString() + " / mo est. (last 30-day pace)";
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

  // Initialize dealers if not set
  if (!localStorage.getItem("wsp_dealers")) {
    saveDealers(DEFAULT_DEALERS);
  }

  // LOGIN
  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("username").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });
  document.getElementById("password").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin(); });

  function doLogin() {
    var user = document.getElementById("username").value.trim().toLowerCase();
    var pass = document.getElementById("password").value;
    var dealers = getDealers();
    var err = document.getElementById("login-err");
    if (dealers[user] && dealers[user].password === pass && dealers[user].active) {
      currentDealer = { username: user, name: dealers[user].name, isAdmin: dealers[user].isAdmin || false };
      document.getElementById("dealer-display").textContent = dealers[user].name;
      document.getElementById("login-screen").style.display = "none";
      document.getElementById("portal-screen").style.display = "block";
      err.style.display = "none";
      loadDashboard();
      // Add admin tab if admin
      if (currentDealer.isAdmin) {
        var tabs = document.getElementById("portal-tabs");
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
    ticketsInPeriod.forEach(function(t) {
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
    if (stCust) stCust.textContent = String(contractsAllTime);
    var earnings = ticketCount * 150;
    if (earnHint) earnHint.textContent = "$150 avg. per ticket · " + (dashboardPeriod === "year" ? "this calendar year" : "all time");
    animateEarningsTo(earnings, earnEl);
    renderSparkline(filtered);
  }

  function renderTierUI() {
    var contracts = countUniqueCustomers(allTickets);
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
    var byKey = {};
    allTickets.forEach(function(t) {
      var k = customerKey(t);
      if (!k) return;
      var d = parseTicketDate(t);
      if (!d) return;
      if (!byKey[k] || d < byKey[k].enroll) byKey[k] = { enroll: d, t: t };
    });
    var rows = [];
    Object.keys(byKey).forEach(function(k) {
      var info = byKey[k];
      var days = daysUntilNextAnniversary(info.enroll);
      if (days < 0 || days > 90) return;
      var t = info.t;
      var name = ((t.firstName || "") + " " + (t.lastName || "")).trim() || "Customer";
      var boatParts = [t.boatMake, t.boatModel].filter(function(x) { return String(x || "").trim(); });
      var boat = boatParts.length ? boatParts.join(" ") : "—";
      var badgeClass = days <= 30 ? "urgent" : days <= 60 ? "soon" : "upcoming";
      rows.push({ name: name, boat: boat, days: days, badgeClass: badgeClass });
    });
    rows.sort(function(a, b) { return a.days - b.days; });
    if (rows.length === 0) {
      el.innerHTML = "<div class='renewals-empty'>No renewals due in the next 90 days — you're all caught up.</div>";
      return;
    }
    var html = "";
    rows.forEach(function(r) {
      html += "<div class='renewal-row'><div class='renewal-main'><div class='renewal-name'>" + escHtml(r.name) + "</div>";
      html += "<div class='renewal-boat'>" + escHtml(r.boat) + "</div></div><div class='renewal-meta'>";
      html += "<span class='renewal-badge " + r.badgeClass + "'>" + r.days + " days until renewal</span>";
      html += "<button type='button' class='btn-reenroll'>Re-enroll</button></div></div>";
    });
    el.innerHTML = html;
  }

  function loadDashboard() {
    var renewalsEl = document.getElementById("renewals-container");
    if (!currentDealer || !renewalsEl) return;
    renewalsEl.innerHTML = "<div class='renewals-loading'>Loading renewal dates…</div>";
    var dealerName = encodeURIComponent(currentDealer.name);
    fetch(SHEETS_URL + "?action=getTickets&dealer=" + dealerName)
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.success || !res.tickets) allTickets = [];
        else allTickets = res.tickets;
        renderTierUI();
        updateDashboardStats();
        renderRenewalsUI();
      })
      .catch(function() {
        allTickets = [];
        renderTierUI();
        updateDashboardStats();
        renderRenewalsUI();
      });
  }

  document.getElementById("logout-btn").addEventListener("click", function() {
    currentDealer = null;
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("portal-screen").style.display = "none";
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";
    // Remove admin tab if present
    var adminTab = document.querySelector(".admin-tab");
    if (adminTab) adminTab.remove();
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

  // SERVICE TICKET
  document.getElementById("ticket-btn").addEventListener("click", function() {
    var fname = document.getElementById("t-fname").value;
    var lname = document.getElementById("t-lname").value;
    if (!fname || !lname) { alert("Please enter the customer name."); return; }
    var btn = document.getElementById("ticket-btn");
    btn.disabled = true; btn.textContent = "Submitting...";
    var sels = document.querySelectorAll(".tb.sel");
    var services = Array.from(sels).map(function(b) { return b.textContent.trim(); }).join(", ");
    fetch(SHEETS_URL, {
      method: "POST",
      body: JSON.stringify({
        serviceType: services || "General Service",
        dealership: currentDealer ? currentDealer.name : "",
        technician: document.getElementById("t-tech").value,
        firstName: fname, lastName: lname,
        email: document.getElementById("t-email").value,
        phone: document.getElementById("t-phone").value,
        boatMake: document.getElementById("t-make").value,
        boatModel: document.getElementById("t-model").value,
        year: document.getElementById("t-year").value,
        hin: document.getElementById("t-hin").value,
        engineHours: document.getElementById("t-hours").value,
        serviceDate: document.getElementById("t-date").value,
        serviceNotes: document.getElementById("t-notes").value
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        document.getElementById("t-num").textContent = res.ticket;
        document.getElementById("t-ok").style.display = "block";
        document.getElementById("t-err").style.display = "none";
        document.getElementById("t-ok").scrollIntoView({ behavior: "smooth", block: "center" });
        loadDashboard();
        btn.disabled = false; btn.textContent = "Submit Service Ticket";
      } else {
        document.getElementById("t-err").style.display = "block";
        btn.disabled = false; btn.textContent = "Submit Service Ticket";
      }
    })
    .catch(function() {
      document.getElementById("t-err").style.display = "block";
      btn.disabled = false; btn.textContent = "Submit Service Ticket";
    });
  });

  // ENROLL
  document.getElementById("enroll-btn").addEventListener("click", function() {
    var fname = document.getElementById("e-fname").value;
    var email = document.getElementById("e-email").value;
    if (!fname || !email) { document.getElementById("e-err").style.display = "block"; return; }
    document.getElementById("e-err").style.display = "none";
    document.getElementById("enroll-link-box").style.display = "block";
    document.getElementById("enroll-link-box").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // PAST TICKETS
  function loadTickets() {
    var container = document.getElementById("tickets-container");
    container.innerHTML = "<div class='tickets-loading'>Loading your tickets...</div>";
    var dealerName = currentDealer ? encodeURIComponent(currentDealer.name) : "";
    fetch(SHEETS_URL + "?action=getTickets&dealer=" + dealerName)
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.success || !res.tickets || res.tickets.length === 0) {
        container.innerHTML = "<div class='no-tickets'>No tickets submitted yet.</div>"; return;
      }
      var html = "";
      res.tickets.forEach(function(t) {
        var services = t.serviceType ? t.serviceType.split(",") : [];
        var pillsHtml = services.map(function(s) { return "<span class='service-pill'>" + s.trim() + "</span>"; }).join("");
        html += "<div class='ticket-card'><div class='ticket-header'><span class='ticket-id'>" + (t.ticketNum||"") + "</span><span class='ticket-date'>" + (t.date||"") + "</span></div>";
        if (pillsHtml) html += "<div class='ticket-services'>" + pillsHtml + "</div>";
        html += "<div class='ticket-grid'>";
        html += "<div class='ticket-field'><label>Customer</label><p>" + (t.firstName||"") + " " + (t.lastName||"") + "</p></div>";
        html += "<div class='ticket-field'><label>Email</label><p>" + (t.email||"—") + "</p></div>";
        html += "<div class='ticket-field'><label>Phone</label><p>" + (t.phone||"—") + "</p></div>";
        html += "<div class='ticket-field'><label>Boat</label><p>" + (t.boatMake||"") + " " + (t.boatModel||"") + " " + (t.year||"") + "</p></div>";
        html += "<div class='ticket-field'><label>HIN</label><p>" + (t.hin||"—") + "</p></div>";
        html += "<div class='ticket-field'><label>Engine Hours</label><p>" + (t.engineHours||"—") + "</p></div>";
        html += "<div class='ticket-field'><label>Technician</label><p>" + (t.technician||"—") + "</p></div>";
        html += "</div>";
        if (t.serviceNotes) html += "<div class='ticket-notes'><label>Notes</label><p>" + t.serviceNotes + "</p></div>";
        html += "</div>";
      });
      container.innerHTML = html;
    })
    .catch(function() { container.innerHTML = "<div class='no-tickets'>Could not load tickets. Please try again.</div>"; });
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
  function renderDealerTable() {
    var dealers = getDealers();
    var tbody = document.getElementById("dealer-tbody");
    tbody.innerHTML = "";
    Object.keys(dealers).forEach(function(username) {
      var d = dealers[username];
      var tr = document.createElement("tr");
      tr.innerHTML = "<td><strong>" + username + "</strong></td>" +
        "<td>" + d.name + "</td>" +
        "<td><span class='" + (d.active ? "badge-active" : "badge-inactive") + "'>" + (d.active ? "Active" : "Inactive") + "</span></td>" +
        "<td><button class='btn-sm btn-remove' data-user='" + username + "'" + (username === "admin" ? " disabled style='opacity:0.4;cursor:not-allowed;'" : "") + ">Remove</button></td>";
      tbody.appendChild(tr);
    });
    // Remove buttons
    document.querySelectorAll(".btn-remove").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var user = btn.getAttribute("data-user");
        if (user === "admin") return;
        if (!confirm("Remove dealer '" + user + "'? This cannot be undone.")) return;
        var dealers = getDealers();
        delete dealers[user];
        saveDealers(dealers);
        renderDealerTable();
        if (currentDealer && currentDealer.isAdmin) {
          var adminPanel = document.getElementById("panel-admin");
          if (adminPanel && adminPanel.classList.contains("active")) {
            adminRenderLeaderboard();
            adminRenderFlags();
          }
        }
      });
    });
  }

  function adminLoadNetworkDashboard() {
    if (!currentDealer || !currentDealer.isAdmin) return;
    var loading = document.getElementById("admin-dashboard-loading");
    var content = document.getElementById("admin-dashboard-content");
    if (loading) loading.style.display = "block";
    if (content) content.style.display = "none";
    adminFetchAllTickets().then(function(tickets) {
      adminNetworkTickets = tickets || [];
      if (loading) loading.style.display = "none";
      if (content) content.style.display = "block";
      adminRenderStats();
      adminRenderChart();
      adminRenderLeaderboard();
      adminRenderFlags();
      adminRenderRenewalsNetwork();
      adminRenderFinancialHealth();
      renderDealerTable();
    }).catch(function() {
      adminNetworkTickets = [];
      if (loading) loading.style.display = "none";
      if (content) content.style.display = "block";
      adminRenderStats();
      adminRenderChart();
      adminRenderLeaderboard();
      adminRenderFlags();
      adminRenderRenewalsNetwork();
      adminRenderFinancialHealth();
      renderDealerTable();
    });
  }

  // ADMIN — ADD DEALER
  document.getElementById("add-dealer-btn").addEventListener("click", function() {
    var username = document.getElementById("new-username").value.trim().toLowerCase();
    var password = document.getElementById("new-password").value.trim();
    var name = document.getElementById("new-name").value.trim();
    var addOk = document.getElementById("add-ok");
    var addErr = document.getElementById("add-err");
    if (!username || !password || !name) { addErr.style.display = "block"; addOk.style.display = "none"; return; }
    var dealers = getDealers();
    dealers[username] = { password: password, name: name, active: true };
    saveDealers(dealers);
    document.getElementById("new-username").value = "";
    document.getElementById("new-password").value = "";
    document.getElementById("new-name").value = "";
    addOk.style.display = "block"; addErr.style.display = "none";
    setTimeout(function() { addOk.style.display = "none"; }, 3000);
    renderDealerTable();
    if (currentDealer && currentDealer.isAdmin) {
      var adminPanel = document.getElementById("panel-admin");
      if (adminPanel && adminPanel.classList.contains("active")) {
        adminRenderLeaderboard();
        adminRenderFlags();
      }
    }
  });

});