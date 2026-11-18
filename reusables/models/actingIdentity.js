const pool = require("../database/postgres");

async function canActAsEntity(personalID, actingID, client = pool) {
  if (!personalID || !actingID) return false;
  if (String(personalID) === String(actingID)) return true;
  const { rows } = await client.query(`
    SELECT realm.id FROM community_realm realm
    JOIN community_member member ON member.realm_id = realm.id AND member.entity_id = $1
    JOIN entity_role role ON role.id = member.role_id AND role.realm_id = realm.id
    WHERE realm.entity_id = $2 AND realm.is_active = TRUE
      AND realm.type IN ('page','server','group','conference','channel','voice')
      AND EXISTS (
        SELECT 1 FROM entity_permission_catalog pc WHERE pc.code = 'realm.identity.act'
          AND pc.scope = 'realm' AND pc.is_active = TRUE
          AND ((role.code = 'owner' AND role.is_default = TRUE) OR COALESCE((SELECT ep.effect = 'grant' FROM entity_permission ep
            WHERE ep.entity_id = member.entity_id AND ep.realm_id = realm.id AND ep.permission_id = pc.id
              AND (ep.expires_at IS NULL OR ep.expires_at > NOW()) ORDER BY ep.id LIMIT 1),
            EXISTS (SELECT 1 FROM entity_role_permissions rp WHERE rp.role_id = role.id AND rp.permission_id = pc.id))))
    LIMIT 1`, [personalID, actingID]);
  return rows.length > 0;
}
/** Recheck a switched identity before every frame, including already-open streams. */
function authorizedActingStream(response, personalID, actingID, client = pool, revocationEvent = null) {
  // Keep the existing personal stream path synchronous and free of realm SQL.
  if (personalID && String(personalID) === String(actingID)) return response;
  let revoked = false;
  return {
    async sse(event, payload) {
      if (revoked) return;
      let allowed;
      try { allowed = await canActAsEntity(personalID, actingID, client); }
      catch { return; } // A database outage is not proof of revocation.
      if (revoked) return;
      if (allowed) return response.sse(event, payload);
      revoked = true;
      let name = "this realm";
      try {
        const { rows } = await client.query("SELECT name FROM community_realm WHERE entity_id = $1 LIMIT 1", [actingID]);
        name = rows[0]?.name || name;
      } catch { /* Revocation was already confirmed; label lookup is optional. */ }
      response.sse(revocationEvent || event, { status: false, auth: false, code: "REALM_ACCESS_REVOKED",
        message: `Your access to ${name} was revoked.` });
      response.end?.();
    },
  };
}
module.exports = { canActAsEntity, authorizedActingStream };
