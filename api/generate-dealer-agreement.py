from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.request
import urllib.parse


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))
        dealer_id = body.get('dealerId')

        if not dealer_id:
            self._json(400, {'error': 'dealerId required'})
            return

        supabase_url = os.environ.get('SUPABASE_URL', '')
        supabase_key = os.environ.get('SUPABASE_ANON_KEY', '')

        url = (supabase_url + '/rest/v1/dealers'
               + '?id=eq.' + urllib.parse.quote(dealer_id)
               + '&select=*&limit=1')

        req = urllib.request.Request(url, headers={
            'apikey': supabase_key,
            'Authorization': 'Bearer ' + supabase_key,
        })

        try:
            with urllib.request.urlopen(req) as resp:
                rows = json.loads(resp.read())
        except Exception as e:
            self._json(500, {'error': str(e)})
            return

        if not rows:
            self._json(404, {'error': 'Dealer not found'})
            return

        d = rows[0]

        try:
            pdf_bytes = self._fill_pdf(d)
        except Exception as e:
            self._json(500, {'error': 'PDF generation failed: ' + str(e)})
            return

        safe_name = str(d.get('dealership_name') or dealer_id[:8]).replace(' ', '_')
        filename = 'WP_DealerAgreement_' + safe_name + '.pdf'

        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Disposition', 'attachment; filename="' + filename + '"')
        self.send_header('Content-Length', str(len(pdf_bytes)))
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fill_pdf(self, d):
        # ALL third-party imports INSIDE this method — critical for Vercel
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io
        import json as _json

        template_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            'dealer-agreement-template.pdf'
        )

        if not os.path.exists(template_path):
            raise FileNotFoundError('Template not found: ' + template_path)

        packet = io.BytesIO()
        cv = canvas.Canvas(packet, pagesize=letter)
        w_page, h_page = letter  # 612 x 792

        def txt(text, x, y_from_top, font_size=8):
            if not text or str(text).strip() == '':
                return
            cv.setFont('Helvetica', font_size)
            cv.drawString(x, h_page - y_from_top, str(text))

        # Format effective date
        eff_date = (d.get('effective_date') or '')
        if eff_date and len(eff_date) >= 10:
            p = eff_date[:10].split('-')
            if len(p) == 3:
                eff_date = p[1] + '/' + p[2] + '/' + p[0]

        # ── DEALERSHIP INFORMATION ──────────────────────────────────
        txt(d.get('legal_business_name', ''),  162, 148.0, 8)
        txt(d.get('dba_name', ''),             462, 148.0, 8)
        txt(d.get('business_address', ''),     120, 165.0, 8)
        txt(d.get('business_city', ''),         40, 182.0, 8)
        txt(d.get('business_state', ''),       200, 182.0, 8)
        txt(d.get('business_zip', ''),         290, 182.0, 8)
        txt(d.get('business_phone', ''),       450, 182.0, 8)
        txt(d.get('ein', ''),                   40, 199.0, 8)
        txt(str(d.get('dealer_number') or ''), 310, 199.0, 8)
        txt(d.get('brands_carried', ''),        40, 216.0, 8)

        # ── AUTHORIZED CONTACTS ─────────────────────────────────────
        contacts = d.get('dealer_contacts') or []
        if isinstance(contacts, str):
            try:
                contacts = _json.loads(contacts)
            except Exception:
                contacts = []

        start_y      = 265.0
        row_h        = 14.0
        left_name_x  = 40
        left_pos_x   = 200
        right_name_x = 350
        right_pos_x  = 500

        for i, contact in enumerate(contacts[:10]):
            name = contact.get('name', '') if isinstance(contact, dict) else ''
            pos  = contact.get('position', '') if isinstance(contact, dict) else ''
            if i < 5:
                y = start_y + (i * row_h)
                txt(name, left_name_x,  y, 8)
                txt(pos,  left_pos_x,   y, 8)
            else:
                y = start_y + ((i - 5) * row_h)
                txt(name, right_name_x, y, 8)
                txt(pos,  right_pos_x,  y, 8)

        # ── ACCOUNTING INFORMATION ──────────────────────────────────
        txt(d.get('ar_contact', ''),       120, 370.0, 8)
        txt(d.get('ar_phone', ''),          40, 387.0, 8)
        txt(d.get('ar_email', ''),         310, 387.0, 8)
        txt(d.get('account_number', ''),    40, 404.0, 8)
        txt(d.get('routing_number', ''),   310, 404.0, 8)

        # ── AGREEMENT HEADER ────────────────────────────────────────
        txt(eff_date,                              210, 445.0, 8)
        txt(d.get('legal_business_name', ''),      350, 445.0, 8)

        cv.save()
        packet.seek(0)

        overlay  = PdfReader(packet)
        template = PdfReader(template_path)
        writer   = PdfWriter()

        page = template.pages[0]
        page.merge_page(overlay.pages[0])
        writer.add_page(page)

        for i in range(1, len(template.pages)):
            writer.add_page(template.pages[i])

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()
