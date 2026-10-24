const test = require("node:test");
const assert = require("node:assert/strict");
const {
  notificationAudienceMatch,
  authorizedNotificationStream,
} = require("./communityNotifications");

test("private community notices are filtered before notification pagination and counts", async () => {
  const match = { toUserID: "viewer", type: "post_comment" };
  const database = { query: async () => ({ rows: [{ entity_id: "private-community" }] }) };
  assert.deepEqual(await notificationAudienceMatch(database, match, "viewer"), {
    $and: [match, { fromUserID: { $nin: ["private-community"] } }],
  });
  assert.deepEqual(
    await notificationAudienceMatch({ query: async () => ({ rows: [] }) }, match, "viewer"),
    match,
  );
});

test("notification streams omit revoked community notices and preserve ordinary events", async () => {
  const delivered = [];
  const stream = authorizedNotificationStream(
    { sse: (event, data) => delivered.push([event, data]) },
    async () => false,
  );
  await stream.sse("notifications", { result: { post_id: "private", community_entity_id: "community" } });
  await stream.sse("session", { result: "ordinary" });
  assert.deepEqual(delivered, [["session", { result: "ordinary" }]]);
});
