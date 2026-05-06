from http.server import BaseHTTPRequestHandler
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

        # Generate filled PDF
        try:
            pdf_bytes = self._fill_pdf(c, dealer)
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

    def _fill_pdf(self, c, dealer):
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        # Load template
        template_path = '/var/task/public/enrollment-form-template.pdf'
        template_path = os.path.abspath(template_path)

        # Build overlay with text annotations
        packet = io.BytesIO()
        c_canvas = canvas.Canvas(packet, pagesize=letter)
        w, h = letter  # 612 x 792

        def txt(text, x, y, size=9):
            if text and str(text).strip():
                c_canvas.setFont('Helvetica', size)
                c_canvas.drawString(x, h - y - size, str(text))

        # Agreement number and date
        txt(c.get('agreement_number', ''), 68, 90)
        agreement_date = (c.get('start_date') or '')[:10]
        if agreement_date:
            parts = agreement_date.split('-')
            if len(parts) == 3:
                agreement_date = parts[1] + '/' + parts[2] + '/' + parts[0]
        txt(agreement_date, 72, 115)

        # Plan holder
        txt(c.get('customer_first_name', ''),  62,  145)
        txt(c.get('customer_last_name', ''),   312, 145)
        txt(c.get('customer_middle_initial', ''), 526, 145)
        txt(c.get('customer_address', ''),     72,  163)
        txt(c.get('customer_email', ''),       352, 163)
        txt(c.get('customer_city', ''),        42,  180)
        txt(c.get('customer_state', ''),       206, 180)
        txt(c.get('customer_zip', ''),         287, 180)
        txt(c.get('customer_phone', ''),       427, 180)

        # Lienholder
        if c.get('lienholder_name'):
            txt(c.get('lienholder_name', ''),    62,  206)
            txt(c.get('lienholder_address', ''), 72,  223)
            txt(c.get('lienholder_city', ''),    42,  240)
            txt(c.get('lienholder_state', ''),   206, 240)
            txt(c.get('lienholder_zip', ''),     287, 240)
            txt(c.get('lienholder_phone', ''),   427, 240)

        # Dealership
        dealer_name = dealer.get('dealership_name') or c.get('dealership_name', '')
        txt(dealer_name, 92, 266)

        # Vessel
        txt(c.get('hin', ''),        37,  326)
        txt(c.get('boat_year', ''),  206, 326)
        txt(c.get('boat_make', ''),  292, 326)
        txt(c.get('boat_model', ''), 422, 326)

        # New/Used checkbox
        condition = c.get('vessel_condition', 'New')
        if condition == 'Used':
            txt('X', 571, 323)
        else:
            txt('X', 530, 323)

        # Engine 1
        txt(c.get('engine1_serial', ''), 82,  344)
        txt(c.get('engine1_year', ''),   206, 344)
        txt(c.get('engine1_make', ''),   292, 344)
        txt(c.get('engine1_model', ''),  422, 344)
        txt(c.get('engine1_hours', ''),  562, 344)

        # Engine 2
        if c.get('dual_engine') and c.get('engine2_serial'):
            txt(c.get('engine2_serial', ''), 82,  361)
            txt(c.get('engine2_year', ''),   206, 361)
            txt(c.get('engine2_make', ''),   292, 361)
            txt(c.get('engine2_model', ''),  422, 361)
            txt(c.get('engine2_hours', ''),  562, 361)

        # Term checkboxes
        term = c.get('contract_type', '1yr')
        if term == '1yr': txt('X', 144, 408, 11)
        elif term == '2yr': txt('X', 289, 408, 11)
        elif term == '3yr': txt('X', 433, 408, 11)

        # Purchase price and date
        price_map = {'1yr': '$3,325.00', '2yr': '$6,650.00', '3yr': '$9,975.00'}
        txt(price_map.get(term, ''), 147, 430)
        txt(agreement_date, 457, 430)

        c_canvas.save()
        packet.seek(0)

        # Merge overlay onto template
        overlay = PdfReader(packet)
        template = PdfReader(template_path)
        writer = PdfWriter()

        # First page — merge overlay
        page = template.pages[0]
        page.merge_page(overlay.pages[0])
        writer.add_page(page)

        # Remaining pages — add as-is
        for i in range(1, len(template.pages)):
            writer.add_page(template.pages[i])

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()
