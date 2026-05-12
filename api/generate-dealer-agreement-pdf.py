# api/generate-dealer-agreement-pdf.py
# Fills api/dealer-enrollment-template.pdf with dealer row data (Supabase REST).
import json
import os
from http.server import BaseHTTPRequestHandler
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


class handler(BaseHTTPRequestHandler):

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode('utf-8'))

    def _fetch_dealer(self, dealer_id):
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_ANON_KEY', '')
        if not url or not key:
            raise RuntimeError('Supabase env vars missing')

        qid = urllib_parse.quote(str(dealer_id), safe='')
        req = urllib_request.Request(
            f"{url.rstrip('/')}/rest/v1/dealers?id=eq.{qid}&select=*&limit=1",
            headers={'apikey': key, 'Authorization': f'Bearer {key}'},
        )
        with urllib_request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode('utf-8'))
        if not data:
            raise ValueError(f'Dealer not found: {dealer_id}')
        return data[0]

    def _fill_pdf(self, d):
        # Imports INSIDE the method — Vercel cold-start pattern
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dealer-enrollment-template.pdf')
        if not os.path.exists(template_path):
            alt = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dealer-agreement-template.pdf')
            if os.path.exists(alt):
                template_path = alt
        if not os.path.exists(template_path):
            raise FileNotFoundError('Template not found: dealer-enrollment-template.pdf (or fallback dealer-agreement-template.pdf)')

        reader = PdfReader(template_path)
        if len(reader.pages) < 2:
            raise ValueError('Template must have at least 2 pages; got ' + str(len(reader.pages)))

        # ---------- PAGE 1–2 OVERLAY (single ReportLab canvas) ----------
        buf1 = io.BytesIO()
        c = canvas.Canvas(buf1, pagesize=letter)
        c.setFont('Helvetica', 9)

        def put(x, y_top, text):
            if text is None or text == '':
                return
            c.drawString(x, 792 - y_top, str(text))

        # --- SECTION: DEALERSHIP INFORMATION ---
        legal = d.get('legal_business_name') or d.get('dealership_name') or ''
        dba = d.get('dba') or d.get('dba_name') or ''
        addr = d.get('address') or d.get('business_address') or ''
        city = d.get('city') or d.get('business_city') or ''
        state = d.get('state') or d.get('business_state') or ''
        zipc = d.get('zip') or d.get('business_zip') or ''
        phone = d.get('phone') or d.get('business_phone') or ''
        ein = d.get('ein') or ''
        dealer_num = d.get('dealer_number') or ''
        brands = d.get('brands_carried') or d.get('boat_brands') or ''

        put(92, 185, legal)
        put(368, 185, dba)
        put(84, 202, addr)
        put(38, 219, city)
        put(208, 219, state)
        put(281, 219, zipc)
        put(421, 219, phone)
        put(34, 236, ein)
        put(363, 236, dealer_num)
        put(77, 253, brands)

        # --- AUTHORIZED DEALERSHIP CONTACTS ---
        contacts = d.get('authorized_contacts') or d.get('dealer_contacts') or []
        if isinstance(contacts, str):
            try:
                contacts = json.loads(contacts)
            except Exception:
                contacts = []
        if not isinstance(contacts, list):
            contacts = []

        row_y = [288.1, 305.6, 323.1, 340.6, 358.2]
        for i in range(5):
            if i < len(contacts) and isinstance(contacts[i], dict):
                c_ = contacts[i]
                put(42, row_y[i] + 9, c_.get('name'))
                put(262, row_y[i] + 9, c_.get('position'))
        for i in range(5, 10):
            if i < len(contacts) and isinstance(contacts[i], dict):
                c_ = contacts[i]
                put(330, row_y[i - 5] + 9, c_.get('name'))
                put(547, row_y[i - 5] + 9, c_.get('position'))

        # --- ACCOUNTING INFORMATION ---
        ar_name = d.get('ar_contact_name') or d.get('ar_contact') or ''
        ar_phone = d.get('ar_phone') or ''
        ar_email = d.get('ar_email') or ''
        acct = d.get('bank_account_number') or d.get('account_number') or ''
        rout = d.get('bank_routing_number') or d.get('routing_number') or ''

        put(128, 386, ar_name)
        put(72, 403, ar_phone)
        put(330, 403, ar_email)
        put(80, 420, acct)
        put(366, 420, rout)

        eff_raw = d.get('enrollment_effective_date') or d.get('effective_date') or ''
        eff = str(eff_raw)[:10] if eff_raw else ''
        put(208, 471, eff)
        put(20, 480, legal)

        c.showPage()

        # ---------- PAGE 2 OVERLAY ----------
        c.setFont('Helvetica', 9)
        put(244, 157, '10')

        primary = ((d.get('contact_first_name') or '') + ' ' + (d.get('contact_last_name') or '')).strip()
        put(76, 635, primary)

        c.save()
        buf1.seek(0)

        overlay = PdfReader(buf1)
        if len(overlay.pages) < 2:
            raise RuntimeError('Overlay PDF did not generate 2 pages')

        writer = PdfWriter()
        p1 = reader.pages[0]
        p1.merge_page(overlay.pages[0])
        writer.add_page(p1)
        p2 = reader.pages[1]
        p2.merge_page(overlay.pages[1])
        writer.add_page(p2)

        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length).decode('utf-8') or '{}'
            body = json.loads(raw)
            dealer_id = body.get('dealerId')
            if not dealer_id:
                self._send_json(400, {'error': 'dealerId required'})
                return

            dealer = self._fetch_dealer(dealer_id)
            pdf_bytes = self._fill_pdf(dealer)

            safe = ''.join(ch if ch.isalnum() else '_' for ch in (dealer.get('dealership_name') or 'Dealer'))
            import datetime
            date_str = datetime.date.today().isoformat()
            filename = f'WP_DealerAgreement_{safe}_{date_str}.pdf'

            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Content-Length', str(len(pdf_bytes)))
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except (HTTPError, URLError) as e:
            self._send_json(502, {'error': f'Supabase fetch failed: {e}'})
        except ValueError as e:
            self._send_json(404, {'error': str(e)})
        except FileNotFoundError as e:
            self._send_json(500, {'error': str(e)})
        except Exception as e:
            self._send_json(500, {'error': f'{type(e).__name__}: {e}'})


"""
CALIBRATION NOTES (Whitestone / Cursor)

Coordinates in _fill_pdf were taken from dealer-enrollment-template.pdf (612 x 792 pt, 2 pages).
Y values passed to put() are measured from the TOP of the page; ReportLab uses bottom-left,
so the helper converts with canvas_y = 792 - y_top.

After first real PDF generation, open the output and confirm each value sits on its underline.
- X drift: adjust the first argument to put(x, y_top, value).
- Y drift: adjust y_top (and the +9 row offset for contact rows). Larger y_top moves the
  baseline DOWN on the page.

If the template file is replaced, re-run calibration (e.g. pdfplumber) and update put() calls.
"""
