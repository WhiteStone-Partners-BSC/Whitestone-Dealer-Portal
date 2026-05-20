# api/submit-ticket.py
# Sprint 2 Commit 2: Server-side ticket submission with authoritative green/yellow/red triage
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


def compute_ticket_triage(ticket, contract, market_prices):
    """
    Python port of window.computeTicketTriage in dealer-portal.js.
    Returns dict: {color, reasons, marketTotal, unknownServices, computedAt}
    """
    reasons = []
    market_total = 0.0
    unknown_services = []
    ticket = ticket or {}

    # --- Required data check ---
    data_issues = []
    hin = (ticket.get("hin") or "").strip()
    if not hin or len(hin) != 12:
        data_issues.append("HIN must be exactly 12 characters")
    ro = (ticket.get("ro_number") or "").strip()
    if not ro:
        data_issues.append("RO# missing")
    svc = (ticket.get("service_type") or "").strip()
    if not svc:
        data_issues.append("Service type missing")
    svc_date = ticket.get("service_date")
    if not svc_date:
        data_issues.append("Service date missing")
    try:
        req_amt = float(ticket.get("requested_amount") or 0)
    except (TypeError, ValueError):
        req_amt = 0.0
    if req_amt <= 0:
        data_issues.append("Requested amount must be greater than 0")
    if not contract:
        data_issues.append("No matching contract found for this HIN")
    elif not contract.get("start_date"):
        data_issues.append("Contract has no start date")
    if data_issues:
        reasons.append({"rule": "data_complete", "status": "fail", "detail": "; ".join(data_issues)})
    else:
        reasons.append({"rule": "data_complete", "status": "pass", "detail": "All required fields present"})

    # --- 30-day rule (strict) ---
    if contract and contract.get("start_date") and svc_date:
        try:
            eff_raw = contract["start_date"]
            svc_raw = svc_date
            eff = datetime.fromisoformat(eff_raw.replace("Z", "+00:00") if "T" in eff_raw else eff_raw)
            sv = datetime.fromisoformat(svc_raw.replace("Z", "+00:00") if "T" in svc_raw else svc_raw)
            days_since = (sv.date() - eff.date()).days if hasattr(eff, "date") else (sv - eff).days
            if days_since < 30:
                reasons.append({
                    "rule": "30_day", "status": "fail",
                    "detail": f"Service performed {days_since} day(s) after contract start date (minimum 30 required — hard line, no tolerance)"
                })
            else:
                reasons.append({
                    "rule": "30_day", "status": "pass",
                    "detail": f"{days_since} day(s) since contract start date"
                })
        except (ValueError, TypeError, AttributeError):
            reasons.append({"rule": "30_day", "status": "fail", "detail": "Could not parse dates for 30-day check"})

    # --- 25-hour rule ---
    services_raw = [s.strip() for s in svc.split(",") if s.strip()]
    winterize_set = {"Winterization", "De-Winterization"}
    non_winterize = [s for s in services_raw if s not in winterize_set]
    if not non_winterize:
        reasons.append({"rule": "25_hour", "status": "skipped", "detail": "Winterize/De-Winterize services exempt from 25-hour rule"})
    else:
        baseline = contract.get("engine_hours_at_enrollment") if contract else None
        if baseline is None:
            reasons.append({"rule": "25_hour", "status": "fail", "detail": "Cannot verify hour rule — engine hours baseline not captured at enrollment"})
        else:
            try:
                ticket_hrs = float(ticket.get("engine_hours") or 0)
                base_hrs = float(baseline)
                hours_since = ticket_hrs - base_hrs
                if hours_since < 0:
                    reasons.append({
                        "rule": "25_hour", "status": "fail",
                        "detail": f"Ticket engine hours ({ticket_hrs}) is LESS than enrollment baseline ({base_hrs}) — data entry error"
                    })
                elif hours_since >= 25:
                    reasons.append({"rule": "25_hour", "status": "pass", "detail": f"{hours_since:.1f} hours since enrollment baseline (minimum 25)"})
                elif hours_since >= 20:
                    reasons.append({"rule": "25_hour", "status": "yellow", "detail": f"{hours_since:.1f} hours since enrollment baseline (within 5-hour tolerance of 25 minimum)"})
                else:
                    reasons.append({"rule": "25_hour", "status": "fail", "detail": f"{hours_since:.1f} hours since enrollment baseline (minimum 25 required)"})
            except (TypeError, ValueError):
                reasons.append({"rule": "25_hour", "status": "fail", "detail": "Ticket engine hours are missing or invalid"})

    # --- Price rule ---
    if services_raw:
        price_map = {}
        for p in market_prices or []:
            name = (p.get("service_name") or "").lower()
            try:
                price_map[name] = float(p.get("standard_price") or 0)
            except (TypeError, ValueError):
                pass
        for s in services_raw:
            price = price_map.get(s.lower())
            if price is None:
                unknown_services.append(s)
            else:
                market_total += price
        if len(unknown_services) == len(services_raw):
            reasons.append({"rule": "price", "status": "yellow", "detail": f"No market price data for: {', '.join(unknown_services)} — admin review required"})
        elif unknown_services:
            reasons.append({"rule": "price", "status": "yellow", "detail": f"Unknown service(s): {', '.join(unknown_services)}. Known services totaled ${market_total:.2f} — full comparison not possible"})
        elif req_amt > 0:
            pct_over = ((req_amt - market_total) / market_total) * 100
            if req_amt <= market_total:
                reasons.append({"rule": "price", "status": "pass", "detail": f"Requested ${req_amt:.2f} is at or below market total of ${market_total:.2f}"})
            elif pct_over <= 15:
                reasons.append({"rule": "price", "status": "yellow", "detail": f"Requested ${req_amt:.2f} is {pct_over:.1f}% above market total of ${market_total:.2f} (within 15% tolerance)"})
            else:
                reasons.append({"rule": "price", "status": "fail", "detail": f"Requested ${req_amt:.2f} is {pct_over:.1f}% above market total of ${market_total:.2f} (exceeds 15% threshold)"})

    # --- Final color resolution ---
    has_fail = any(r["status"] == "fail" for r in reasons)
    has_yellow = any(r["status"] == "yellow" for r in reasons)
    color = "red" if has_fail else ("yellow" if has_yellow else "green")

    return {
        "color": color,
        "reasons": reasons,
        "marketTotal": round(market_total, 2),
        "unknownServices": unknown_services,
        "computedAt": datetime.now(timezone.utc).isoformat()
    }


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def _verify_dealer(self, jwt_token):
        """Returns (dealer_row, status_code, error). dealer_row must be active, non-admin."""
        supabase_url = os.environ.get("SUPABASE_URL", "")
        anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY") or anon_key
        if not supabase_url or not anon_key:
            return None, 500, "Server config error"
        try:
            verify_req = urllib_request.Request(
                f"{supabase_url}/auth/v1/user",
                headers={"Authorization": f"Bearer {jwt_token}", "apikey": anon_key}
            )
            with urllib_request.urlopen(verify_req, timeout=10) as r:
                user_data = json.loads(r.read().decode("utf-8"))
            auth_id = user_data.get("id")
            if not auth_id:
                return None, 401, "Invalid token"
            q_auth = urllib_parse.quote(auth_id, safe="")
            dealer_req = urllib_request.Request(
                f"{supabase_url}/rest/v1/dealers?auth_id=eq.{q_auth}&select=id,dealership_name,is_admin,active&limit=1",
                headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}
            )
            with urllib_request.urlopen(dealer_req, timeout=10) as r:
                rows = json.loads(r.read().decode("utf-8"))
            if not rows:
                return None, 403, "Dealer record not found"
            d = rows[0]
            if not d.get("active"):
                return None, 403, "Dealer account inactive"
            if d.get("is_admin"):
                return None, 403, "Admin accounts cannot submit tickets"
            return d, 200, None
        except HTTPError as e:
            return None, e.code, f"Auth verification failed: {e.code}"
        except (URLError, json.JSONDecodeError, KeyError) as e:
            return None, 500, f"Auth verification error: {str(e)[:200]}"

    def _supabase_get(self, path):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def _supabase_post(self, path, payload, prefer="return=representation"):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        data = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            data=data, method="POST",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": prefer
            }
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else None

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body_raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            body = json.loads(body_raw)
        except (ValueError, json.JSONDecodeError):
            return self._send_json(400, {"error": "Invalid JSON body"})

        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return self._send_json(401, {"error": "Missing Authorization header"})
        jwt_token = auth_header[7:]

        dealer, code, err = self._verify_dealer(jwt_token)
        if err:
            return self._send_json(code, {"error": err})

        # Required fields
        required = ["hin", "ro_number", "service_type", "service_date", "requested_amount", "ticket_number"]
        missing = [k for k in required if not body.get(k)]
        if missing:
            return self._send_json(400, {"error": f"Missing required fields: {', '.join(missing)}"})

        hin = (body.get("hin") or "").strip().upper()
        if len(hin) != 12:
            return self._send_json(400, {"error": "HIN must be exactly 12 characters"})

        # Lookup contract by HIN scoped to caller's dealer (cross-tenant safe)
        try:
            q_hin = urllib_parse.quote(hin, safe="")
            q_dealer = urllib_parse.quote(dealer["id"], safe="")
            contracts = self._supabase_get(
                f"contracts?hin=eq.{q_hin}&dealer_id=eq.{q_dealer}"
                f"&select=id,start_date,engine_hours_at_enrollment"
                f"&order=start_date.desc.nullslast&limit=1"
            )
        except Exception as e:
            return self._send_json(500, {"error": f"Contract lookup failed: {str(e)[:200]}"})

        contract = contracts[0] if contracts else None

        # Load market prices
        try:
            market_prices = self._supabase_get(
                "service_market_prices?region=eq.utah&effective_to=is.null"
                "&select=service_name,standard_price,supercharged_price"
            )
        except Exception as e:
            return self._send_json(500, {"error": f"Market price lookup failed: {str(e)[:200]}"})

        # Compute triage
        ticket_data_for_triage = {
            "hin": hin,
            "ro_number": body.get("ro_number"),
            "service_type": body.get("service_type"),
            "service_date": body.get("service_date"),
            "requested_amount": body.get("requested_amount"),
            "engine_hours": body.get("engine_hours")
        }
        triage = compute_ticket_triage(ticket_data_for_triage, contract, market_prices)

        # Auto-flag service_notes and enrich triage if no contract found
        service_notes = body.get("service_notes") or ""
        if not contract:
            dealer_name = dealer.get("dealership_name") or "unknown dealer"
            no_contract_detail = (
                f"No matching contract found for HIN {hin} under dealer {dealer_name}. "
                "Likely cause: customer not yet enrolled, or HIN typo on ticket. Admin must verify."
            )
            for r in triage["reasons"]:
                if r.get("rule") == "data_complete" and r.get("status") == "fail":
                    r["detail"] = no_contract_detail
                    break
            triage["color"] = "red"
            service_notes = (
                service_notes + "\n\n[AUTO-FLAGGED RED] No matching contract found for this HIN."
            ).strip()

        # Build ticket row
        ticket_row = {
            "ticket_number": body.get("ticket_number"),
            "dealer_id": dealer["id"],
            "dealership_name": dealer["dealership_name"],
            "technician": body.get("technician"),
            "customer_first_name": body.get("customer_first_name"),
            "customer_last_name": body.get("customer_last_name"),
            "customer_email": body.get("customer_email"),
            "customer_phone": body.get("customer_phone"),
            "boat_make": body.get("boat_make"),
            "boat_model": body.get("boat_model"),
            "boat_year": body.get("boat_year"),
            "hin": hin,
            "engine_hours": body.get("engine_hours"),
            "service_type": body.get("service_type"),
            "service_date": body.get("service_date"),
            "service_notes": service_notes,
            "ro_number": body.get("ro_number"),
            "requested_amount": float(body.get("requested_amount") or 0),
            "status": "pending",
            "triage_color": triage["color"],
            "triage_reasons": triage["reasons"],
            "triage_market_total": triage["marketTotal"],
            "triage_computed_at": triage["computedAt"]
        }

        # Insert ticket
        try:
            inserted = self._supabase_post("tickets", ticket_row)
            new_ticket = inserted[0] if isinstance(inserted, list) and inserted else inserted
        except Exception as e:
            return self._send_json(500, {"error": f"Ticket insert failed: {str(e)[:300]}"})

        # Insert matching reimbursement (status pending)
        try:
            req_amt = float(body.get("requested_amount") or 0)
            reimbursement_row = {
                "ticket_id": new_ticket["id"],
                "dealer_id": dealer["id"],
                "dealership_name": dealer["dealership_name"],
                "amount": req_amt,
                "status": "pending"
            }
            self._supabase_post("reimbursements", reimbursement_row, prefer="return=minimal")
        except Exception as e:
            return self._send_json(200, {
                "ticket": new_ticket,
                "triage": triage,
                "warning": f"Ticket created but reimbursement creation failed: {str(e)[:200]}"
            })

        return self._send_json(200, {"ticket": new_ticket, "triage": triage})
