# api/invite-user.py
# Sprint 3 Commit 3a — Invite a new user to an organization.
# Caller must be principal or org_admin of the org.
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


# Roles that can be invited (principal is excluded — only transferred)
INVITABLE_ROLES = {"org_admin", "location_manager", "sales", "service", "accountant"}
# Roles that don't need location assignments (they get all-org access)
ORG_WIDE_ROLES = {"org_admin"}
# Invitation expires after 7 days
INVITATION_EXPIRY_DAYS = 7


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def _verify_inviter(self, jwt_token):
        """
        Returns (user_record, status_code, error).
        user_record must be active and have role in (principal, org_admin).
        """
        supabase_url = os.environ.get("SUPABASE_URL", "")
        anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY") or anon_key
        if not supabase_url or not anon_key:
            return None, 500, "Server config error"

        try:
            verify_req = urllib_request.Request(
                f"{supabase_url}/auth/v1/user",
                headers={"Authorization": f"Bearer {jwt_token}", "apikey": anon_key},
            )
            with urllib_request.urlopen(verify_req, timeout=10) as r:
                user_data = json.loads(r.read().decode("utf-8"))
            auth_id = user_data.get("id")
            if not auth_id:
                return None, 401, "Invalid token"

            q_auth = urllib_parse.quote(auth_id, safe="")
            user_lookup = urllib_request.Request(
                f"{supabase_url}/rest/v1/users?auth_id=eq.{q_auth}&select=id,organization_id,email,full_name,role,status&limit=1",
                headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            )
            with urllib_request.urlopen(user_lookup, timeout=10) as r:
                rows = json.loads(r.read().decode("utf-8"))
            if not rows:
                return None, 403, "User record not found"
            u = rows[0]
            if u.get("status") != "active":
                return None, 403, "User account is not active"
            if u.get("role") not in ("principal", "org_admin"):
                return None, 403, "Only principal or org admin can invite users"
            return u, 200, None
        except HTTPError as e:
            return None, e.code, f"Auth verification failed: {e.code}"
        except (URLError, json.JSONDecodeError, KeyError) as e:
            return None, 500, f"Auth verification error: {str(e)[:200]}"

    def _supabase_get(self, path):
        supabase_url = os.environ.get("SUPABASE_URL", "")
        service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        req = urllib_request.Request(
            f"{supabase_url}/rest/v1/{path}",
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
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
            },
        )
        with urllib_request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8")
            return json.loads(body) if body else None

    def _send_invitation_email(self, to_email, org_name, role, inviter_name, token):
        """Send the invitation email via Resend. Returns (ok, error_string)."""
        resend_key = os.environ.get("RESEND_API_KEY", "")
        if not resend_key:
            return False, "RESEND_API_KEY not configured"

        accept_url = f"https://whitestone-dealer-portal.vercel.app/accept-invite?token={token}"
        role_display = role.replace("_", " ").title()

        html = f"""<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #222;">
<h1 style="color: #0F2A44; font-size: 22px;">You've been invited to join {org_name}</h1>
<p>Hi,</p>
<p>{inviter_name} has invited you to join <strong>{org_name}</strong> as a <strong>{role_display}</strong> on Whitestone Partners.</p>
<p>Click below to set up your account and accept the invitation:</p>
<p style="margin: 32px 0;">
  <a href="{accept_url}" style="background: #0F2A44; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Accept Invitation</a>
</p>
<p style="color: #666; font-size: 13px;">Or paste this link into your browser:<br><a href="{accept_url}">{accept_url}</a></p>
<p style="color: #666; font-size: 13px;">This invitation expires in {INVITATION_EXPIRY_DAYS} days.</p>
<p style="color: #666; font-size: 13px;">Questions? Reply to this email or contact <a href="mailto:support@whitestone-partners.com">support@whitestone-partners.com</a>.</p>
</body></html>"""

        payload = {
            "from": "Whitestone Partners <support@whitestone-partners.com>",
            "to": [to_email],
            "subject": f"You've been invited to join {org_name} on Whitestone Partners",
            "html": html,
        }
        try:
            req = urllib_request.Request(
                "https://api.resend.com/emails",
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {resend_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "Whitestone-Partners/1.0 (+https://whitestone-partners.com)",
                },
            )
            with urllib_request.urlopen(req, timeout=10) as r:
                r.read()
            return True, None
        except HTTPError as e:
            err_body = e.read().decode("utf-8")[:300] if hasattr(e, "read") else str(e)
            return False, f"Resend HTTPError {e.code}: {err_body}"
        except (URLError, Exception) as e:
            return False, f"Resend error: {str(e)[:200]}"

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

        inviter, code, err = self._verify_inviter(jwt_token)
        if err:
            return self._send_json(code, {"error": err})

        email = (body.get("email") or "").strip().lower()
        role = (body.get("role") or "").strip().lower()
        location_ids = body.get("location_ids") or []

        if not email or "@" not in email:
            return self._send_json(400, {"error": "Valid email required"})
        if role not in INVITABLE_ROLES:
            return self._send_json(400, {"error": f"Role must be one of: {sorted(INVITABLE_ROLES)}"})

        # For non-org-wide roles, require location_ids
        if role not in ORG_WIDE_ROLES and not location_ids:
            return self._send_json(400, {"error": "At least one location_id required for this role"})

        q_org = urllib_parse.quote(inviter["organization_id"], safe="")

        # Validate location_ids belong to inviter's org
        if location_ids:
            try:
                allowed_locs = self._supabase_get(f"dealers?organization_id=eq.{q_org}&select=id")
                allowed_ids = {l["id"] for l in allowed_locs}
                bad = [l for l in location_ids if l not in allowed_ids]
                if bad:
                    return self._send_json(403, {"error": "One or more location_ids do not belong to your organization"})
            except Exception as e:
                return self._send_json(500, {"error": f"Location validation failed: {str(e)[:200]}"})

        # Check existing user with same email in this org
        try:
            q_email = urllib_parse.quote(email, safe="")
            existing_users = self._supabase_get(f"users?organization_id=eq.{q_org}&email=eq.{q_email}&limit=1")
            if existing_users:
                return self._send_json(409, {"error": "A user with this email already exists in your organization"})
        except Exception as e:
            return self._send_json(500, {"error": f"User lookup failed: {str(e)[:200]}"})

        # Check existing pending invitation
        try:
            existing_inv = self._supabase_get(
                f"user_invitations?organization_id=eq.{q_org}&email=eq.{q_email}&accepted_at=is.null&limit=1"
            )
            if existing_inv:
                return self._send_json(409, {"error": "A pending invitation already exists for this email. Cancel the existing one first."})
        except Exception as e:
            return self._send_json(500, {"error": f"Invitation lookup failed: {str(e)[:200]}"})

        # Create invitation
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(days=INVITATION_EXPIRY_DAYS)).isoformat()

        try:
            inv_payload = {
                "organization_id": inviter["organization_id"],
                "email": email,
                "role": role,
                "invited_by_user_id": inviter["id"],
                "invitation_token": token,
                "expires_at": expires_at,
            }
            inv_rows = self._supabase_post("user_invitations", inv_payload)
            invitation = inv_rows[0] if isinstance(inv_rows, list) and inv_rows else inv_rows
        except Exception as e:
            return self._send_json(500, {"error": f"Invitation create failed: {str(e)[:300]}"})

        # Insert location assignments (if any)
        if location_ids:
            try:
                loc_rows = [{"invitation_id": invitation["id"], "location_id": lid} for lid in location_ids]
                self._supabase_post("user_invitation_locations", loc_rows, prefer="return=minimal")
            except Exception as e:
                # Roll back the invitation row to avoid orphaned state
                try:
                    q_inv = urllib_parse.quote(invitation["id"], safe="")
                    supabase_url = os.environ.get("SUPABASE_URL", "")
                    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
                    del_req = urllib_request.Request(
                        f"{supabase_url}/rest/v1/user_invitations?id=eq.{q_inv}",
                        method="DELETE",
                        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
                    )
                    urllib_request.urlopen(del_req, timeout=10)
                except Exception:
                    pass
                return self._send_json(500, {"error": f"Location assignment failed: {str(e)[:200]}"})

        # Look up org name for the email
        try:
            org_rows = self._supabase_get(f"organizations?id=eq.{q_org}&select=name&limit=1")
            org_name = org_rows[0]["name"] if org_rows else "your organization"
        except Exception:
            org_name = "your organization"

        inviter_name = inviter.get("full_name") or inviter.get("email") or "A team member"

        # Send the email
        email_ok, email_err = self._send_invitation_email(email, org_name, role, inviter_name, token)

        # If email fails, the invitation row exists but the recipient can't act.
        # Return success but flag the email problem so admin can manually re-send.
        return self._send_json(200, {
            "invitation": {
                "id": invitation["id"],
                "email": email,
                "role": role,
                "organization_id": inviter["organization_id"],
                "expires_at": expires_at,
                "token": token,
            },
            "email_sent": email_ok,
            "email_warning": email_err if not email_ok else None,
        })
