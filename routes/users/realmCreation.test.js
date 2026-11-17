const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ensureDefaultRoles } = require("../../reusables/models/roles");

function creation({ failGrants = false, failBegin = false } = {}) {
  const events = [], roles = new Map();
  let hasRealm = false, released = false, create;
  const client = { release() { assert.equal(released, false); released = true; events.push("release"); }, async query(sql, values) {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      events.push(sql); if (sql === "BEGIN" && failBegin) throw new Error("begin failed"); return { rows: [] };
    }
    assert.equal(released, false);
    if (sql.includes("FROM entity_entity")) return { rows: [{ entity_id: "actor" }, { entity_id: "member" }] };
    if (sql.includes("INSERT INTO community_realm")) { hasRealm = true; events.push("realm"); return { rows: [] }; }
    if (sql.includes("FROM community_realm")) { assert.ok(hasRealm); return { rows: [{ id: "realm", type: "page" }] }; }
    if (sql.includes("INSERT INTO entity_role ")) {
      assert.ok(hasRealm); const role = { id: String(roles.size + 1), realm_id: values[0], code: values[1], name: values[2], is_default: true };
      roles.set(role.code, role); events.push(role.code); return { rows: [role] };
    }
    if (sql.includes("INSERT INTO entity_role_permissions")) {
      if (failGrants) throw new Error("grant failed"); return { rows: [] };
    }
    if (sql.includes("INSERT INTO community_member")) {
      assert.equal(values[5], roles.get("owner").id); assert.equal(values[11], roles.get("member").id);
      events.push("members"); return { rows: [] };
    }
    throw new Error(sql);
  } };
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const block = source.slice(source.indexOf("const createRealmReusable ="), source.indexOf('router.post("/createchannel"'));
  const context = { ensureDefaultRoles, pool: { getPool() { return { async connect() { return client; } }; } },
    validateProfilePath: async () => {}, assertMessagingTarget: async () => {}, uuidv4: () => "id", console: { log() {} },
    CreateEntity: async (type, pinned) => { assert.equal(pinned, client); assert.equal(events[0], "BEGIN"); return "entity"; },
    sendMessageInitForGC() { assert.equal(released, true); }, publish() { assert.equal(released, true); } };
  vm.runInNewContext(block + "\nthis.create = createRealmReusable;", context);
  create = () => context.create("actor", null, "realm", "Realm", null, null, "", "actor",
    [{ entityID: "actor" }, { entityID: "member" }], false, "page", null, "slug", false);
  return { create, events };
}

test("realm creation seeds realm roles and memberships in one pinned transaction", async () => {
  const f = creation(); await f.create();
  assert.deepEqual(f.events, ["BEGIN", "realm", "owner", "admin", "member", "members", "COMMIT", "release"]);
});
for (const failure of ["failGrants", "failBegin"]) {
  test(`realm creation releases its connection when ${failure}`, async () => {
    const f = creation({ [failure]: true }); await assert.rejects(f.create(), /failed/);
    assert.ok(!f.events.includes("COMMIT")); assert.equal(f.events.at(-1), "release");
    if (failure === "failGrants") assert.ok(f.events.includes("ROLLBACK"));
  });
}
