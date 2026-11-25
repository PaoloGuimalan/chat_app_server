const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ensureDefaultRoles } = require("../../reusables/models/roles");

function creation({ failGrants = false, failBegin = false, parentActive = null, failNotice = false, type = 'page' } = {}) {
  const events = [], roles = new Map();
  let hasRealm = false, released = false, create;
  const client = { release() { assert.equal(released, false); released = true; events.push("release"); }, async query(sql, values) {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      events.push(sql); if (sql === "BEGIN" && failBegin) throw new Error("begin failed"); return { rows: [] };
    }
    assert.equal(released, false);
    if (sql.includes('FROM community_realm') && sql.includes('FOR SHARE')) return { rows: [{
      id: 'parent', type: 'server', is_active: parentActive, deletion_requested_at: null }] };
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
    validateProfilePath: async () => {}, assertMessagingTarget: async () => {}, hasPermission: async () => true,
    uuidv4: () => "id", console: { log() {} },
    CreateEntity: async (type, pinned) => { assert.equal(pinned, client); assert.equal(events[0], "BEGIN"); return "entity"; },
    async sendMessageInitForGC() { assert.equal(released, true); if (failNotice) throw new Error('notice failed'); }, publish() { assert.equal(released, true); } };
  vm.runInNewContext(block + "\nthis.create = createRealmReusable;", context);
  create = () => context.create("actor", parentActive === null ? null : 'parent', "realm", "Realm", null, null, "", "actor",
    [{ entityID: "actor" }, { entityID: "member" }], false, type, null, "slug", false);
  return { create, events };
}

test("realm creation seeds realm roles and memberships in one pinned transaction", async () => {
  const f = creation(); await f.create();
  assert.deepEqual(f.events, ["BEGIN", "realm", "owner", "admin", "member", "members", "COMMIT", "release"]);
});

test('a failed post-commit channel notice is handled without failing committed creation', async () => {
  const f = creation({ type: 'channel', parentActive: true, failNotice: true });
  await f.create();
  assert.ok(f.events.includes('COMMIT'));
  assert.ok(!f.events.includes('ROLLBACK'));
  assert.equal(f.events.at(-1), 'release');
});

test('channel creation rechecks parent state inside its transaction before inserting anything', async () => {
  const f = creation({ parentActive: false });
  await assert.rejects(f.create(), /unavailable/i);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK', 'release']);
});

test('create-channel response waits for committed creation rather than reporting premature success', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.indexOf('router.post("/createchannel"');
  const end = source.indexOf('router.post(', start + 20);
  let handler, finish, sent = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const context = {
    router: { post(_path, _auth, fn) { handler = fn; } }, jwtchecker() {},
    jwt: { verify: () => ({ serverID: 'server', otherUsers: [], privacy: true, type: 'channel', groupName: 'Channel' }) },
    JWT_SECRET: 'fixture', hasPermission: async () => true, GetServerMembers: async () => [],
    createRealmReusable: () => pending, console: { log() {} },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const request = handler({ params: { entity_id: 'actor' }, body: { token: 'fixture' } },
    { send() { sent = true; }, status() { return this; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, false);
  finish(); await request;
  assert.equal(sent, true);
});
for (const failure of ["failGrants", "failBegin"]) {
  test(`realm creation releases its connection when ${failure}`, async () => {
    const f = creation({ [failure]: true }); await assert.rejects(f.create(), /failed/);
    assert.ok(!f.events.includes("COMMIT")); assert.equal(f.events.at(-1), "release");
    if (failure === "failGrants") assert.ok(f.events.includes("ROLLBACK"));
  });
}

test('server creation commits its parent before creating default channels and replying', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.lastIndexOf('router.post(', source.indexOf('"/createserver"'));
  const end = source.indexOf('router.post("/createconference"', start);
  let handler, finishParent, sent;
  const calls = [];
  const parent = new Promise(resolve => { finishParent = resolve; });
  vm.runInNewContext(source.slice(start, end), {
    router: { post(_path, _auth, _permission, fn) { handler = fn; } },
    jwtchecker() {}, requiresPermission: () => () => {}, JWT_SECRET: 'fixture',
    jwt: { verify: () => ({ otherUsers: [], groupName: 'Server', privacy: true }) },
    checkGroupID: async () => 'server', makeID: () => 'id', console: { log() {} },
    createRealmReusable: async (...args) => {
      calls.push(args[10]);
      if (args[10] === 'server') await parent;
    },
  });
  const request = handler({ params: { entity_id: 'actor' }, body: { token: 'fixture' } },
    { send(value) { sent = value; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['server']);
  assert.equal(sent, undefined);
  finishParent(); await request;
  assert.deepEqual(calls, ['server', 'channel', 'channel', 'channel']);
  assert.equal(sent.status, true);
});
