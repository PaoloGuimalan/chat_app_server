const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const roles = require("../models/roles");

function resolver({ memberRole = "11", owners = [], self = false, globalPermission = null, override = null, accountActive = true, entityType = null } = {}) {
  const cache = new Map();
  const pool = { query: async (sql) => {
    if (sql.includes("SELECT codename, scope")) return { rows: [{ codename: entityType ? "module.test" : globalPermission || "realm.test", scope: entityType ? "entity_type" : globalPermission ? "global" : "realm", is_active: true }] };
    if (sql.includes("SELECT ep.effect")) return { rows: override == null ? [] : [{ effect: override }] };
    if (sql.includes("SELECT is_active FROM user_account")) return { rows: accountActive == null ? [] : [{ is_active: accountActive }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: self ? [{}] : [] };
    if (sql.includes("SELECT DISTINCT m.role_id")) return { rows: owners.map(role_id => ({ role_id })) };
    if (sql.includes("FROM entity_role WHERE name")) return { rows: [{ id: "11", name: "owner", is_default: true }] };
    if (sql.includes("SELECT role_id FROM community_member")) return { rows: [{ role_id: memberRole }] };
    if (sql.includes("FROM entity_role_permissions")) return { rows: [{ role_id: "11", codename: "realm.test" }] };
    if (sql.includes("SELECT type FROM entity_entity")) return { rows: [{ type: entityType }] };
    if (sql.includes("FROM entity_permission_catalog_entity_types")) {
      assert.match(sql, /JOIN entity_type et ON et.id = links.entity_type_id/);
      assert.match(sql, /JOIN entity_permission_catalog pce ON pce.id = links.permission_id/);
      assert.match(sql, /WHERE pce.is_active = true/);
      return { rows: [{ entity_type: "user", codename: "module.test" }] };
    }
    throw new Error(sql);
  } };
  const context = { module: { exports: {} }, console, require(name) {
    if (name === "redis") return { createClient: () => ({ on() {}, async connect() {}, async get(k) { return cache.get(k); }, async set(k,v) { cache.set(k,v); } }) };
    if (name === "../database/postgres") return pool;
    if (name === "../models/roles") return roles;
    if (name === "../vars/redis") return {};
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("./permissionChecker"), "utf8"), context);
  return { checker: context.module.exports, cache };
}

test("duplicate-name roles do not share grants and use the v2 identity cache", async () => {
  const first = resolver({ memberRole: "11" });
  assert.equal(await first.checker.hasPermission("actor", "realm.test", "realm"), true);
  assert.ok(first.cache.has("permcache:role_matrix:v2"));
  const second = resolver({ memberRole: "12" });
  assert.equal(await second.checker.hasPermission("actor", "realm.test", "realm"), false);
});

test("self realm follows its exact owner role and fails closed on distinct owner definitions", async () => {
  for (const [owners, expected] of [[["11"], true], [["12"], false], [["11", "12"], false], [[], true]]) {
    const { checker } = resolver({ self: true, owners });
    assert.equal(await checker.hasPermission("realm-entity", "realm.test", "realm"), expected);
  }
});

test("custom global capabilities require explicit grants, including for entities without accounts", async () => {
  for (const accountActive of [true, false, null]) {
    for (const [override, expected] of [[null, false], ["grant", true], ["deny", false]]) {
      const { checker } = resolver({ globalPermission: "recovered.custom.action", override, accountActive });
      assert.equal(await checker.hasPermission("actor", "recovered.custom.action"), expected);
    }
  }
});

test("developer API globals default to denied while messages.send keeps its account-standing default", async () => {
  for (const globalPermission of ["messages.read", "notifications.read", "events.subscribe"]) {
    const { checker } = resolver({ globalPermission, accountActive: null });
    assert.equal(await checker.hasPermission("bot", globalPermission), false);
  }
  for (const [accountActive, expected] of [[true, true], [false, false], [null, true]]) {
    const { checker } = resolver({ globalPermission: "messages.send", accountActive });
    assert.equal(await checker.hasPermission("actor", "messages.send"), expected);
  }
});

test("entity type defaults resolve catalogue M2M links through numeric entity type IDs", async () => {
  for (const [entityType, expected] of [["user", true], ["bot", false], ["realm", false]]) {
    const { checker, cache } = resolver({ entityType });
    assert.equal(await checker.hasPermission("actor", "module.test"), expected);
    assert.equal(cache.get("permcache:entity_type_matrix:v1"), JSON.stringify({ user: ["module.test"] }));
  }
});
