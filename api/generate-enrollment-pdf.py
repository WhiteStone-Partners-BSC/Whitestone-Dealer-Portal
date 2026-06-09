from http.server import BaseHTTPRequestHandler
import glob
import json
import os
import urllib.request
import urllib.parse
import urllib.error


class handler(BaseHTTPRequestHandler):

    def _fetch_dealer(self, dealer_id):
        if not dealer_id:
            return {}
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_ANON_KEY', '')
        qid = urllib.parse.quote(str(dealer_id), safe='')
        req = urllib.request.Request(
            f"{url}/rest/v1/dealers?id=eq.{qid}&select=dealership_name,address,city,state,zip,phone",
            headers={'apikey': key, 'Authorization': f'Bearer {key}'},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode('utf-8'))
            return data[0] if data else {}
        except Exception:
            return {}

    def _verify_caller_owns_contract(self, jwt_token, contract):
        """
        Returns a tuple (allowed: bool, status_code: int, error: str|None).
        - allowed=True: caller is authenticated AND owns the contract (or is admin)
        - allowed=False: 401 if no/bad JWT, 403 if owns-check fails
        """
        if not jwt_token:
            return False, 401, 'Missing Authorization header'

        supabase_url = os.environ.get('SUPABASE_URL', '')
        anon_key = os.environ.get('SUPABASE_ANON_KEY', '')
        if not supabase_url or not anon_key:
            return False, 500, 'Server misconfigured (missing SUPABASE env)'

        # Step 1: Verify JWT against Supabase auth endpoint
        try:
            verify_req = urllib.request.Request(
                f"{supabase_url}/auth/v1/user",
                headers={'Authorization': f'Bearer {jwt_token}', 'apikey': anon_key},
            )
            with urllib.request.urlopen(verify_req, timeout=10) as r:
                auth_user = json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return False, 401, 'Invalid or expired token'
            return False, 401, f'Token verification failed (HTTP {e.code})'
        except Exception as e:
            return False, 401, f'Token verification failed: {e}'

        auth_uid = auth_user.get('id')
        if not auth_uid:
            return False, 401, 'No user id in token'

        # Step 2: Resolve caller access — handles legacy dealers AND org users.
        service_key = os.environ.get('SUPABASE_SERVICE_KEY') or anon_key
        q_auth = urllib.parse.quote(str(auth_uid), safe='')
        svc_headers = {'apikey': service_key, 'Authorization': f'Bearer {service_key}'}

        def _get(path):
            req = urllib.request.Request(f"{supabase_url}{path}", headers=svc_headers)
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode('utf-8'))

        contract_dealer_id = contract.get('dealer_id')
        accessible_ids = []

        # 2a: legacy dealer row by auth_id
        try:
            dealer_rows = _get(f"/rest/v1/dealers?auth_id=eq.{q_auth}&select=id,is_admin,active&limit=1")
        except Exception as e:
            return False, 401, f'Could not look up dealer: {e}'
        dealer_row = dealer_rows[0] if dealer_rows else None

        # Admin short-circuit
        if dealer_row and dealer_row.get('is_admin'):
            return True, 200, None

        # 2b: org user row by auth_id
        try:
            user_rows = _get(f"/rest/v1/users?auth_id=eq.{q_auth}&status=eq.active&select=id,organization_id,role&limit=1")
        except Exception:
            user_rows = []
        user_row = user_rows[0] if user_rows else None

        if user_row:
            role = user_row.get('role')
            org_id = user_row.get('organization_id')
            if role in ('principal', 'org_admin'):
                q_org = urllib.parse.quote(str(org_id), safe='')
                try:
                    locs = _get(f"/rest/v1/dealers?organization_id=eq.{q_org}&select=id")
                    accessible_ids = [str(x.get('id')) for x in locs]
                except Exception:
                    accessible_ids = []
            else:
                q_uid = urllib.parse.quote(str(user_row.get('id')), safe='')
                try:
                    uls = _get(f"/rest/v1/user_locations?user_id=eq.{q_uid}&select=location_id")
                    accessible_ids = [str(x.get('location_id')) for x in uls]
                except Exception:
                    accessible_ids = []
        elif dealer_row:
            # legacy non-admin dealer: their own location
            if not dealer_row.get('active'):
                return False, 403, 'Dealer account is inactive'
            accessible_ids = [str(dealer_row.get('id'))]
        else:
            return False, 403, 'No access for this user'

        # Step 3: allow if the contract's location is in the caller's accessible set
        if str(contract_dealer_id) in accessible_ids:
            return True, 200, None
        return False, 403, 'You do not have access to this contract'

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
        supabase_key = (os.environ.get('SUPABASE_SERVICE_KEY') or
                        os.environ.get('SUPABASE_ANON_KEY', ''))

        url = (supabase_url + '/rest/v1/contracts'
               + '?id=eq.' + urllib.parse.quote(contract_id)
               + '&select=*'
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

        auth_header = self.headers.get('Authorization') or self.headers.get('authorization') or ''
        jwt_token = auth_header.replace('Bearer ', '').replace('bearer ', '').strip()

        allowed, code, err = self._verify_caller_owns_contract(jwt_token, c)
        if not allowed:
            self._json(code, {'error': err})
            return

        dealer = self._fetch_dealer(c.get('dealer_id'))
        c['dealership_name'] = dealer.get('dealership_name', '') or c.get('dealership_name', '')
        c['dealership_address'] = dealer.get('address', '') or ''
        c['dealership_city'] = dealer.get('city', '') or ''
        c['dealership_state'] = dealer.get('state', '') or ''
        c['dealership_zip'] = dealer.get('zip', '') or ''
        c['dealership_phone'] = dealer.get('phone', '') or ''

        template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'customer-enrollment-template.pdf')

        if not template_path or not os.path.exists(template_path):
            self._json(500, {'error': 'Template not found at: ' + str(template_path)})
            return

        # Generate filled PDF
        try:
            pdf_bytes = self._fill_pdf(c, template_path)
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

    def _fill_pdf(self, c, template_path=None):
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        import io

        template_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            'customer-enrollment-template.pdf'
        )
        if not os.path.exists(template_path):
            raise FileNotFoundError('Template not found: ' + template_path)

        packet = io.BytesIO()
        cv = canvas.Canvas(packet, pagesize=letter)
        w_page, h_page = letter  # 612 x 792

        def put(x, y_top, value, font_size=8):
            """Draw text. y_top measured from top of page (PDF coords from bottom use h_page - y_top)."""
            if not value or str(value).strip() == '':
                return
            cv.setFont('Helvetica', font_size)
            cv.drawString(x, h_page - y_top, str(value))

        def fmt_mmddyyyy(iso_or_date):
            if not iso_or_date:
                return ''
            s = str(iso_or_date).strip()
            if 'T' in s:
                s = s.split('T')[0]
            s = s[:10]
            p = s.split('-')
            if len(p) == 3 and len(p[0]) == 4:
                return p[1] + '/' + p[2] + '/' + p[0]
            return s

        raw_agreement = c.get('agreement_date') or (c.get('start_date') or '')[:10]
        agreement_date = fmt_mmddyyyy(raw_agreement)

        # Agreement Number — underline at y_top=82.5
        put(70, 90, c.get('agreement_number'))
        # Agreement Date — underline at y_top=109.4
        put(74, 117, agreement_date)

        # MAINTENANCE PLAN HOLDER INFORMATION
        put(60, 148, c.get('customer_first_name'))
        put(305, 148, c.get('customer_last_name'))
        put(528, 148, c.get('customer_middle_initial'))
        put(78, 165, c.get('customer_address'))
        put(360, 165, c.get('customer_email'))
        put(38, 182, c.get('customer_city'))
        put(208, 182, c.get('customer_state'))
        put(281, 182, c.get('customer_zip'))
        put(421, 182, c.get('customer_phone'))

        # LIENHOLDER INFORMATION
        if c.get('lienholder_name'):
            put(63, 208, c.get('lienholder_name'))
            put(78, 225, c.get('lienholder_address'))
            put(38, 242, c.get('lienholder_city'))
            put(208, 242, c.get('lienholder_state'))
            put(281, 242, c.get('lienholder_zip'))
            put(421, 242, c.get('lienholder_phone'))

        # SELLING DEALERSHIP INFORMATION
        put(106, 268, c.get('dealership_name'))
        put(78, 286, c.get('dealership_address'))
        put(38, 303, c.get('dealership_city'))
        put(208, 303, c.get('dealership_state'))
        put(281, 303, c.get('dealership_zip'))
        put(421, 303, c.get('dealership_phone'))

        # VESSEL INFORMATION
        put(34, 329, c.get('hin'))
        put(205, 329, str(c.get('boat_year', '') or ''))
        put(288, 329, c.get('boat_make'))
        put(415, 329, c.get('boat_model'))
        condition = (c.get('vessel_condition') or '').strip().lower()
        if condition == 'used':
            put(571, 335, 'X', 7)
        else:
            put(530, 335, 'X', 7)

        # ENGINE 1 + ENGINE 2
        put(70, 347, str(c.get('engine1_serial', '') or ''))
        put(205, 347, str(c.get('engine1_year', '') or ''))
        put(288, 347, str(c.get('engine1_make', '') or ''))
        put(415, 347, str(c.get('engine1_model', '') or ''))
        put(563, 347, str(c.get('engine1_hours', '') or ''))

        if c.get('engine2_serial') or c.get('engine2_year') or c.get('engine2_make'):
            put(70, 364, str(c.get('engine2_serial', '') or ''))
            put(205, 364, str(c.get('engine2_year', '') or ''))
            put(288, 364, str(c.get('engine2_make', '') or ''))
            put(415, 364, str(c.get('engine2_model', '') or ''))
            put(563, 364, str(c.get('engine2_hours', '') or ''))

        # MAINTENANCE COVERAGE — term checkboxes
        term = c.get('contract_type', '1yr')
        tnorm = str(term).strip().lower()
        if term == '1yr' or tnorm in ('12', '12 month', '1', '1-year', '1 year'):
            put(160, 413, 'X', 7)
        elif term == '2yr' or tnorm in ('24', '24 month', '2', '2-year', '2 year'):
            put(304, 413, 'X', 7)
        elif term == '3yr' or tnorm in ('36', '36 month', '3', '3-year', '3 year'):
            put(448, 413, 'X', 7)

        # Purchase price & date
        price_map = {'1yr': '$2,495.00', '2yr': '$4,495.00', '3yr': '$6,495.00'}
        purchase_price = ''
        rp = c.get('retail_price')
        if rp is not None and str(rp).strip() != '':
            try:
                purchase_price = '${:,.2f}'.format(float(rp))
            except (TypeError, ValueError):
                purchase_price = price_map.get(term, '')
        else:
            purchase_price = price_map.get(term, '')
        # Both labels at y_top=424.6
        # Values sit above the underline (Y nudged up 5pt) with extra padding after the colon (X nudged right 5pt)
        put(173, 428, purchase_price)
        purchase_date = fmt_mmddyyyy(c.get('agreement_date') or (c.get('start_date') or '')[:10])
        put(460, 428, purchase_date)

        cv.save()
        packet.seek(0)

        overlay = PdfReader(packet)
        reader = PdfReader(template_path)
        writer = PdfWriter()

        p1 = reader.pages[0]
        p1.merge_page(overlay.pages[0])
        writer.add_page(p1)
        for i in range(1, len(reader.pages)):
            writer.add_page(reader.pages[i])

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()
