const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { contractId } = req.body || {};
  if (!contractId) return res.status(400).json({ error: "contractId required" });

  const { data: contract, error } = await supabase
    .from("contracts")
    .select("*, dealers(dealership_name, dealer_number)")
    .eq("id", contractId)
    .single();

  if (error || !contract) return res.status(404).json({ error: "Contract not found" });

  const templatePath = path.join(process.cwd(), "public", "enrollment-form-template.pdf");
  if (!fs.existsSync(templatePath)) {
    return res.status(500).json({ error: "PDF template missing at public/enrollment-form-template.pdf" });
  }
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 9;
  const { height } = page.getSize();

  function drawText(text, x, topY) {
    if (!text || text.toString().trim() === "") return;
    page.drawText(text.toString(), {
      x: x,
      y: height - topY - fontSize,
      size: fontSize,
      font: font,
      color: rgb(0, 0, 0)
    });
  }

  const c = contract;
  const d = contract.dealers || {};

  const priceMap = { "1yr": "$3,325.00", "2yr": "$6,650.00", "3yr": "$9,975.00" };
  const today = new Date();
  const dateStr = (c.start_date || today.toISOString().split("T")[0])
    .split("-").reverse().join("/").replace(/^(\d+)\/(\d+)\/(\d+)$/, "$2/$1/$3");

  drawText(c.agreement_number || "", 68, 90);
  drawText(dateStr, 72, 115);

  drawText(c.customer_first_name || "", 62, 145);
  drawText(c.customer_last_name || "", 312, 145);
  drawText(c.customer_middle_initial || "", 526, 145);
  drawText(c.customer_address || "", 72, 163);
  drawText(c.customer_email || "", 352, 163);
  drawText(c.customer_city || "", 42, 180);
  drawText(c.customer_state || "", 206, 180);
  drawText(c.customer_zip || "", 287, 180);
  drawText(c.customer_phone || "", 427, 180);

  if (c.lienholder_name) {
    drawText(c.lienholder_name || "", 62, 206);
    drawText(c.lienholder_address || "", 72, 223);
    drawText(c.lienholder_city || "", 42, 240);
    drawText(c.lienholder_state || "", 206, 240);
    drawText(c.lienholder_zip || "", 287, 240);
    drawText(c.lienholder_phone || "", 427, 240);
  }

  drawText(d.dealership_name || c.dealership_name || "", 92, 266);

  drawText(c.hin || "", 37, 326);
  drawText(c.boat_year || "", 206, 326);
  drawText(c.boat_make || "", 292, 326);
  drawText(c.boat_model || "", 422, 326);

  if (c.vessel_condition === "Used") {
    drawText("X", 571, 323);
  } else {
    drawText("X", 530, 323);
  }

  drawText(c.engine1_serial || "", 82, 344);
  drawText(c.engine1_year ? c.engine1_year.toString() : "", 206, 344);
  drawText(c.engine1_make || "", 292, 344);
  drawText(c.engine1_model || "", 422, 344);
  drawText(c.engine1_hours ? c.engine1_hours.toString() : "", 562, 344);

  if (c.dual_engine && c.engine2_serial) {
    drawText(c.engine2_serial || "", 82, 361);
    drawText(c.engine2_year ? c.engine2_year.toString() : "", 206, 361);
    drawText(c.engine2_make || "", 292, 361);
    drawText(c.engine2_model || "", 422, 361);
    drawText(c.engine2_hours ? c.engine2_hours.toString() : "", 562, 361);
  }

  const term = c.contract_type || "1yr";
  if (term === "1yr") drawText("X", 144, 408);
  if (term === "2yr") drawText("X", 289, 408);
  if (term === "3yr") drawText("X", 433, 408);

  drawText(priceMap[term] || "", 147, 430);
  drawText(dateStr, 457, 430);

  const pdfBytes = await pdfDoc.save();
  const filename = "WP_Enrollment_" + (c.agreement_number || String(contractId).substring(0, 8)) + ".pdf";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
  res.setHeader("Content-Length", pdfBytes.length);
  res.send(Buffer.from(pdfBytes));
}

module.exports = handler;
