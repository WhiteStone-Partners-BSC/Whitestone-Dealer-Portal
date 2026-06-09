// Resolves a caller (by auth_id) to their accessible location/dealer IDs + admin flag,
// handling BOTH legacy dealers (dealers row by auth_id) and org users (users row -> org/role).
// Mirrors the SQL current_user_accessible_locations() logic so API ownership checks match RLS.
async function resolveCallerAccess(supabaseUrl, serviceKey, authUid) {
  var svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };

  // 1) Legacy dealer row directly by auth_id?
  var dRes = await fetch(
    supabaseUrl + '/rest/v1/dealers?auth_id=eq.' + encodeURIComponent(authUid) +
    '&select=id,is_admin,active,organization_id,stripe_customer_id&limit=1',
    { headers: svc }
  );
  var dRows = await dRes.json();
  var dealerRow = Array.isArray(dRows) && dRows[0] ? dRows[0] : null;

  // Admin short-circuit: admins can act on everything.
  if (dealerRow && dealerRow.is_admin === true) {
    return { ok: true, isAdmin: true, active: dealerRow.active !== false,
             locationIds: null /* null = all */, dealerRow: dealerRow };
  }

  // 2) Org user row by auth_id?
  var uRes = await fetch(
    supabaseUrl + '/rest/v1/users?auth_id=eq.' + encodeURIComponent(authUid) +
    '&status=eq.active&select=id,organization_id,role&limit=1',
    { headers: svc }
  );
  var uRows = await uRes.json();
  var userRow = Array.isArray(uRows) && uRows[0] ? uRows[0] : null;

  if (userRow) {
    var locationIds = [];
    if (userRow.role === 'principal' || userRow.role === 'org_admin') {
      // All locations in the org
      var orgLocRes = await fetch(
        supabaseUrl + '/rest/v1/dealers?organization_id=eq.' + encodeURIComponent(userRow.organization_id) + '&select=id',
        { headers: svc }
      );
      var orgLocs = await orgLocRes.json();
      locationIds = Array.isArray(orgLocs) ? orgLocs.map(function(r){ return r.id; }) : [];
    } else {
      // Scoped roles: locations via user_locations
      var ulRes = await fetch(
        supabaseUrl + '/rest/v1/user_locations?user_id=eq.' + encodeURIComponent(userRow.id) + '&select=location_id',
        { headers: svc }
      );
      var uls = await ulRes.json();
      locationIds = Array.isArray(uls) ? uls.map(function(r){ return r.location_id; }) : [];
    }
    return { ok: true, isAdmin: false, active: true, locationIds: locationIds,
             dealerRow: dealerRow /* may be null for pure org users */, userRow: userRow,
             organizationId: userRow.organization_id };
  }

  // 3) Legacy dealer (non-admin) with no users row: their own location only.
  if (dealerRow) {
    if (dealerRow.active === false) {
      return { ok: false, reason: 'inactive' };
    }
    return { ok: true, isAdmin: false, active: true, locationIds: [dealerRow.id],
             dealerRow: dealerRow };
  }

  // 4) Nothing found.
  return { ok: false, reason: 'no_access' };
}

// Helper: can this caller act on a given dealer_id (location)?
function callerCanActOnLocation(access, dealerId) {
  if (!access || !access.ok) return false;
  if (access.isAdmin) return true;
  if (access.locationIds === null) return true; // admin sentinel
  return access.locationIds.map(String).indexOf(String(dealerId)) !== -1;
}

module.exports = { resolveCallerAccess, callerCanActOnLocation };
