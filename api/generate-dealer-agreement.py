from http.server import BaseHTTPRequestHandler
import io
import json
import os
import textwrap
import urllib.error
import urllib.parse
import urllib.request


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            self._json(400, {'error': 'Invalid JSON body'})
            return

        dealer_id = body.get('dealerId')
        if not dealer_id:
            self._json(400, {'error': 'dealerId required'})
            return

        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        supabase_key = os.environ.get('SUPABASE_ANON_KEY', '')
        if not supabase_url or not supabase_key:
            self._json(500, {'error': 'Server missing SUPABASE_URL or SUPABASE_ANON_KEY'})
            return

        url = (
            supabase_url + '/rest/v1/dealers?id=eq.' + urllib.parse.quote(str(dealer_id), safe='')
            + '&select=*&limit=1'
        )
        req = urllib.request.Request(url, headers={
            'apikey': supabase_key,
            'Authorization': 'Bearer ' + supabase_key,
        })

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                rows = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            self._json(502, {'error': 'Supabase error: ' + str(e.code)})
            return
        except Exception as e:
            self._json(500, {'error': str(e)})
            return

        if not rows:
            self._json(404, {'error': 'Dealer not found'})
            return

        d = rows[0]

        try:
            pdf_bytes = self._build_pdf(d)
        except Exception as e:
            self._json(500, {'error': 'PDF generation failed: ' + str(e)})
            return

        safe_name = ''.join(ch if ch.isalnum() else '_' for ch in str(d.get('dealership_name') or 'dealer'))[:40]
        filename = 'Whitestone_Dealer_Agreement_' + safe_name + '.pdf'

        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Disposition', 'attachment; filename="' + filename + '"')
        self.send_header('Content-Length', str(len(pdf_bytes)))
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def _json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _build_pdf(self, d):
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=letter)
        w, h = letter
        left = 48
        y = h - 52

        def draw_title():
            nonlocal y
            c.setFont('Helvetica-Bold', 16)
            c.drawString(left, y, 'Whitestone Partners — Dealer Enrollment Agreement')
            y -= 26
            c.setFont('Helvetica', 9)
            c.drawString(left, y, 'This document summarizes enrollment information on file. Banking details are for internal records only.')
            y -= 22

        def draw_section(title):
            nonlocal y
            if y < 100:
                c.showPage()
                y = h - 52
            c.setFont('Helvetica-Bold', 11)
            c.setFillColorRGB(0.45, 0.35, 0.12)
            c.drawString(left, y, title)
            y -= 16
            c.setFillColorRGB(0, 0, 0)
            c.setFont('Helvetica', 10)

        def draw_kv(label, value, wrap=92):
            nonlocal y
            val = '' if value is None else str(value)
            lines = [label + ':'] + textwrap.wrap(val, width=wrap) if val else [label + ':', '—']
            for line in lines:
                if y < 56:
                    c.showPage()
                    y = h - 52
                    c.setFont('Helvetica', 10)
                c.drawString(left, y, line)
                y -= 13

        draw_title()

        eff = d.get('effective_date') or ''
        if isinstance(eff, str) and len(eff) >= 10:
            eff = eff[:10]
        draw_section('Agreement')
        draw_kv('Effective date', eff)
        draw_kv('Dealer number', d.get('dealer_number'))
        draw_kv('Portal dealership name', d.get('dealership_name'))

        draw_section('Section 1 — Dealership information')
        draw_kv('Legal business name', d.get('legal_business_name'))
        draw_kv('DBA', d.get('dba_name'))
        draw_kv('Business address', d.get('business_address'))
        city_line = ' '.join(filter(None, [
            d.get('business_city'),
            d.get('business_state'),
            d.get('business_zip'),
        ]))
        draw_kv('City / State / Zip', city_line)
        draw_kv('Business phone', d.get('business_phone'))
        draw_kv('EIN', d.get('ein'))
        draw_kv('Brands carried', d.get('brands_carried'))

        draw_section('Section 2 — Authorized contacts')
        contacts = d.get('dealer_contacts') or []
        if isinstance(contacts, str):
            try:
                contacts = json.loads(contacts)
            except Exception:
                contacts = []
        if not isinstance(contacts, list) or len(contacts) == 0:
            draw_kv('Contacts', '(none on file)')
        else:
            for i, row in enumerate(contacts, start=1):
                if not isinstance(row, dict):
                    continue
                name = row.get('name') or ''
                pos = row.get('position') or ''
                draw_kv('Contact ' + str(i), (name + (' — ' + pos if pos else '')).strip() or '—')

        draw_section('Section 3 — Accounting (internal)')
        draw_kv('AR contact', d.get('ar_contact'))
        draw_kv('AR phone', d.get('ar_phone'))
        draw_kv('AR email', d.get('ar_email'))
        draw_kv('Account number', d.get('account_number'))
        draw_kv('Routing number', d.get('routing_number'))

        draw_section('Acknowledgment')
        draw_kv(
            'Confirmation',
            'The submitting Whitestone administrator confirmed this information at generation time.',
        )

        c.save()
        summary_bytes = buf.getvalue()

        template_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            'dealer-agreement-template.pdf',
        )
        if not os.path.exists(template_path):
            return summary_bytes

        from pypdf import PdfReader, PdfWriter

        writer = PdfWriter()
        summary_reader = PdfReader(io.BytesIO(summary_bytes))
        for page in summary_reader.pages:
            writer.add_page(page)
        template_reader = PdfReader(template_path)
        for page in template_reader.pages:
            writer.add_page(page)
        merged = io.BytesIO()
        writer.write(merged)
        return merged.getvalue()
