const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { resolveRole, realmOwnerRoleID, roleTier, roleTierSQL } = require("../../reusables/models/roles");
const { assertCanDelegateRole, assertCanTransferOwnership } = require("../../reusables/models/realmRolePolicy");

function route(path, query) {
  let handler;
  let leased = false, poolReadsWhileLeased = 0;
  const transactions = [];
  const runQuery = async (sql, values) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { transactions.push(sql); return { rows: [] }; }
    return query(sql, values);
  };
  const client = { query: runQuery, release() { leased = false; } };
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf(`router.put("${path}"`);
  const next = source.indexOf("router.put(", start + 1);
  const end = next < 0 ? source.indexOf("module.exports", start) : next;
  vm.runInNewContext(source.slice(start, end), {
    router: { put(_path, _jwt, callback) { handler = callback; } }, jwtchecker() {},
    hasPermission: async () => true, resolveRole, realmOwnerRoleID, roleTier, roleTierSQL, assertCanDelegateRole, assertCanTransferOwnership,
    pool: { async query(...args) { if (leased) poolReadsWhileLeased++; return runQuery(...args); }, getPool() { return { async connect() { leased = true; return client; } }; } }, publish() {}, console,
  });
  return async (body) => {
    const response = { status(code) { this.code = code; return this; }, send(value) { this.body = value; } };
    await handler({ params: { entity_id: "actor" }, body: { realm_id: "realm", member_id: "target", ...body } }, response);
    response.transactions = transactions;
    response.poolReadsWhileLeased = poolReadsWhileLeased;
    return response;
  };
}

test("role change writes the explicitly selected duplicate-name definition", async () => {
  let updated;
  const run = route("/update-member-realm-role", async (sql, values) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "77", name: "member", realm_id: "realm", is_default: false }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: [{}] };
    if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", entity_id: "realm-entity", type: "community", is_active: true }] };
    if (sql.includes("AS tier")) return { rows: [{ member_id: values[0], entity_id: values[0], tier: values[0] === "actor" ? "owner" : "member" }] };
    if (sql.includes("AS role FROM community_member")) return { rows: [{ role: "member" }] };
    if (sql.includes("UPDATE community_member")) { updated = { sql, values }; return { rows: [{ member_id: "target" }] }; }
    return { rows: [] };
  });
  const response = await run({ new_role_id: "77" });
  assert.equal(response.body.status, true);
  assert.match(updated.sql, /SET role_id = \$1/);
  assert.equal(updated.values[0], "77");
  assert.deepEqual(response.transactions, ["BEGIN", "COMMIT"]);
  assert.equal(response.poolReadsWhileLeased, 0, "Release the pinned client before post-commit pool reads");
});

test("role change rejects owner identity regardless of its display name", async () => {
  const run = route("/update-member-realm-role", async (sql) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "88", name: "Renamed owner", code: "owner", realm_id: "realm", is_default: true }] };
    if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", type: "community", is_active: true }] };
    assert.fail("owner assignment must not reach membership queries");
  });
  const response = await run({ new_role_id: "88" });
  assert.equal(response.code, 400);
});

test("an exact role ID cannot demote the current owner outside ownership transfer", async () => {
  const run = route("/update-member-realm-role", async (sql) => {
    if (sql.includes("FROM entity_role WHERE id")) return { rows: [{ id: "77", name: "member", realm_id: "realm", is_default: false }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: [{}] };
    if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", type: "community", is_active: true }] };
    if (sql.includes("AS tier")) return { rows: [{ tier: "owner", entity_id: "actor" }] };
    if (sql.includes("AS role FROM community_member")) return { rows: [{ role: "owner" }] };
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
    if (sql.includes("FROM community_realm")) return { rows: [{ id: "realm", entity_id: "realm-entity", type: "community", is_active: true }] };
    if (sql.includes("AS tier")) return { rows: [{ tier: "owner", entity_id: "actor" }] };
    if (sql.includes("WHERE member_id = $1")) return { rows: [{ entity_id: "target-entity", role: "member", role_id: "3" }] };
    if (sql.includes("SELECT DISTINCT m.role_id")) return { rows: [{ role_id: "89" }] };
    if (sql.includes("FROM entity_role WHERE code")) return { rows: [{ id: values[0] === "owner" ? "89" : "2", name: values[0], code: values[0], realm_id: "realm", is_default: true }] };
    if (sql.includes("UPDATE community_member")) { updated = { sql, values }; return { rows: [] }; }
    return { rows: [] };
  });
  const response = await run({});
  assert.equal(response.body.status, true);
  assert.match(updated.sql, /SET role_id = CASE/);
  assert.ok(updated.values.includes("89"));
  assert.ok(updated.values.includes("2"));
  assert.deepEqual(response.transactions, ["BEGIN", "COMMIT"]);
  assert.equal(response.poolReadsWhileLeased, 0);
});
