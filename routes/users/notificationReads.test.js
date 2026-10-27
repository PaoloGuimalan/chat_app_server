const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const communityNotifications = require("../../reusables/models/communityNotifications");

function matches(filter, row) {
  return Object.entries(filter).every(([field, value]) => {
    if (field === "$and") return value.every((part) => matches(part, row));
    if (field === "$or") return value.some((part) => matches(part, row));
    if (value && typeof value === "object" && "$ne" in value) return row[field] !== value.$ne;
    return row[field] === value;
  });
}

function reader(rows) {
  let handler;
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf('router.post("/readnotifications"');
  const end = source.indexOf('router.get("/getNotifications"', start);
  vm.runInNewContext(source.slice(start, end), {
    ...communityNotifications,
    jwtchecker: () => {},
    router: { post: (_path, _auth, callback) => { handler = callback; } },
    UserNotifications: {
      updateMany: async (filter, changes) => {
        for (const row of rows) {
          if (matches(filter, row)) Object.assign(row, changes.$set || changes);
        }
        return {};
      },
    },
    CountAllUnreadNotifications: async (viewer) => rows.filter((row) => row.toUserID === viewer && !row.isRead).length,
    ReloadUserNotification: () => {},
    console: { log: () => {} },
  });
  return async (body = {}, viewer = "admin") => {
    let response;
    let status = 200;
    const res = {
      status: (code) => { status = code; return res; },
      send: (data) => { response = data; },
    };
    await handler({ params: { entity_id: viewer }, body }, res);
    return { ...response, httpStatus: status };
  };
}

const summary = (extra = {}) => ({
  notificationID: "summary", toUserID: "admin", type: "community_admin_activity",
  activity_revision: 3, isRead: false, ...extra,
});

test("legacy reads retain ordinary behavior but cannot clear unsnapshotted community summaries", async () => {
  const rows = [summary(), { notificationID: "follow", toUserID: "admin", type: "follow", isRead: false }];
  const response = await reader(rows)();
  assert.equal(rows[0].isRead, false);
  assert.equal(rows[1].isRead, true);
  assert.equal(response.totalunread, 1);
});

test("only the displayed immutable preview ID can be read, never its replacement or another admin", async () => {
  const rows = [summary({ notificationID: "new-preview" }), summary({ notificationID: "other", toUserID: "other-admin" })];
  const read = reader(rows);
  await read({ community_summaries: [{ notificationID: "old-preview" }] });
  assert.equal(rows[0].isRead, false);
  await read({ community_summaries: [{ notificationID: "new-preview" }, { notificationID: "other" }] });
  assert.equal(rows[0].isRead, true);
  assert.equal(rows[1].isRead, false);
});

test("malformed summary revisions never broaden the read operation", async () => {
  for (const snapshot of [null, {}, { notificationID: "summary", activity_revision: { $ne: 0 } },
    { notificationID: "summary", activity_revision: -1 }]) {
    const rows = [summary()];
    const response = await reader(rows)({ community_summaries: [snapshot] });
    assert.equal(rows[0].isRead, false);
    assert.equal(response.httpStatus, 400);
  }
});

test("reading personal notifications never reads the community management inbox", async () => {
  const rows = [{ notificationID: "inbox", toUserID: "admin", type: "community_admin_inbox", isRead: false }];
  await reader(rows)();
  assert.equal(rows[0].isRead, false);
});
