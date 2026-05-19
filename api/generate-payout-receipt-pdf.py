"""
POST /api/generate-payout-receipt-pdf

Generates a one-page payout receipt PDF for a dealer batch payment,
uploads it to Supabase Storage (payout-receipts bucket), updates the
batch row with the storage path, and returns the PDF bytes to the client.

Auth: JWT required, admin-only.
Body: { "payoutBatchId": "<uuid>" }
"""

import os
import json
import io
import re
from http.server import BaseHTTPRequestHandler
from urllib import parse as urllib_parse
from urllib import request as urlrequest
from urllib.error import HTTPError


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def _supabase_get(path, token):
    """GET against Supabase REST with the given token as both apikey and Authorization."""
    req = urlrequest.Request(
        SUPABASE_URL + path,
        headers={
            "apikey": token,
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
        },
        method="GET",
    )
    with urlrequest.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _supabase_patch(path, body, token):
    """PATCH against Supabase REST."""
    req = urlrequest.Request(
        SUPABASE_URL + path,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "apikey": token,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="PATCH",
    )
    with urlrequest.urlopen(req, timeout=10) as resp:
        return resp.status


def _supabase_storage_upload(bucket, path, content_bytes, content_type, token):
    """Upload bytes to Supabase Storage. Uses POST for create, falls back to PUT for overwrite."""
    encoded_path = "/".join(urllib_parse.quote(seg, safe="") for seg in path.split("/"))
    url = SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + encoded_path
    req = urlrequest.Request(
        url,
        data=content_bytes,
        headers={
            "apikey": token,
            "Authorization": "Bearer " + token,
            "Content-Type": content_type,
            "x-upsert": "true",
        },
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=15) as resp:
        return resp.status


def _verify_caller_is_admin(jwt_token):
    """Verify the JWT and confirm the caller is an admin. Returns dealer row dict or raises."""
    req = urlrequest.Request(
        SUPABASE_URL + "/auth/v1/user",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + jwt_token},
    )
    with urlrequest.urlopen(req, timeout=10) as resp:
        user_data = json.loads(resp.read().decode("utf-8"))
    auth_uid = user_data.get("id")
    if not auth_uid:
        raise ValueError("Invalid JWT")

    service_key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
    q_auth = urllib_parse.quote(str(auth_uid), safe="")
    rows = _supabase_get(
        "/rest/v1/dealers?auth_id=eq." + q_auth + "&select=id,is_admin,active,dealership_name",
        service_key,
    )
    if not rows or len(rows) == 0:
        raise PermissionError("Caller has no dealer record")
    caller = rows[0]
    if not caller.get("active"):
        raise PermissionError("Caller account is inactive")
    if not caller.get("is_admin"):
        raise PermissionError("Admin access required")
    return caller


def _fetch_batch_data(batch_id, service_key):
    """Fetch the batch row + linked reimbursements + linked tickets."""
    q_batch = urllib_parse.quote(str(batch_id), safe="")
    batches = _supabase_get(
        "/rest/v1/payout_batches?id=eq." + q_batch + "&select=*&limit=1",
        service_key,
    )
    if not batches:
        raise ValueError("Batch not found")
    batch = batches[0]

    reimbursements = _supabase_get(
        "/rest/v1/reimbursements?payout_batch_id=eq." + q_batch + "&select=id,ticket_id,amount,dealership_name",
        service_key,
    )

    ticket_ids = [r["ticket_id"] for r in reimbursements if r.get("ticket_id")]
    tickets = []
    if ticket_ids:
        in_list = ",".join(urllib_parse.quote(str(tid), safe="") for tid in ticket_ids)
        tickets = _supabase_get(
            "/rest/v1/tickets?id=in.(" + in_list + ")&select=id,ticket_number,customer_first_name,customer_last_name,boat_make,boat_model,boat_year,hin,service_type,service_date",
            service_key,
        )
    return batch, reimbursements, tickets


