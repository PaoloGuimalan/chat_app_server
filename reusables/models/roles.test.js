const test = require("node:test");
const assert = require("node:assert/strict");

test("explicit role identity is retained even with duplicate names", async () => {
  const { resolveRole } = require("./roles");
  const role = await resolveRole({ query: async (sql, values) => {
    assert.match(sql, /WHERE id = \$1/);
    assert.deepEqual(values, ["97", "realm"]);
    return { rows: [{ id: "97", name: "member", code: "member-shared-97", realm_id: "realm", is_default: false }] };
  } }, { roleID: "97", roleName: "admin", realmID: "realm" });
  assert.equal(role.id, "97");
});

test("legacy names resolve only the marked default and ambiguous defaults fail closed", async () => {
  const { resolveRole } = require("./roles");
  const client = { query: async (sql, values) => {
    assert.match(sql, /code = \$1 AND is_default = TRUE/);
    assert.deepEqual(values, ["member", "realm"]);
    return { rows: [{ id: 1, name: "member" }, { id: 2, name: "member" }] };
  } };
  await assert.rejects(resolveRole(client, { roleName: "member", realmID: "realm" }), /default role/);
});

test("an exact role ID cannot escape its owning realm", async () => {
  const { resolveRole } = require("./roles");
  const client = { query: async () => ({ rows: [{ id: "11", name: "Reviewer", code: "reviewer-a", realm_id: "a", is_default: false }] }) };
  for (const realmID of [undefined, "b"]) {
    await assert.rejects(resolveRole(client, { roleID: 11, realmID }), /realm/i);
  }
  assert.equal((await resolveRole(client, { roleID: 11, realmID: "a" })).id, "11");
});

test("display names cannot elevate custom roles and owned default identity survives rename", async () => {
  const roles = require("./roles");
  assert.equal(typeof roles.roleTier, "function");
  assert.equal(roles.roleTier({ name: "owner", code: "owner-a", realm_id: "a", is_default: false }), "member");
  assert.equal(roles.roleTier({ name: "Renamed operations", code: "admin", realm_id: "realm", is_default: true }), "admin");
  assert.equal(roles.roleTier({ name: "Display label", code: "owner", realm_id: "realm", is_default: true }), "owner");
});

test("malformed role IDs cannot fall back to a role name", async () => {
  const { resolveRole } = require("./roles");
  const client = { query: async () => assert.fail("invalid ID must not query") };
  await assert.rejects(resolveRole(client, { roleID: "1 OR 1=1", roleName: "member", realmID: "realm" }), /role ID/);
});


test("default roles are copied once into the destination realm, without resetting configured grants", async () => {
  const { ensureDefaultRoles } = require("./roles");
  assert.equal(typeof ensureDefaultRoles, "function");
  const records = new Map(), grants = new Map();
  const client = { query: async (sql, values) => {
    if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", type: "server" }] };
    if (sql.includes("INSERT INTO entity_role ")) {
      const [realm, code, name] = values;
      assert.equal(realm, "realm");
      if (records.has(code)) return { rows: [] };
      const role = { id: String(records.size + 1), realm_id: realm, code, name, is_default: true };
      records.set(code, role); return { rows: [role] };
    }
    if (sql.includes("FROM entity_role WHERE code")) return { rows: [records.get(values[0])] };
    if (sql.includes("INSERT INTO entity_role_permissions")) {
      assert.ok(!grants.has(values[0]), "never reset an existing role from a template");
      grants.set(values[0], values[1]); return { rows: [] };
    }
    throw new Error(sql);
  } };
  const first = await ensureDefaultRoles(client, "realm");
  assert.deepEqual([...records.keys()].sort(), ["admin", "member", "owner"]);
  assert.ok(grants.get(first.member.id).includes("realm.invite.create"));
  assert.ok(!grants.get(first.admin.id).includes("realm.roles.manage"));
  assert.ok(!grants.has(first.owner.id));
  grants.set(first.member.id, []);
  await ensureDefaultRoles(client, "realm");
  assert.deepEqual(grants.get(first.member.id), []);
});
