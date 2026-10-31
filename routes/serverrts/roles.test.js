const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { resolveRole, realmOwnerRoleID } = require("../../reusables/models/roles");

function route(path, query) {
  let handler;
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf(`router.put("${path}"`);
  const next = source.indexOf("router.put(", start + 1);
  const end = next < 0 ? source.indexOf("module.exports", start) : next;
  vm.runInNewContext(source.slice(start, end), {
    router: { put(_path, _jwt, callback) { handler = callback; } }, jwtchecker() {},
    hasPermission: async () => true, resolveRole, realmOwnerRoleID,
    pool: { query }, publish() {}, console,
  });
  return async (body) => {
    const response = { status(code) { this.code = code; return this; }, send(value) { this.body = value; } };
    await handler({ params: { entity_id: "actor" }, body: { realm_id: "realm", member_id: "target", ...body } }, response);
    return response;
  };
}

test("role change writes the explicitly selected duplicate-name definition", async () => {
  let updated;
  const run = route("/update-member-realm-role", async (sql, values) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "77", name: "member", is_default: false }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: [{}] };
    if (sql.includes("SELECT r.name AS role")) return { rows: [{ role: "member" }] };
    if (sql.includes("UPDATE community_member")) { updated = { sql, values }; return { rows: [{ member_id: "target" }] }; }
    return { rows: [] };
  });
  const response = await run({ new_role_id: "77" });
  assert.equal(response.body.status, true);
  assert.match(updated.sql, /SET role_id = \$1/);
  assert.equal(updated.values[0], "77");
});

test("role change checks the selected role name before allowing owner assignment", async () => {
  const run = route("/update-member-realm-role", async (sql) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "88", name: "owner", is_default: false }] };
    assert.fail("owner assignment must not reach membership queries");
  });
  const response = await run({ new_role_id: "88" });
  assert.equal(response.code, 400);
});

test("an exact role ID cannot demote the current owner outside ownership transfer", async () => {
  const run = route("/update-member-realm-role", async (sql) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "77", name: "member", is_default: false }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: [{}] };
    if (sql.includes("SELECT r.name AS role")) return { rows: [{ role: "owner" }] };
    if (sql.includes("UPDATE")) assert.fail("owner must not be demoted");
    return { rows: [] };
  });
  const response = await run({ new_role_id: "77" });
  assert.equal(response.code, 400);
  assert.match(response.body.message, /ownership transfer/);
});

test("ownership transfer preserves the exact outgoing owner role definition", async () => {
  let updated;
  const run = route("/transfer-realm-ownership", async (sql, values) => {
    if (sql.includes("WHERE member_id = $1")) return { rows: [{ entity_id: "target-entity", role: "member", role_id: "3" }] };
    if (sql.includes("SELECT DISTINCT m.role_id")) return { rows: [{ role_id: "89" }] };
    if (sql.includes("FROM entity_role WHERE name")) return { rows: [{ id: "2", name: "admin", is_default: true }] };
    if (sql.includes("UPDATE community_member")) { updated = { sql, values }; return { rows: [] }; }
    return { rows: [] };
  });
  const response = await run({});
  assert.equal(response.body.status, true);
  assert.match(updated.sql, /SET role_id = CASE/);
  assert.ok(updated.values.includes("89"));
  assert.ok(updated.values.includes("2"));
});