def _safe_filename_part(s):
    """Make a string safe for use in a filename."""
    s = re.sub(r"[^A-Za-z0-9]+", "", s or "")
    return s[:40] if s else "Dealer"


def _build_pdf(batch, reimbursements, tickets):
    """Generate the receipt PDF using ReportLab. Returns bytes."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
    from reportlab.lib.colors import HexColor

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter

    NAVY = HexColor("#0c1e2e")
    GOLD = HexColor("#b8963e")
    MID = HexColor("#6b8599")
    LIGHT_BG = HexColor("#f5f7fa")

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(0.5 * inch, height - 0.7 * inch, "WHITESTONE PARTNERS")
    c.setFont("Helvetica", 9)
    c.setFillColor(MID)
    c.drawString(0.5 * inch, height - 0.9 * inch, "Reimbursement Receipt")

    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 11)
    c.drawRightString(width - 0.5 * inch, height - 0.7 * inch, "RECEIPT")
    c.setFillColor(NAVY)
    c.setFont("Helvetica", 9)
    receipt_no = (batch.get("id") or "")[:8].upper()
    c.drawRightString(width - 0.5 * inch, height - 0.9 * inch, "#" + receipt_no)

    c.setStrokeColor(HexColor("#e0e6ed"))
    c.setLineWidth(0.5)
    c.line(0.5 * inch, height - 1.1 * inch, width - 0.5 * inch, height - 1.1 * inch)

    y = height - 1.4 * inch
    c.setFillColor(MID)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(0.5 * inch, y, "PAID TO")
    c.drawString(4.0 * inch, y, "PAYMENT DETAILS")
    y -= 0.18 * inch
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(0.5 * inch, y, batch.get("dealership_name") or "—")
    c.setFont("Helvetica", 10)
    c.drawString(4.0 * inch, y, "Reference: " + (batch.get("payment_reference") or "—"))
    y -= 0.18 * inch
    c.setFont("Helvetica", 9)
    paid_at = (batch.get("paid_at") or "")[:10]
    cycle = (batch.get("cycle_start") or "") + " to " + (batch.get("cycle_end") or "")
    c.drawString(4.0 * inch, y, "Paid on: " + paid_at)
    y -= 0.16 * inch
    c.drawString(4.0 * inch, y, "Cycle: " + cycle)
    y -= 0.16 * inch
    c.drawString(4.0 * inch, y, "Paid by: " + (batch.get("paid_by") or "admin"))

    y -= 0.4 * inch
    c.setFillColor(LIGHT_BG)
    c.rect(0.5 * inch, y - 0.3 * inch, width - 1.0 * inch, 0.55 * inch, fill=1, stroke=0)
    c.setFillColor(MID)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(0.7 * inch, y + 0.1 * inch, "TOTAL REIMBURSEMENT")
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 22)
    total = float(batch.get("total_amount") or 0)
    c.drawRightString(width - 0.7 * inch, y - 0.05 * inch, "${:,.2f}".format(total))
    c.setFillColor(MID)
    c.setFont("Helvetica", 9)
    c.drawRightString(width - 0.7 * inch, y + 0.13 * inch, "{} tickets".format(batch.get("ticket_count") or 0))

    y -= 0.7 * inch
    c.setFillColor(MID)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(0.5 * inch, y, "INCLUDED TICKETS")
    y -= 0.22 * inch

    c.setFillColor(LIGHT_BG)
    c.rect(0.5 * inch, y - 0.05 * inch, width - 1.0 * inch, 0.22 * inch, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(0.55 * inch, y + 0.05 * inch, "TICKET #")
    c.drawString(1.5 * inch, y + 0.05 * inch, "CUSTOMER")
    c.drawString(3.0 * inch, y + 0.05 * inch, "VESSEL")
    c.drawString(4.5 * inch, y + 0.05 * inch, "SERVICE")
    c.drawString(6.5 * inch, y + 0.05 * inch, "DATE")
    c.drawRightString(width - 0.55 * inch, y + 0.05 * inch, "AMOUNT")
    y -= 0.22 * inch

    ticket_map = {t["id"]: t for t in tickets}

    c.setFont("Helvetica", 8)
    c.setFillColor(NAVY)
    for r in reimbursements:
        t = ticket_map.get(r.get("ticket_id"), {})
        ticket_num = t.get("ticket_number") or "—"
        customer = ((t.get("customer_first_name") or "") + " " + (t.get("customer_last_name") or "")).strip() or "—"
        vessel = " ".join(filter(None, [t.get("boat_make"), t.get("boat_model"), str(t.get("boat_year") or "")])).strip() or "—"
        service = (t.get("service_type") or "—")[:24]
        service_date = (t.get("service_date") or "—")[:10]
        amount = float(r.get("amount") or 0)
        c.drawString(0.55 * inch, y, ticket_num[:14])
        c.drawString(1.5 * inch, y, customer[:20])
        c.drawString(3.0 * inch, y, vessel[:22])
        c.drawString(4.5 * inch, y, service[:28])
        c.drawString(6.5 * inch, y, service_date)
        c.drawRightString(width - 0.55 * inch, y, "${:,.2f}".format(amount))
        y -= 0.18 * inch
        if y < 1.0 * inch:
            c.showPage()
            y = height - 0.7 * inch
            c.setFont("Helvetica", 8)
            c.setFillColor(NAVY)

    c.setFillColor(MID)
    c.setFont("Helvetica", 7)
    c.drawString(0.5 * inch, 0.5 * inch, "Whitestone Partners LLC · St. George, UT · support@whitestone-partners.com")
    c.drawRightString(width - 0.5 * inch, 0.5 * inch, "This receipt confirms reimbursement payment to the dealer for approved service tickets.")

    c.save()
    buf.seek(0)
    return buf.read()


class handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def do_POST(self):
        try:
            auth_header = self.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return self._json(401, {"error": "Missing Authorization header"})
            jwt_token = auth_header[len("Bearer "):]
            try:
                _verify_caller_is_admin(jwt_token)
            except PermissionError as e:
                return self._json(403, {"error": str(e)})
            except Exception:
                return self._json(401, {"error": "JWT verification failed"})

            content_length = int(self.headers.get("Content-Length", 0))
            body_raw = self.rfile.read(content_length) if content_length else b""
            try:
                body = json.loads(body_raw) if body_raw else {}
            except Exception:
                return self._json(400, {"error": "Invalid JSON body"})
            batch_id = body.get("payoutBatchId") or body.get("batchId")
            if not batch_id:
                return self._json(400, {"error": "payoutBatchId required"})

            service_key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
            try:
                batch, reimbursements, tickets = _fetch_batch_data(batch_id, service_key)
            except ValueError as e:
                return self._json(404, {"error": str(e)})

            pdf_bytes = _build_pdf(batch, reimbursements, tickets)

            dealer_safe = _safe_filename_part(batch.get("dealership_name"))
            paid_date = (batch.get("paid_at") or "")[:10] or "undated"
            amount_int = int(round(float(batch.get("total_amount") or 0)))
            storage_filename = "{}_{}_${}.pdf".format(dealer_safe, paid_date, amount_int)
            try:
                _supabase_storage_upload(
                    "payout-receipts",
                    storage_filename,
                    pdf_bytes,
                    "application/pdf",
                    service_key,
                )
            except HTTPError as e:
                err_body = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else str(e)
                return self._json(500, {"error": "Storage upload failed: " + err_body[:300]})

            try:
                _supabase_patch(
                    "/rest/v1/payout_batches?id=eq." + urllib_parse.quote(str(batch_id), safe=""),
                    {"receipt_storage_path": storage_filename},
                    service_key,
                )
            except Exception:
                pass

            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", 'attachment; filename="' + storage_filename + '"')
            self.send_header("X-Receipt-Storage-Path", storage_filename)
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except Exception as e:
            return self._json(500, {"error": "Internal error: " + str(e)[:300]})
