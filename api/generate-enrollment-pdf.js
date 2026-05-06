const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function escapeHtml(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(n) {
  if (n === null || n === undefined || n === "") return "—";
  var num = Number(n);
  if (isNaN(num)) return escapeHtml(n);
  return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return escapeHtml(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch (_e) {
    return escapeHtml(iso);
  }
}

function termLabel(type) {
  if (type === "2yr") return "2-Year (24 months)";
  if (type === "3yr") return "3-Year (36 months)";
  return "1-Year (12 months)";
}

function buildEnrollmentHtml(c, dealer, contractId) {
  var d = dealer || {};
  var agreement = c.agreement_number || String(contractId || "").slice(0, 8);
  var docDate = formatDate(c.start_date || c.created_at);
  var rows = function(label, val) {
    return (
      '<div class="row"><span class="label">' + escapeHtml(label) + '</span><span class="value">' + val + "</span></div>"
    );
  };

  return (
    "<!DOCTYPE html>" +
    '<html lang="en">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Whitestone Partners — Enrollment — " + escapeHtml(agreement) + "</title>" +
    "<style>" +
    "* { box-sizing: border-box; }" +
    "body { font-family: 'Georgia', 'Times New Roman', serif; color: #0c1e2e; max-width: 8.5in; margin: 0 auto; padding: 24px; line-height: 1.45; background: #fff; }" +
    "h1 { font-size: 1.35rem; font-weight: 400; letter-spacing: 0.06em; text-transform: uppercase; color: #0c1e2e; border-bottom: 3px solid #b8963e; padding-bottom: 8px; margin: 0 0 4px 0; }" +
    ".subtitle { font-size: 0.8rem; color: #6b8599; margin: 0 0 20px 0; font-family: system-ui, sans-serif; }" +
    ".meta-bar { display: flex; flex-wrap: wrap; gap: 16px 32px; font-size: 0.9rem; margin-bottom: 20px; font-family: system-ui, sans-serif; }" +
    ".meta-bar strong { color: #4a6278; font-weight: 600; }" +
    "section { margin-bottom: 18px; page-break-inside: avoid; }" +
    "h2 { font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: #b8963e; margin: 0 0 10px 0; font-family: system-ui, sans-serif; font-weight: 700; }" +
    ".card { border: 1px solid #c5d5e0; border-radius: 6px; padding: 14px 16px; background: #fafbfc; }" +
    ".row { display: grid; grid-template-columns: minmax(140px, 32%) 1fr; gap: 8px 16px; font-size: 0.88rem; padding: 6px 0; border-bottom: 1px solid #e8eef3; font-family: system-ui, sans-serif; }" +
    ".row:last-child { border-bottom: none; }" +
    ".label { color: #6b8599; }" +
    ".value { color: #0c1e2e; font-weight: 500; word-break: break-word; }" +
    ".print-hint { margin-top: 24px; padding: 12px; background: #f5f0e6; border: 1px solid #e0d4bc; border-radius: 6px; font-size: 0.8rem; color: #5c4a2e; font-family: system-ui, sans-serif; }" +
    "@media print {" +
    "  body { padding: 0; max-width: none; }" +
    "  .no-print { display: none !important; }" +
    "  .card { background: #fff; border-color: #ccc; }" +
    "  @page { margin: 0.5in; size: letter; }" +
    "}" +
    "</style>" +
    "</head><body>" +
    "<h1>New Client Enrollment Form</h1>" +
    '<p class="subtitle">Whitestone Partners · Printable enrollment record</p>' +
    '<div class="meta-bar">' +
    "<div><strong>Agreement #</strong> " + escapeHtml(c.agreement_number || "—") + "</div>" +
    "<div><strong>Enrollment date</strong> " + docDate + "</div>" +
    "<div><strong>Contract ID</strong> " + escapeHtml(contractId || "—") + "</div>" +
    "</div>" +

    "<section><h2>Plan holder</h2><div class=\"card\">" +
    rows("First name", escapeHtml(c.customer_first_name)) +
    rows("Last name", escapeHtml(c.customer_last_name)) +
    rows("Middle initial", escapeHtml(c.customer_middle_initial)) +
    rows("Mailing address", escapeHtml(c.customer_address)) +
    rows("City", escapeHtml(c.customer_city)) +
    rows("State", escapeHtml(c.customer_state)) +
    rows("ZIP", escapeHtml(c.customer_zip)) +
    rows("Email", escapeHtml(c.customer_email)) +
    rows("Phone", escapeHtml(c.customer_phone)) +
    "</div></section>" +

    "<section><h2>Lienholder (if applicable)</h2><div class=\"card\">" +
    rows("Name", escapeHtml(c.lienholder_name)) +
    rows("Address", escapeHtml(c.lienholder_address)) +
    rows("City", escapeHtml(c.lienholder_city)) +
    rows("State", escapeHtml(c.lienholder_state)) +
    rows("ZIP", escapeHtml(c.lienholder_zip)) +
    rows("Phone", escapeHtml(c.lienholder_phone)) +
    "</div></section>" +

    "<section><h2>Dealership</h2><div class=\"card\">" +
    rows("Dealership name", escapeHtml(d.dealership_name || c.dealership_name)) +
    rows("Dealer number", escapeHtml(d.dealer_number)) +
    rows("Dealer ID (record)", escapeHtml(c.dealer_id)) +
    "</div></section>" +

    "<section><h2>Vessel</h2><div class=\"card\">" +
    rows("Hull ID (HIN)", escapeHtml(c.hin)) +
    rows("Year", escapeHtml(c.boat_year)) +
    rows("Make", escapeHtml(c.boat_make)) +
    rows("Model", escapeHtml(c.boat_model)) +
    rows("Condition", escapeHtml(c.vessel_condition)) +
    "</div></section>" +

    "<section><h2>Engine 1</h2><div class=\"card\">" +
    rows("Serial #", escapeHtml(c.engine1_serial)) +
    rows("Year", escapeHtml(c.engine1_year)) +
    rows("Make", escapeHtml(c.engine1_make)) +
    rows("Model", escapeHtml(c.engine1_model)) +
    rows("Hours", escapeHtml(c.engine1_hours)) +
    "</div></section>" +

    (c.dual_engine
      ? "<section><h2>Engine 2</h2><div class=\"card\">" +
        rows("Serial #", escapeHtml(c.engine2_serial)) +
        rows("Year", escapeHtml(c.engine2_year)) +
        rows("Make", escapeHtml(c.engine2_make)) +
        rows("Model", escapeHtml(c.engine2_model)) +
        rows("Hours", escapeHtml(c.engine2_hours)) +
        "</div></section>"
      : "<section><h2>Engine 2</h2><div class=\"card\"><div class=\"row\"><span class=\"label\">Dual engine</span><span class=\"value\">No</span></div></div></section>") +

    "<section><h2>Contract &amp; coverage</h2><div class=\"card\">" +
    rows("Term", escapeHtml(termLabel(c.contract_type))) +
    rows("Retail price", formatMoney(c.retail_price)) +
    rows("Wholesale price", formatMoney(c.wholesale_price)) +
    rows("Start date", formatDate(c.start_date)) +
    rows("End date", formatDate(c.end_date)) +
    rows("Status", escapeHtml(c.status)) +
    rows("Payment method", escapeHtml(c.payment_method)) +
    rows("Paid at", formatDate(c.paid_at)) +
    rows("Stripe payment ID", escapeHtml(c.stripe_payment_id)) +
    rows("Stripe charge amount", formatMoney(c.stripe_charge_amount)) +
    "</div></section>" +

    "<section><h2>Record</h2><div class=\"card\">" +
    rows("Contract ID", escapeHtml(c.id)) +
    rows("Created", formatDate(c.created_at)) +
    rows("Updated", formatDate(c.updated_at)) +
    "</div></section>" +

    '<p class="print-hint no-print">Use your browser’s <strong>Print</strong> dialog and choose <strong>Save as PDF</strong> to store a PDF copy for your records.</p>' +
    "</body></html>"
  );
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid body" });
  }

  var contractId = body.contractId;
  if (!contractId) {
    return res.status(400).json({ error: "contractId required" });
  }

  var result = await supabase
    .from("contracts")
    .select("*, dealers(dealership_name, dealer_number)")
    .eq("id", contractId)
    .single();

  var contract = result.data;
  var error = result.error;

  if (error || !contract) {
    return res.status(404).json({ error: "Contract not found" });
  }

  var dealer = contract.dealers;
  if (dealer && Array.isArray(dealer)) dealer = dealer[0];
  var html = buildEnrollmentHtml(contract, dealer, contractId);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'inline; filename="WP_Enrollment_' + (contract.agreement_number || String(contractId).slice(0, 8)) + '.html"'
  );
  res.status(200).send(html);
}

module.exports = handler;
