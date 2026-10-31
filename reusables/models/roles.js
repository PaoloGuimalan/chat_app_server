// Names describe hierarchy; only a role's primary key identifies its grants.
async function resolveRole(client, { roleID, roleName } = {}) {
  let result;
  if (roleID !== undefined && roleID !== null) {
    if (!/^[1-9]\d*$/.test(String(roleID)) ||
        (typeof roleID === "number" && !Number.isSafeInteger(roleID))) {
      throw Object.assign(new Error("Invalid role ID"), { status: 400 });
    }
    result = await client.query(
      "SELECT id, name, is_default FROM entity_role WHERE id = $1",
      [String(roleID)],
    );
  } else {
    result = await client.query(
      "SELECT id, name, is_default FROM entity_role WHERE name = $1 AND is_default = TRUE",
      [roleName],
    );
  }
  if (result.rows.length !== 1) {
    throw Object.assign(new Error(roleID == null ? "Missing or ambiguous default role" : "Unknown role ID"), { status: 400 });
  }
  return result.rows[0];
}

async function realmOwnerRoleID(client, realmID) {
  const { rows } = await client.query(
    `SELECT DISTINCT m.role_id FROM community_member m
     JOIN entity_role r ON r.id = m.role_id
     WHERE m.realm_id = $1 AND r.name = 'owner'`,
    [realmID],
  );
  if (rows.length > 1) return null;
  if (rows.length === 1) return rows[0].role_id;
  return (await resolveRole(client, { roleName: "owner" })).id;
}

module.exports = { resolveRole, realmOwnerRoleID };
