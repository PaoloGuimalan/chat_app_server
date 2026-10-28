const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

function notifications({
  members = ["member", "admin"], existing = false,
  failMongoAt = 0, failRedisAt = 0, failPushAt = 0, pushReturnsFalse = false,
} = {}) {
  const source = fs.readFileSync(require.resolve("./communityMediaNotifications"), "utf8");
  const start = source.indexOf("const notifyCommunityMediaUpdate =");
  const end = source.indexOf("module.exports", start);
  const rows = [];
  const events = [];
  const pushes = [];
  const stored = new Set();
  let mongoCalls = 0;
  let redisCalls = 0;
  let pushCalls = 0;
  const context = {
    createHash,
    pool: { query: async (sql, values) => {
      assert.match(sql, /JOIN community_member/);
      assert.match(sql, /p\.entity_id = r\.entity_id/);
      assert.match(sql, /r\.is_active = TRUE/);
      assert.deepEqual(Array.from(values), ["realm", "community", "post"]);
      return { rows: members.map((entity_id) => ({ entity_id })) };
    } },
    UserNotifications: { updateOne: async (filter, update, options) => {
      if (++mongoCalls === failMongoAt) throw new Error("Mongo unavailable");
      assert.equal(filter.notificationID, update.$setOnInsert.notificationID);
      assert.match(filter._id, /^[a-f0-9]{24}$/);
      assert.equal(options.upsert, true);
      if (existing || stored.has(filter._id)) return { upsertedCount: 0 };
      stored.add(filter._id);
      rows.push(update.$setOnInsert);
      return { upsertedCount: 1 };
    } },
    publish: async (...args) => {
      if (++redisCalls === failRedisAt) throw new Error("Redis unavailable");
      assert.equal(args[3].required, true);
      events.push(args);
    },
    push: { send: async (payload) => {
      if (++pushCalls === failPushAt) throw new Error("Push unavailable");
      if (pushReturnsFalse) return false;
      pushes.push(payload);
      return true;
    } },
    dateGetter: () => "2026-10-27",
    timeGetter: () => "00:00:00",
    console: { error: () => {} },
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.notify = notifyCommunityMediaUpdate;`, context);
  return {
    rows, events, pushes,
    setMembers: (ids) => { members = ids; },
    notify: () => context.notify({
      community: { realm_id: "realm", entity_id: "community", members: ["former-member"] },
      postID: "post", mediaType: "profile",
    }),
  };
}

test("media notifications address only freshly resolved members and identify the community", async () => {
  const app = notifications();
  await app.notify();
  assert.deepEqual(app.rows.map((row) => row.toUserID), ["member", "admin"]);
  for (const row of app.rows) {
    assert.equal(row.fromUserID, "community");
    assert.equal(Object.hasOwn(row, "community_entity_id"), false);
    assert.equal(row.is_anonymous, false);
    assert.equal(row.type, "community_activity");
    assert.equal(row.referenceID, "post");
    assert.deepEqual({ ...row.target }, { type: "post", supportingID: "post", anchor: null });
    assert.equal(row.content.details, "The community updated its profile photo.");
  }
  assert.deepEqual(app.events.map(([channel]) => channel), ["events_member", "events_admin"]);
  assert.equal(app.events[0][2].result.community_entity_id, "community");
  assert.equal(app.events[0][2].result.post_id, "post");
  assert.deepEqual(Array.from(app.pushes[0].entityIDs), ["member", "admin"]);
  assert.equal(app.pushes[0].communityPostID, "post");
  assert.equal(app.pushes[0].data.route, "/post/post");
  assert.equal(app.pushes[0].required, true);
  assert.equal(app.pushes[0].tag, "community-post");
  assert.equal(app.events[0][2].result.notification_id, app.rows[0].notificationID);
});

test("retrying media notification delivery preserves one row and stable announcement keys per member", async () => {
  const app = notifications();
  await app.notify();
  await app.notify();
  assert.equal(app.rows.length, 2);
  assert.equal(app.events.length, 4);
  assert.equal(app.pushes.length, 2);
  assert.equal(app.events[0][2].result.notification_id, app.events[2][2].result.notification_id);
  assert.equal(app.pushes[0].tag, app.pushes[1].tag);
});

test("empty current membership prevents all notifications", async () => {
  const app = notifications({ members: [] });
  await app.notify();
  assert.equal(app.rows.length, 0);
  assert.equal(app.events.length, 0);
  assert.equal(app.pushes.length, 0);
});

for (const failure of ["failMongoAt", "failRedisAt", "failPushAt"]) {
  test(`${failure} surfaces and retry completes delivery using existing notices and current membership`, async () => {
    const app = notifications({ [failure]: failure === "failMongoAt" ? 2 : 1 });
    await assert.rejects(app.notify());
    app.setMembers(["member", "new-member"]);
    await app.notify();
    assert.equal(new Set(app.rows.map((row) => row.notificationID)).size, app.rows.length);
    assert.ok(app.rows.some((row) => row.toUserID === "new-member"));
    const latestPush = app.pushes.at(-1);
    assert.deepEqual(Array.from(latestPush.entityIDs), ["member", "new-member"]);
    assert.equal(latestPush.communityPostID, "post");
    assert.equal(app.events.at(-2)[0], "events_member");
    assert.equal(app.events.at(-1)[0], "events_new-member");
  });
}

test("an unaccepted push publish cannot report delivery success", async () => {
  const app = notifications({ pushReturnsFalse: true });
  await assert.rejects(app.notify(), /push/i);
});
