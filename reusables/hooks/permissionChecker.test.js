const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const roles = require("../models/roles");

function resolver({ memberRole = "11", owners = [], self = false, globalPermission = null, override = null, accountActive = true, entityType = null, owner = false, catalogActive = true, realmType = 'page', realmTypes = ['page'], parentID = null } = {}) {
  const cache = new Map();
  const pool = { query: async (sql) => {
    if (sql.includes("SELECT code, scope")) return { rows: [{ code: entityType ? "module.test" : globalPermission || "realm.test", scope: entityType ? "entity_type" : globalPermission ? "global" : "realm", is_active: catalogActive, realm_types: realmTypes }] };
    if (sql.includes('SELECT id, entity_id, type, parent_id')) return { rows: [{ id: 'realm', entity_id: self ? 'realm-entity' : 'other', type: realmType, parent_id: parentID, is_active: true }] };
    if (sql.includes("SELECT ep.effect")) return { rows: override == null ? [] : [{ effect: override }] };
    if (sql.includes("SELECT is_active FROM user_account")) return { rows: accountActive == null ? [] : [{ is_active: accountActive }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: self ? [{}] : [] };
    if (sql.includes("SELECT DISTINCT m.role_id")) return { rows: owners.map(role_id => ({ role_id })) };
    if (sql.includes("FROM entity_role WHERE code")) return { rows: [{ id: "11", name: "owner", code: "owner", realm_id: null, is_default: true }] };
    if (sql.includes("SELECT m.role_id")) return { rows: memberRole == null ? [] : [{ role_id: memberRole, code: owner ? "owner" : "member", is_default: true }] };
    if (sql.includes("FROM entity_role_permissions")) return { rows: [{ role_id: "11", code: "realm.test" }] };
    if (sql.includes("SELECT type FROM entity_entity")) return { rows: [{ type: entityType }] };
    if (sql.includes("FROM entity_permission_catalog_entity_types")) {
      assert.match(sql, /JOIN entity_type et ON et.id = links.entity_type_id/);
      assert.match(sql, /JOIN entity_permission_catalog pce ON pce.id = links.permission_id/);
      assert.match(sql, /WHERE pce.is_active = true/);
      return { rows: [{ entity_type: "user", code: "module.test" }] };
    }
    throw new Error(sql);
  } };
  const context = { module: { exports: {} }, console, require(name) {
    if (name === "redis") return { createClient: () => ({ on() {}, async connect() {}, async get(k) { return cache.get(k); }, async set(k,v) { cache.set(k,v); } }) };
    if (name === "../database/postgres") return pool;
    if (name === "../models/roles") return roles;
    if (name === "../models/permissionApplicability") return require(name);
    if (name === "../vars/redis") return {};
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("./permissionChecker"), "utf8"), context);
  return { checker: context.module.exports, cache };
}

test("duplicate-name roles do not share grants and use a per-realm identity cache", async () => {
  const first = resolver({ memberRole: "11" });
  assert.equal(await first.checker.hasPermission("actor", "realm.test", "realm"), true);
  assert.ok(first.cache.has("permcache:role_matrix:v3:realm"));
  const second = resolver({ memberRole: "12" });
  assert.equal(await second.checker.hasPermission("actor", "realm.test", "realm"), false);
});

test('fresh global authorization reads standing through the pinned client', async () => {
  const { checker } = resolver({ globalPermission: 'posts.create', accountActive: false });
  let standingReads = 0;
  const client = { query: async sql => {
    if (sql.includes('SELECT code')) return { rows: [{ code: 'posts.create', scope: 'global', is_active: true }] };
    if (sql.includes('SELECT ep.effect')) return { rows: [] };
    if (sql.includes('SELECT is_active')) { standingReads++; return { rows: [{ is_active: true }] }; }
    throw new Error(sql);
  } };
  assert.equal(await checker.hasPermission('actor','posts.create',null,{client,fresh:true}),true);
  assert.equal(standingReads,1);
});

test("explicit realm exceptions remain available and owner cannot be locked out", async () => {
  assert.equal(await resolver({ memberRole: "12", override: "grant" }).checker.hasPermission("actor", "realm.test", "realm"), true);
  assert.equal(await resolver({ override: "deny" }).checker.hasPermission("actor", "realm.test", "realm"), false);
  assert.equal(await resolver({ memberRole: null, override: "grant" }).checker.hasPermission("actor", "realm.test", "realm"), true);
  assert.equal(await resolver({ owner: true, override: "deny" }).checker.hasPermission("actor", "realm.test", "realm"), true);
});

test("fresh permission checks do not use a stale cached role matrix", async () => {
  const { checker, cache } = resolver();
  cache.set("permcache:role_matrix:v3:realm", JSON.stringify({}));
  assert.equal(await checker.hasPermission("actor", "realm.test", "realm"), false);
  assert.equal(await checker.hasPermission("actor", "realm.test", "realm", { fresh: true }), true);
});

test("self administration holds active realm capabilities without a configurable owner grant list", async () => {
  const { checker } = resolver({ self: true, override: "deny" });
  assert.equal(await checker.hasPermission("realm-entity", "realm.test", "realm"), true);
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

test("domain guards deny disabled capabilities but still report unknown codes",async()=>{
  const {checker}=resolver({catalogActive:false});
  assert.equal(typeof checker.hasActivePermission,'function');
  await assert.rejects(checker.hasPermission('actor','realm.test','realm'),/Unknown permission/);
  assert.equal(await checker.hasActivePermission('actor','realm.test','realm'),false);
  await assert.rejects(checker.hasActivePermission('actor','realm.unknown','realm'),/Unknown permission/);
});

test("cutover ignores a warm pre-approval catalog cache", async () => {
  const current = resolver({ memberRole: "11" });
  current.cache.set("permcache:catalog:v2", "{}");
  current.cache.set("permcache:catalog:v3", "{}");
  assert.equal(await current.checker.hasPermission("actor", "realm.test", "realm"), true);
});

test('applicability precedes owner, self and explicit overrides, including fresh checks', async () => {
  for (const options of [{ owner: true }, { self: true }, { memberRole: null, override: 'grant' }]) {
    const { checker } = resolver({ ...options, realmType: 'community', realmTypes: ['page'] });
    assert.equal(await checker.hasPermission(options.self ? 'realm-entity' : 'actor', 'realm.test', 'realm'), false);
    assert.equal(await checker.hasPermission(options.self ? 'realm-entity' : 'actor', 'realm.test', 'realm', { fresh: true }), false);
  }
});
