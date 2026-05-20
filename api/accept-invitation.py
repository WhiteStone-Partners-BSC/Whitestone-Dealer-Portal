# api/accept-invitation.py
# Sprint 3 Commit 3b-iii — Accept an invitation, create auth + users + user_locations rows
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def _supabase_get(self, path):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "User-Agent": "Whitestone-Partners/1.0",
            },
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def _supabase_post(self, path, payload, prefer="return=representation"):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        data = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            data=data,
            method="POST",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": prefer,
                "User-Agent": "Whitestone-Partners/1.0",
            },
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else None

    def _supabase_patch(self, path, payload):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        data = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            data=data,
            method="PATCH",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
                "User-Agent": "Whitestone-Partners/1.0",
            },
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            r.read()
        return True

    def _create_auth_user(self, email, password):
        """Create auth user via Supabase Admin API. Returns (auth_id, error)."""
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        payload = {
            "email": email,
            "password": password,
            "email_confirm": True,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(
            f"{supabase_url}/auth/v1/admin/users",
            data=data,
            method="POST",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "User-Agent": "Whitestone-Partners/1.0",
            },
        )
        try:
            with urllib_request.urlopen(req, timeout=10) as r:
                body = json.loads(r.read().decode("utf-8"))
                return body.get("id"), None
        except HTTPError as e:
            err_body = e.read().decode("utf-8")[:300] if hasattr(e, "read") else str(e)
            return None, f"Auth create failed ({e.code}): {err_body}"
        except (URLError, Exception) as e:
            return None, f"Auth create error: {str(e)[:200]}"

    def _delete_auth_user(self, auth_id):
        """Best-effort rollback if subsequent steps fail."""
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        q_id = urllib_parse.quote(auth_id, safe="")
        req = urllib_request.Request(
            f"{supabase_url}/auth/v1/admin/users/{q_id}",
            method="DELETE",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "User-Agent": "Whitestone-Partners/1.0",
            },
        )
        try:
            with urllib_request.urlopen(req, timeout=10) as r:
                r.read()
        except Exception:
            pass

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body_raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            body = json.loads(body_raw)
        except (ValueError, json.JSONDecodeError):
            return self._send_json(400, {"error": "Invalid JSON body"})

        token = (body.get("token") or "").strip()
        full_name = (body.get("full_name") or "").strip()
        password = body.get("password") or ""

        if not token:
            return self._send_json(400, {"error": "Missing invitation token"})
        if not full_name:
            return self._send_json(400, {"error": "Full name required"})
        if len(password) < 8:
            return self._send_json(400, {"error": "Password must be at least 8 characters"})

        try:
            q_token = urllib_parse.quote(token, safe="")
            inv_rows = self._supabase_get(
                f"user_invitations?invitation_token=eq.{q_token}&accepted_at=is.null"
                f"&select=id,email,role,organization_id,expires_at&limit=1"
            )
            if not inv_rows:
                return self._send_json(404, {"error": "Invitation not found or already used"})
            inv = inv_rows[0]
        except Exception as e:
            return self._send_json(500, {"error": f"Invitation lookup failed: {str(e)[:200]}"})

        try:
            exp_raw = inv["expires_at"]
            exp = datetime.fromisoformat(exp_raw.replace("Z", "+00:00") if "T" in exp_raw else exp_raw)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= datetime.now(timezone.utc):
                return self._send_json(403, {"error": "Invitation expired"})
        except (ValueError, KeyError):
            return self._send_json(500, {"error": "Invalid invitation expiry"})

        email = inv["email"]
        q_inv = urllib_parse.quote(inv["id"], safe="")

        try:
            q_org = urllib_parse.quote(inv["organization_id"], safe="")
            q_email = urllib_parse.quote(email, safe="")
            existing = self._supabase_get(
                f"users?organization_id=eq.{q_org}&email=eq.{q_email}&limit=1"
            )
            if existing:
                return self._send_json(409, {"error": "A user with this email already exists in your organization"})
        except Exception as e:
            return self._send_json(500, {"error": f"Pre-check failed: {str(e)[:200]}"})

        auth_id, err = self._create_auth_user(email, password)
        if err:
            return self._send_json(500, {"error": err})

        try:
            user_payload = {
                "auth_id": auth_id,
                "organization_id": inv["organization_id"],
                "email": email,
                "full_name": full_name,
                "role": inv["role"],
                "status": "active",
            }
            user_rows = self._supabase_post("users", user_payload)
            new_user = user_rows[0] if isinstance(user_rows, list) and user_rows else user_rows
            if not new_user or not new_user.get("id"):
                raise Exception("User row creation returned no id")
        except Exception as e:
            self._delete_auth_user(auth_id)
            return self._send_json(500, {"error": f"User row creation failed: {str(e)[:300]}"})

        try:
            inv_locs = self._supabase_get(
                f"user_invitation_locations?invitation_id=eq.{q_inv}&select=location_id"
            )
            if inv_locs:
                loc_payload = [
                    {"user_id": new_user["id"], "location_id": l["location_id"]}
                    for l in inv_locs
                ]
                self._supabase_post("user_locations", loc_payload, prefer="return=minimal")
        except Exception as e:
            print(f"WARN: location copy failed: {str(e)[:200]}")

        try:
            accepted_at = datetime.now(timezone.utc).isoformat()
            self._supabase_patch(
                f"user_invitations?id=eq.{q_inv}",
                {"accepted_at": accepted_at},
            )
        except Exception as e:
            print(f"WARN: invitation patch failed: {str(e)[:200]}")

        return self._send_json(200, {
            "ok": True,
            "user_id": new_user["id"],
            "email": email,
            "role": inv["role"],
        })
