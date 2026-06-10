# api/generate-dealer-agreement-pdf.py
# Fills api/dealer-agreement-template.pdf with dealer row data (Supabase REST).
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

    def _verify_caller_owns_dealer(self, jwt_token, target_dealer_id):
        """
        Returns (allowed: bool, status_code: int, error: str|None).
        - allowed=True: caller is authenticated AND owns the dealer record (or is admin)
        - allowed=False: 401 if no/bad JWT, 403 if ownership check fails
        """
        if not jwt_token:
            return False, 401, 'Missing Authorization header'

        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        anon_key = os.environ.get('SUPABASE_ANON_KEY', '')
        if not supabase_url or not anon_key:
            return False, 500, 'Server misconfigured (missing SUPABASE env)'

        # Step 1: Verify JWT against Supabase auth endpoint
        try:
            verify_req = urllib_request.Request(
                f"{supabase_url}/auth/v1/user",
                headers={'Authorization': f'Bearer {jwt_token}', 'apikey': anon_key},
            )
            with urllib_request.urlopen(verify_req, timeout=10) as r:
                auth_user = json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            if e.code == 401:
                return False, 401, 'Invalid or expired token'
            return False, 401, f'Token verification failed (HTTP {e.code})'
        except Exception as e:
            return False, 401, f'Token verification failed: {e}'

        auth_uid = auth_user.get('id')
        if not auth_uid:
            return False, 401, 'No user id in token'

        # Step 2: Look up the caller's dealer row keyed by auth_id
        service_key = os.environ.get('SUPABASE_SERVICE_KEY') or anon_key
        q_auth = urllib_parse.quote(str(auth_uid), safe='')
        try:
            dealer_lookup = urllib_request.Request(
                f"{supabase_url}/rest/v1/dealers?auth_id=eq.{q_auth}&select=id,is_admin,active",
                headers={'apikey': service_key, 'Authorization': f'Bearer {service_key}'},
            )
            with urllib_request.urlopen(dealer_lookup, timeout=10) as r:
                rows = json.loads(r.read().decode('utf-8'))
        except Exception as e:
            return False, 401, f'Could not look up dealer: {e}'

        if not rows:
            return False, 403, 'No dealer record for this user'
        caller_dealer = rows[0]
        if not caller_dealer.get('active'):
            return False, 403, 'Dealer account is inactive'

        # Step 3: Admin can access ANY dealer agreement
        if caller_dealer.get('is_admin'):
            return True, 200, None

        # Step 4: Non-admin can only access THEIR OWN dealer agreement
        if str(target_dealer_id) == str(caller_dealer.get('id')):
            return True, 200, None

        return False, 403, 'You do not have access to this dealer agreement'

    def _fill_pdf(self, d):
        # Imports INSIDE the method — Vercel cold-start pattern
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dealer-agreement-template.pdf')
        if not os.path.exists(template_path):
            alt = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dealer-enrollment-template.pdf')
            if os.path.exists(alt):
                template_path = alt
        if not os.path.exists(template_path):
            raise FileNotFoundError('Template not found: dealer-agreement-template.pdf (or fallback dealer-enrollment-template.pdf)')

        reader = PdfReader(template_path)
        if len(reader.pages) < 1:
            raise ValueError('Template must have at least 1 page; got ' + str(len(reader.pages)))

        # ---------- PAGE 1 OVERLAY (ReportLab canvas) ----------
        buf1 = io.BytesIO()
        c = canvas.Canvas(buf1, pagesize=letter)
        c.setFont('Helvetica', 9)

        def put(x, y_top, text, font_size=9):
            if text is None or text == '':
                return
            c.setFont('Helvetica', font_size)
            c.drawString(x, 792 - y_top, str(text))

        # Coordinates mapped to FINAL dealer template (612x792), page 1.
        # put(x, y_top) — y_top from page top; values on label baselines.

        # --- SECTION: DEALERSHIP INFORMATION ---
        legal = d.get('legal_business_name') or d.get('dealership_name') or ''
        dba = d.get('dba_name') or d.get('dba') or ''
        addr = d.get('business_address') or d.get('address') or ''
        city = d.get('business_city') or d.get('city') or ''
        state = d.get('business_state') or d.get('state') or ''
        zipc = d.get('business_zip') or d.get('zip') or ''
        phone = d.get('business_phone') or d.get('phone') or ''
        ein = d.get('ein') or ''
        dealer_num = d.get('dealer_number') or ''
        brands = d.get('brands_carried') or d.get('boat_brands') or ''

        put(95, 181, legal)
        if dba:
            put(327, 181, dba)
        put(86, 198, addr)
        put(41, 215, city)
        put(211, 215, state)
        put(284, 215, zipc)
        put(418, 215, phone)
        put(37, 232, ein)
        put(365, 232, dealer_num)
        put(79, 249, brands)

        # --- AUTHORIZED DEALERSHIP CONTACTS (skip when empty) ---
        contacts = d.get('authorized_contacts') or d.get('dealer_contacts') or []
        if isinstance(contacts, str):
            try:
                contacts = json.loads(contacts)
            except Exception:
                contacts = []
        if not isinstance(contacts, list):
            contacts = []

        row_y = [293, 310, 328, 345, 363]
        for i in range(5):
            if i < len(contacts) and isinstance(contacts[i], dict):
                c_ = contacts[i]
                put(45, row_y[i], c_.get('name'))
                put(197, row_y[i], c_.get('position'))
        for i in range(5, 10):
            if i < len(contacts) and isinstance(contacts[i], dict):
                c_ = contacts[i]
                put(333, row_y[i - 5], c_.get('name'))
                put(485, row_y[i - 5], c_.get('position'))

        # --- ACCOUNTING INFORMATION (populated columns only) ---
        ar_name = d.get('ar_contact_name') or ''
        ar_phone = d.get('ar_phone') or ''
        ar_email = d.get('ar_email') or ''
        acct = d.get('bank_account_number') or ''
        rout = d.get('bank_routing_number') or ''

        put(127, 387, ar_name)
        put(75, 404, ar_phone)
        put(333, 404, ar_email)
        put(82, 421, acct)
        put(369, 421, rout)

        # --- DEALER PRINCIPAL / AUTHORIZED SIGNATORY ---
        primary = ((d.get('contact_first_name') or '') + ' ' + (d.get('contact_last_name') or '')).strip()
        principal_title = d.get('contact_title') or ''
        principal_email = d.get('email') or ''
        principal_phone = phone

        put(45, 446, primary)
        put(188, 446, principal_title)
        put(334, 446, principal_email, 6)
        put(480, 446, principal_phone)

        # --- PARTICIPATION AGREEMENT (effective date + dealer name blanks) ---
        eff_raw = d.get('effective_date') or d.get('enrollment_effective_date') or ''
        eff = str(eff_raw)[:10] if eff_raw else ''
        if eff and len(eff) == 10 and eff[4] == '-':
            parts = eff.split('-')
            eff = parts[1] + '/' + parts[2] + '/' + parts[0]
        put(203, 622, eff, 8)
        put(25, 628, legal, 8)

        c.save()
        buf1.seek(0)

        overlay = PdfReader(buf1)
        if len(overlay.pages) < 1:
            raise RuntimeError('Overlay PDF did not generate')

        writer = PdfWriter()
        p1 = reader.pages[0]
        p1.merge_page(overlay.pages[0])
        writer.add_page(p1)
        for i in range(1, len(reader.pages)):
            writer.add_page(reader.pages[i])

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

            auth_header = self.headers.get('Authorization') or self.headers.get('authorization') or ''
            jwt_token = auth_header.replace('Bearer ', '').replace('bearer ', '').strip()

            allowed, code, err = self._verify_caller_owns_dealer(jwt_token, dealer_id)
            if not allowed:
                self._send_json(code, {'error': err})
                return

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

Coordinates in _fill_pdf mapped to dealer-agreement-template.pdf (612 x 792 pt, 3 pages).
Y values passed to put() are measured from the TOP of the page; ReportLab uses bottom-left,
so the helper converts with canvas_y = 792 - y_top.

Page 1 only receives text overlay; pages 2-3 pass through unchanged.
DocuSign signature tabs anchor on page 3 'DEALER:' (see send-dealer-agreement-docusign.js).

After first real PDF generation, open the output and confirm each value sits on its underline.
If the template file is replaced, re-run calibration (e.g. pdfplumber) and update put() calls.
"""
