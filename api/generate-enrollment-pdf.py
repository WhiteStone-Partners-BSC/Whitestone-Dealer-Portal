from http.server import BaseHTTPRequestHandler
import glob
import json
import os
import urllib.request
import urllib.parse

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        # Read body
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))
        contract_id = body.get('contractId')

        if not contract_id:
            self._json(400, {'error': 'contractId required'})
            return

        # Fetch contract from Supabase
        supabase_url = os.environ.get('SUPABASE_URL', '')
        supabase_key = os.environ.get('SUPABASE_ANON_KEY', '')

        url = (supabase_url + '/rest/v1/contracts'
               + '?id=eq.' + urllib.parse.quote(contract_id)
               + '&select=*,dealers(dealership_name,dealer_number)'
               + '&limit=1')

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
            self._json(404, {'error': 'Contract not found'})
            return

        c = rows[0]
        dealer = c.get('dealers') or {}
        if isinstance(dealer, list):
            dealer = dealer[0] if dealer else {}

        template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'enrollment-form-template.pdf')

        if not template_path or not os.path.exists(template_path):
            self._json(500, {'error': 'Template not found at: ' + str(template_path)})
            return

        # Generate filled PDF
        try:
            pdf_bytes = self._fill_pdf(c, dealer, template_path)
        except Exception as e:
            self._json(500, {'error': 'PDF generation failed: ' + str(e)})
            return

        # Return PDF
        filename = 'WP_Enrollment_' + str(c.get('agreement_number', contract_id[:8])) + '.pdf'
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

    def _fill_pdf(self, c, dealer, template_path=None):
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        template_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            'enrollment-form-template.pdf'
        )
        if not os.path.exists(template_path):
            raise FileNotFoundError('Template not found: ' + template_path)

        packet = io.BytesIO()
        cv = canvas.Canvas(packet, pagesize=letter)
        w_page, h_page = letter  # 612 x 792

        def txt(text, x, y_from_top, font_size=8):
            """Draw text. y_from_top measured from top of page."""
            if not text or str(text).strip() == '':
                return
            cv.setFont('Helvetica', font_size)
            cv.drawString(x, h_page - y_from_top, str(text))

        # Format date from ISO to MM/DD/YYYY
        agreement_date = (c.get('start_date') or '')[:10]
        if agreement_date:
            p = agreement_date.split('-')
            if len(p) == 3:
                agreement_date = p[1] + '/' + p[2] + '/' + p[0]

        # ── HEADER ─────────────────────────────────────────────────────
        txt(c.get('agreement_number', ''), 68, 94.0,  8)
        txt(agreement_date,                68, 117.0, 8)

        # ── PLAN HOLDER ────────────────────────────────────────────────
        txt(c.get('customer_first_name', ''),     62,  148.0, 8)
        txt(c.get('customer_last_name', ''),      312, 148.0, 8)
        txt(c.get('customer_middle_initial', ''), 528, 148.0, 8)
        # Address/Email start AFTER their label text ends
        txt(c.get('customer_address', ''),        76,  165.0, 8)
        txt(c.get('customer_email', ''),          357, 165.0, 8)
        txt(c.get('customer_city', ''),           40,  182.0, 8)
        txt(c.get('customer_state', ''),          204, 182.0, 8)
        txt(c.get('customer_zip', ''),            278, 182.0, 8)
        txt(c.get('customer_phone', ''),          427, 182.0, 8)

        # ── LIENHOLDER ─────────────────────────────────────────────────
        if c.get('lienholder_name'):
            txt(c.get('lienholder_name', ''),    76,  209.0, 8)
            txt(c.get('lienholder_address', ''), 76,  226.0, 8)
            txt(c.get('lienholder_city', ''),    40,  243.0, 8)
            txt(c.get('lienholder_state', ''),   204, 243.0, 8)
            txt(c.get('lienholder_zip', ''),     278, 243.0, 8)
            txt(c.get('lienholder_phone', ''),   427, 243.0, 8)

        # ── DEALERSHIP ─────────────────────────────────────────────────
        dealer_name = (dealer or {}).get('dealership_name') or c.get('dealership_name', '')
        txt(dealer_name, 104, 269.0, 8)

        # ── VESSEL ─────────────────────────────────────────────────────
        txt(c.get('hin', ''),                          40,  329.0, 8)
        txt(str(c.get('boat_year', '') or ''),         204, 329.0, 8)
        txt(c.get('boat_make', ''),                    287, 329.0, 8)
        txt(c.get('boat_model', ''),                   413, 329.0, 8)
        # NEW/Used checkboxes (exact rectangle positions measured from form)
        # NEW box:  x0=529.7 x1=534.7 top=329.7 bottom=334.7
        # Used box: x0=570.7 x1=576.2 top=329.3 bottom=334.8
        condition = c.get('vessel_condition', 'New')
        if condition == 'Used':
            txt('X', 571, 335.0, 7)
        else:
            txt('X', 530, 335.0, 7)

        # ── ENGINE 1 ───────────────────────────────────────────────────
        txt(str(c.get('engine1_serial', '') or ''), 75,  347.0, 8)
        txt(str(c.get('engine1_year', '') or ''),   204, 347.0, 8)
        txt(str(c.get('engine1_make', '') or ''),   287, 347.0, 8)
        txt(str(c.get('engine1_model', '') or ''),  413, 347.0, 8)
        txt(str(c.get('engine1_hours', '') or ''),  561, 347.0, 8)

        # ── ENGINE 2 ───────────────────────────────────────────────────
        if c.get('dual_engine') and c.get('engine2_serial'):
            txt(str(c.get('engine2_serial', '') or ''), 75,  364.0, 8)
            txt(str(c.get('engine2_year', '') or ''),   204, 364.0, 8)
            txt(str(c.get('engine2_make', '') or ''),   287, 364.0, 8)
            txt(str(c.get('engine2_model', '') or ''),  413, 364.0, 8)
            txt(str(c.get('engine2_hours', '') or ''),  561, 364.0, 8)

        # ── TERM CHECKBOXES ────────────────────────────────────────────
        # Exact checkbox rectangle positions:
        # 12 MONTH: x0=159.2 x1=164.7 top=407.2 bottom=412.7
        # 24 MONTH: x0=303.3 x1=308.8 top=407.2 bottom=412.7
        # 36 MONTH: x0=447.4 x1=452.9 top=407.2 bottom=412.7
        term = c.get('contract_type', '1yr')
        if term == '1yr':
            txt('X', 160, 413.0, 7)
        elif term == '2yr':
            txt('X', 304, 413.0, 7)
        elif term == '3yr':
            txt('X', 448, 413.0, 7)

        # ── PURCHASE PRICE & DATE ──────────────────────────────────────
        # Start AFTER label text ends:
        # PRICE label x1=164.4 → data at 166
        # DATE label x1=451.1 → data at 453
        price_map = {'1yr': '$3,325.00', '2yr': '$6,650.00', '3yr': '$9,975.00'}
        txt(price_map.get(term, ''), 166, 430.0, 8)
        txt(agreement_date,          453, 430.0, 8)

        cv.save()
        packet.seek(0)

        # Merge overlay onto template
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
