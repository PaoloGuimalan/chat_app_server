const test = require("node:test");
const assert = require("node:assert/strict");

test("explicit role identity is retained even with duplicate names", async () => {
  const { resolveRole } = require("./roles");
  const role = await resolveRole({ query: async (sql, values) => {
    assert.match(sql, /WHERE id = \$1/);
    assert.deepEqual(values, ["97"]);
    return { rows: [{ id: "97", name: "member", is_default: false }] };
  } }, { roleID: "97", roleName: "admin" });
  assert.equal(role.id, "97");
});

test("legacy names resolve only the marked default and ambiguous defaults fail closed", async () => {
  const { resolveRole } = require("./roles");
  const client = { query: async (sql, values) => {
    assert.match(sql, /name = \$1 AND is_default = TRUE/);
    assert.deepEqual(values, ["member"]);
    return { rows: [{ id: 1, name: "member" }, { id: 2, name: "member" }] };
  } };
  await assert.rejects(resolveRole(client, { roleName: "member" }), /default role/);
});

test("malformed role IDs cannot fall back to a role name", async () => {
  const { resolveRole } = require("./roles");
  const client = { query: async () => assert.fail("invalid ID must not query") };
  await assert.rejects(resolveRole(client, { roleID: "1 OR 1=1", roleName: "member" }), /role ID/);
});
