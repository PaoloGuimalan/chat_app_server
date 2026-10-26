const test = require("node:test");
const assert = require("node:assert/strict");
const {
  notificationAudienceMatch,
  authorizedNotificationStream,
  normalizeCommunityNotifications,
} = require("./communityNotifications");

test("private community notices are filtered before notification pagination and counts", async () => {
  const match = { toUserID: "viewer", type: "post_comment" };
  const database = { query: async () => ({ rows: [{ entity_id: "private-community" }] }) };
  assert.deepEqual(await notificationAudienceMatch(database, match, "viewer"), {
    $and: [match, { fromUserID: { $nin: ["private-community"] } }, { community_entity_id: { $nin: ["private-community"] } }],
  });
  assert.deepEqual(
    await notificationAudienceMatch({ query: async () => ({ rows: [] }) }, match, "viewer"),
    match,
  );
});

test("current named activity uses its actor while anonymized and deleted notices mask stale identities", async () => {
  const destinations = [{ post_id: "post", community_entity_id: "garden", community_name: "Garden Club" }];
  const activities = [
    { kind: "comment", reference_id: "named", post_id: "post", actor_id: "named-actor", is_anonymous: false, live: true, handle: "maya" },
    { kind: "post_reaction", reference_id: "anonymous", post_id: "post", actor_id: "secret-actor", is_anonymous: true, live: true, handle: "secret" },
  ];
  const client = { query: async (sql) => ({ rows: sql.includes("FROM newsfeed_post p") ? destinations : activities }) };
  const items = [
    { type: "post_comment", referenceID: "named", fromUserID: "garden", target: { type: "post", supportingID: "post", anchor: "named" } },
    { type: "post_reaction", referenceID: "anonymous", fromUserID: "secret-actor", community_entity_id: "garden", content: { details: "@secret reacted" }, target: { type: "post", supportingID: "post" } },
    { type: "comment_reaction", referenceID: "deleted", fromUserID: "deleted-actor", community_entity_id: "garden", content: { details: "@deleted reacted" }, target: { type: "post", supportingID: "post" } },
    { type: "follow", referenceID: "ordinary", fromUserID: "ordinary" },
  ];
  await normalizeCommunityNotifications(client, items);
  assert.equal(items[0].fromUserID, "named-actor");
  assert.equal(items[0].community_entity_id, "garden");
  assert.equal(items[0].community_name, "Garden Club");
  assert.equal(items[0].is_anonymous, false);
  assert.equal(items[0].target.anchor, "named");
  for (const item of items.slice(1, 3)) {
    assert.equal(item.fromUserID, "garden");
    assert.equal(item.is_anonymous, true);
    assert.equal(JSON.stringify(item).includes("secret"), false);
    assert.equal(JSON.stringify(item).includes("deleted-actor"), false);
  }
  assert.deepEqual(items[3], { type: "follow", referenceID: "ordinary", fromUserID: "ordinary" });
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

test("trusted community media notices keep their community avatar and specific media description", async () => {
  const item = { type: "community_activity", fromUserID: "garden", community_entity_id: "garden", is_anonymous: false, referenceID: "media", target: { type: "post", supportingID: "media" }, content: { details: "Garden Club updated their cover photo." } };
  const comment = { type: "post_comment", referenceID: "comment", target: { type: "post", supportingID: "media" } };
  const client = { query: async (sql) => ({ rows: sql.includes("FROM newsfeed_post p") ? [{ post_id: "media", community_entity_id: "garden", community_name: "Garden Club", post_author_id: "garden", from_system: true, details: { community_media_update: true } }] : [{ kind: "comment", reference_id: "comment", post_id: "media", actor_id: "maya", is_anonymous: false, live: true, handle: "maya" }] }) };
  await normalizeCommunityNotifications(client, [item, comment]);
  assert.equal(item.fromUserID, "garden");
  assert.equal(item.is_anonymous, false);
  assert.equal(item.content.details, "Garden Club updated their cover photo.");
  assert.equal(comment.fromUserID, "maya");
});
