const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { roleTierSQL } = require("../../reusables/models/roles");
const { assertCanRemoveMembers } = require("../../reusables/models/realmRolePolicy");

function removal({ type = "community", actorTier = "owner", recipientAdmin = false, self = false } = {}) {
  const realm = { id: "realm", realm_id: "realm", type, is_active: true, entity_id: "realm-entity" };
  const transactions = [], effects = [], deleted = [];
  let open = false, handler;
  const query = async (sql, values) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { transactions.push(sql); open = sql === "BEGIN"; return { rows: [] }; }
    if (sql.includes("DELETE FROM community_member")) { deleted.push(values); return { rows: [] }; }
    if (sql.includes("WHERE parent_id")) return { rows: [{ realm_id: "text-room" }, { realm_id: "voice-room" }] };
    if (sql.includes("SELECT cm.realm_id, cr.type")) return { rows: [{ realm_id: "text-room", type: "channel" }, { realm_id: "text-room", type: "channel" }, { realm_id: "voice-room", type: "voice" }] };
    if (sql.includes("SELECT 1 FROM community_realm")) return { rows: actorTier === "owner" ? [{}] : [] };
    if (sql.includes("FROM community_realm")) return { rows: [realm] };
    if (sql.includes("FROM community_member") && sql.includes("= 'owner'")) return { rows: actorTier === "owner" ? [{ entity_id: "actor" }] : [] };
    if (sql.includes("AS tier") && Array.isArray(values[0])) return { rows: values[0].map(entity_id => ({ entity_id, tier: entity_id === "actor" ? actorTier : "member" })) };
    if (sql.includes("AS tier")) return { rows: [{ entity_id: "actor", member_id: "actor-member", tier: actorTier }] };
    if (sql.includes("AS role FROM community_member")) return { rows: [{ role: actorTier }] };
    return { rows: [] };
  };
  const client = { query, release() {} };
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf('router.delete("/remove-user"');
  vm.runInNewContext(source.slice(start, source.indexOf("module.exports", start)), {
    router: { delete(_path, _jwt, callback) { handler = callback; } }, jwtchecker() {},
    pool: { query, getPool() { return { async connect() { return client; } }; } }, roleTierSQL, assertCanRemoveMembers,
    hasPermission: async (actor, code) => actor === "recipient" ? recipientAdmin && code === "realm.roles.manage" : true,
    isRealmMember: async () => true,
    GetSenderDetails: async () => ({ handle: "actor" }),
    GetEntityHandles: async ids => new Map(ids.map(id => [id, { handle: id }])),
    SyncConversationParticipants: async id => { assert.equal(open, false, "Conversation sync must read committed membership"); effects.push(["sync", id]); },
    NotificationMessageForConversations: (...args) => { assert.equal(open, false, "Conversation notices must follow SQL commit"); effects.push(["message", ...args]); },
    publish() {}, console: { log() {}, error() {} },
  });
  return async () => {
    const response = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
    await handler({ params: { entity_id: "actor", username: "actor" }, body: { realm_id: "realm", account_ids: [self ? "actor" : "recipient"] } }, response);
    return { response, transactions, effects, deleted };
  };
}

test("community removal commits atomically without conversation side effects", async () => {
  const result = await removal()();
  assert.equal(result.response.body.status, true);
  assert.deepEqual(result.transactions, ["BEGIN", "COMMIT"]);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.effects.length, 0);
});

test("custom administrative membership cannot be removed by a peer admin", async () => {
  const result = await removal({ actorTier: "admin", recipientAdmin: true })();
  assert.equal(result.response.code, 403);
  assert.equal(result.deleted.length, 0);
  assert.deepEqual(result.transactions, ["BEGIN", "ROLLBACK"]);
});

test("ordinary group self-leave retains sync and the left message", async () => {
  const result = await removal({ type: "group", actorTier: "member", self: true })();
  assert.equal(result.response.body.status, true);
  assert.deepEqual(result.transactions, ["BEGIN", "COMMIT"]);
  assert.equal(result.effects.filter(effect => effect[0] === "sync").length, 1);
  assert.equal(result.effects.find(effect => effect[0] === "message")[4], "actor left");
});

test("server removal keeps de-duplicated channel sync and omits voice notices", async () => {
  const result = await removal({ type: "server" })();
  assert.equal(result.response.body.status, true);
  assert.deepEqual(result.transactions, ["BEGIN", "COMMIT"]);
  assert.deepEqual(result.effects.filter(effect => effect[0] === "sync").map(effect => effect[1]), ["text-room", "voice-room", "realm"]);
  assert.deepEqual(result.effects.filter(effect => effect[0] === "message").map(effect => effect[1]), ["text-room"]);
});
