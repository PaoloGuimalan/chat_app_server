const { roleTier, roleTierSQL } = require("./roles");

const ADMINISTRATION = new Set(["realm.roles.manage", "realm.permissions.manage", "realm.identity.act"]);
const INTRINSIC = new Set(["realm.delete", "realm.ownership.transfer"]);
const permission = (...args) => require("../hooks/permissionChecker").hasActivePermission(...args);
const denied = (message, code) => Object.assign(new Error(message), { status: 403, code });

async function effectiveRolePermissions(client, role, realmID) {
  if (String(role.realm_id) !== String(realmID)) throw denied("The selected role belongs to another realm");
  if (roleTier(role) === "owner") {
    const { rows } = await client.query("SELECT code FROM entity_permission_catalog WHERE scope = 'realm' AND is_active = TRUE");
    return new Set(rows.map(row => row.code));
  }
  const { rows } = await client.query(
    `SELECT pce.code FROM entity_role_permissions rp
     JOIN entity_permission_catalog pce ON pce.id = rp.permission_id
     JOIN entity_role r ON r.id = rp.role_id
     WHERE rp.role_id = $1 AND r.realm_id = $2 AND pce.scope = 'realm' AND pce.is_active = TRUE`, [role.id, realmID]);
  const result = new Set(rows.map(row => row.code));
  return result;
}

async function lockedActorContext(client, actorID, realmID) {
  const { rows: realms } = await client.query(
    `SELECT id, entity_id, type, is_active FROM community_realm WHERE id = $1 AND is_active = TRUE FOR UPDATE`, [realmID],
  );
  if (!realms.length) throw denied("This realm is unavailable.");
  const realm = realms[0];
  let actorTier;
  if (realm.type !== "community" && String(realm.entity_id) === String(actorID)) actorTier = "owner";
  else {
    const { rows } = await client.query(
      `SELECT m.member_id, m.entity_id, ${roleTierSQL("r")} AS tier
       FROM community_member m JOIN entity_role r ON r.id = m.role_id
       WHERE m.entity_id = $1 AND m.realm_id = $2 AND r.realm_id = $2 FOR UPDATE OF m`,
      [actorID, realmID],
    );
    if (!rows.length) throw denied("Only current members can assign roles.");
    actorTier = rows[0].tier;
  }
  return { realm, actorTier };
}

async function assertTargetAccess(actorTier, target, actorID, realmID, client, checkPermission) {
  if (actorTier === "owner" || String(target.entity_id) === String(actorID)) return;
  if (target.tier === "owner" || target.tier === "admin") throw denied("Only the owner can change an administrator's membership.");
  for (const code of ADMINISTRATION) {
    if (await checkPermission(target.entity_id, code, realmID, { client, fresh: true })) throw denied("Only the owner can change an administrator's membership.");
  }
}

/** Use a transaction client: the shared realm lock serializes all policy writes. */
async function assertCanDelegateRole(client, { actorID, realmID, role, targetMemberID }, checkPermission = permission) {
  if (String(role.realm_id) !== String(realmID)) throw denied("The selected role belongs to another realm");
  if (roleTier(role) === "owner") throw denied("Use ownership transfer to change the realm owner.", "OWNERSHIP_TRANSFER");
  const { realm, actorTier } = await lockedActorContext(client, actorID, realmID);
  const options = { client, fresh: true };
  if (!(await checkPermission(actorID, "realm.member.role.update", realmID, options))) throw denied("You cannot assign roles here.");
  let target = null;
  if (targetMemberID != null) {
    const { rows } = await client.query(
      `SELECT m.member_id, m.entity_id, ${roleTierSQL("r")} AS tier
       FROM community_member m JOIN entity_role r ON r.id = m.role_id
       WHERE m.member_id = $1 AND m.realm_id = $2 FOR UPDATE OF m`, [targetMemberID, realmID],
    );
    target = rows[0];
    if (!target) throw Object.assign(new Error("That member is not part of this realm"), { status: 404 });
    if (target.tier === "owner") throw denied("Use ownership transfer to change the realm owner.", "OWNERSHIP_TRANSFER");
    await assertTargetAccess(actorTier, target, null, realmID, client, checkPermission);
  }
  for (const code of await effectiveRolePermissions(client, role, realmID)) {
    if (INTRINSIC.has(code)) throw denied("Ownership actions cannot be delegated through roles.");
    if (ADMINISTRATION.has(code) && actorTier !== "owner") throw denied("Only the owner can delegate role or permission administration.");
    if (!(await checkPermission(actorID, code, realmID, options))) throw denied("You cannot delegate permissions you do not hold.");
  }
  return { realm, actorTier, target };
}

async function assertCanRemoveMembers(client, { actorID, realmID, entityIDs }, checkPermission = permission) {
  if (!Array.isArray(entityIDs) || !entityIDs.length || entityIDs.some(id => typeof id !== "string" || !id)) {
    throw Object.assign(new Error("Choose members to remove."), { status: 400 });
  }
  const { realm, actorTier } = await lockedActorContext(client, actorID, realmID);
  const others = entityIDs.filter(id => id !== String(actorID));
  if (others.length && !(await checkPermission(actorID, "realm.member.remove", realmID, { client, fresh: true }))) throw denied("You cannot remove members here.");
  const { rows } = await client.query(
    `SELECT m.entity_id, ${roleTierSQL("r")} AS tier
     FROM community_member m JOIN entity_role r ON r.id = m.role_id
     WHERE m.entity_id = ANY($1::text[]) AND m.realm_id = $2 ORDER BY m.member_id FOR UPDATE OF m`,
    [entityIDs, realmID],
  );
  for (const target of rows) await assertTargetAccess(actorTier, target, actorID, realmID, client, checkPermission);
  const { rows: owners } = await client.query(
    `SELECT m.entity_id FROM community_member m JOIN entity_role r ON r.id = m.role_id
     WHERE m.realm_id = $1 AND ${roleTierSQL("r")} = 'owner'`, [realmID],
  );
  if (owners.length && owners.every(owner => entityIDs.includes(String(owner.entity_id)))) throw denied("Transfer ownership to another member before leaving.", "OWNERSHIP_TRANSFER");
  return { realm, actorTier };
}

async function assertCanTransferOwnership(client, { actorID, realmID }, checkPermission = permission) {
  const context = await lockedActorContext(client, actorID, realmID);
  if (context.actorTier !== "owner" || !(await checkPermission(actorID, "realm.ownership.transfer", realmID, { client, fresh: true }))) throw denied("Only the realm owner can transfer ownership.");
  return context;
}

module.exports = { assertCanDelegateRole, assertCanRemoveMembers, assertCanTransferOwnership, effectiveRolePermissions };
