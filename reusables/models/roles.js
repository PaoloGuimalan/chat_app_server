// Display names never confer authority. Role IDs and codes are realm-local.
const { defaultRoleNames, templatePermissions } = require("./roleTemplates");
const BUILTIN_CODES = new Set(["owner", "admin", "moderator", "member"]);

function roleTier(role) {
  return role?.realm_id != null && role.is_default && BUILTIN_CODES.has(role.code) ? role.code : "member";
}
function roleTierSQL(alias = "r") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new TypeError("Invalid role alias");
  return `CASE WHEN ${alias}.is_default = TRUE AND ${alias}.code IN ('owner','admin','moderator','member')
    THEN ${alias}.code ELSE 'member' END`;
}
const ROLE_COLUMNS = "id, name, code, realm_id, is_default";
async function resolveRole(client, { roleID, roleName, realmID } = {}) {
  if (realmID == null || realmID === "") throw Object.assign(new Error("Realm context is required"), { status: 400 });
  let result;
  if (roleID !== undefined && roleID !== null) {
    if (!/^[1-9]\d*$/.test(String(roleID)) || (typeof roleID === "number" && !Number.isSafeInteger(roleID))) {
      throw Object.assign(new Error("Invalid role ID"), { status: 400 });
    }
    result = await client.query(`SELECT ${ROLE_COLUMNS} FROM entity_role WHERE id = $1 AND realm_id = $2`, [String(roleID), realmID]);
  } else {
    result = await client.query(`SELECT ${ROLE_COLUMNS} FROM entity_role WHERE code = $1 AND is_default = TRUE AND realm_id = $2`, [roleName, realmID]);
  }
  if (result.rows.length !== 1) throw Object.assign(new Error(roleID == null ? "Missing or ambiguous default role" : "Unknown role ID in this realm"), { status: 400 });
  const role = result.rows[0];
  if (String(role.realm_id) !== String(realmID)) throw Object.assign(new Error("The selected role belongs to another realm"), { status: 400 });
  return role;
}
async function realmOwnerRoleID(client, realmID) {
  return (await resolveRole(client, { roleName: "owner", realmID })).id;
}
/** Caller holds a transaction. Locking the realm serializes all seeding/writes. */
async function ensureDefaultRoles(client, realmID) {
  const { rows } = await client.query("SELECT id, type FROM community_realm WHERE id = $1 FOR UPDATE", [realmID]);
  if (rows.length !== 1) throw new Error("Realm is unavailable for role creation");
  const result = {};
  for (const [code, name] of Object.entries(defaultRoleNames)) {
    const inserted = await client.query(`INSERT INTO entity_role (realm_id, code, name, is_default, created_at)
      VALUES ($1, $2, $3, TRUE, NOW()) ON CONFLICT (realm_id, code) DO NOTHING RETURNING ${ROLE_COLUMNS}`, [realmID, code, name]);
    const role = inserted.rows[0] || await resolveRole(client, { realmID, roleName: code });
    if (!role.is_default) throw new Error("Reserved role code has an invalid definition");
    if (inserted.rows.length && code !== "owner") {
      await client.query(`INSERT INTO entity_role_permissions (role_id, permission_id, created_at)
        SELECT $1, id, NOW() FROM entity_permission_catalog
        WHERE codename = ANY($2::text[]) AND scope = 'realm' AND is_active = TRUE
        ON CONFLICT (role_id, permission_id) DO NOTHING`, [role.id, templatePermissions(code, rows[0].type)]);
    }
    result[code] = role;
  }
  return result;
}
module.exports = { resolveRole, realmOwnerRoleID, ensureDefaultRoles, roleTier, roleTierSQL };
