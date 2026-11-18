const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function policy() {
  const file = path.join(__dirname, "realmRolePolicy.js");
  assert.ok(fs.existsSync(file), "Realm role delegation policy is not implemented");
  return require(file);
}

function fixture({ tier = "owner", targetTier = "member", grants = [], explicitTargetAdmin = false } = {}) {
  return {
    client: { async query(sql, params) {
      if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", entity_id: "realm-entity", type: "community", is_active: true }] };
      if (sql.includes("FROM community_member") && sql.includes("= 'owner'")) return { rows: tier === "owner" ? [{ entity_id: "actor" }] : [] };
      if (sql.includes("FROM community_member") && Array.isArray(params[0])) return { rows: params[0].map(entity_id => ({ entity_id, tier: entity_id === "actor" ? tier : targetTier })) };
      if (sql.includes("FROM community_member")) return { rows: [{ member_id: params[0] === "target" ? "target" : "actor-member", entity_id: params[0] === "target" ? "recipient" : "actor", tier: params[0] === "target" ? targetTier : tier }] };
      if (sql.includes("FROM entity_role_permissions")) return { rows: grants.map(code => ({ code })) };
      throw new Error(sql);
    } },
    checkPermission: async (actor, permission) => actor === "recipient" ? explicitTargetAdmin && permission === "realm.roles.manage" : true,
  };
}

test("only the owner can assign an existing role carrying administration", async () => {
  const { assertCanDelegateRole } = await policy();
  const role = { id: "7", name: "Operations", realm_id: "realm", code: "operations-realm", is_default: false };
  const args = { actorID: "actor", realmID: "realm", role, targetMemberID: "target" };
  const owner = fixture({ grants: ["realm.roles.manage"] });
  await assertCanDelegateRole(owner.client, args, owner.checkPermission);
  const admin = fixture({ tier: "admin", grants: ["realm.roles.manage"] });
  await assert.rejects(assertCanDelegateRole(admin.client, args, admin.checkPermission), error => error.status === 403);
});

test("foreign role and owner targets cannot be assigned through ordinary role updates", async () => {
  const { assertCanDelegateRole } = await policy();
  const f = fixture();
  await assert.rejects(assertCanDelegateRole(f.client, { actorID: "actor", realmID: "realm", role: { id: 9, realm_id: "foreign" }, targetMemberID: "target" }, f.checkPermission));
  const owner = fixture({ targetTier: "owner" });
  await assert.rejects(assertCanDelegateRole(owner.client, { actorID: "actor", realmID: "realm", role: { id: 9, realm_id: "realm" }, targetMemberID: "target" }, owner.checkPermission), error => error.status === 403);
});

test("explicit administration protects a custom-role holder from peer changes", async () => {
  const { assertCanDelegateRole } = await policy();
  const f = fixture({ tier: "admin", explicitTargetAdmin: true });
  await assert.rejects(assertCanDelegateRole(f.client, { actorID: "actor", realmID: "realm", role: { id: 9, realm_id: "realm" }, targetMemberID: "target" }, f.checkPermission), error => error.status === 403);
});

test("custom administrative members have the same peer-removal protection", async () => {
  const helpers = await policy();
  assert.equal(typeof helpers.assertCanRemoveMembers, "function");
  const f = fixture({ tier: "admin", explicitTargetAdmin: true });
  await assert.rejects(helpers.assertCanRemoveMembers(f.client, { actorID: "actor", realmID: "realm", entityIDs: ["recipient"] }, f.checkPermission), error => error.status === 403);
});

test("ordinary self-leave stays allowed while the last owner must transfer", async () => {
  const helpers = await policy();
  assert.equal(typeof helpers.assertCanRemoveMembers, "function");
  const member = fixture({ tier: "member" });
  await helpers.assertCanRemoveMembers(member.client, { actorID: "actor", realmID: "realm", entityIDs: ["actor"] }, async () => false);
  const owner = fixture();
  await assert.rejects(helpers.assertCanRemoveMembers(owner.client, { actorID: "actor", realmID: "realm", entityIDs: ["actor"] }, owner.checkPermission), error => error.code === "OWNERSHIP_TRANSFER");
});

test("an explicit transfer grant does not turn a nonowner into an owner", async () => {
  const helpers = await policy();
  assert.equal(typeof helpers.assertCanTransferOwnership, "function");
  const admin = fixture({ tier: "admin" });
  await assert.rejects(helpers.assertCanTransferOwnership(admin.client, { actorID: "actor", realmID: "realm" }, admin.checkPermission), error => error.status === 403);
});
