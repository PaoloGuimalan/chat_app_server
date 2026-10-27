const test = require("node:test");
const assert = require("node:assert/strict");

test("updated activity summaries sort by event time while ordinary rows keep creation time", () => {
  const { notificationSortStages } = require("./communityNotifications");
  const stages = notificationSortStages();
  const converted = stages[0].$addFields._notificationSort.$convert;
  assert.deepEqual(converted.input, { $cond: [
    { $eq: ["$type", "community_admin_activity"] }, "$date.date", "$_id",
  ] });
  assert.equal(converted.to, "date");
  assert.deepEqual(stages[1], { $sort: { _notificationSort: -1, _id: -1 } });
  assert.deepEqual(stages[2], { $project: { _notificationSort: 0 } });
  assert.equal(notificationSortStages(true).length, 2);
});
const {
  notificationAudienceMatch,
  authorizedNotificationStream,
  canManageCommunityNotifications,
  normalizeCommunityNotifications,
} = require("./communityNotifications");

const matches = (filter, item) => Object.entries(filter).every(([key, value]) => {
  if (key === "$and") return value.every((part) => matches(part, item));
  if (key === "$or") return value.some((part) => matches(part, item));
  if (value && typeof value === "object") {
    if ("$in" in value) return value.$in.includes(item[key]);
    if ("$nin" in value) return !value.$nin.includes(item[key]);
    if ("$ne" in value) return item[key] !== value.$ne;
    if ("$gt" in value) return item[key] > value.$gt;
  }
  return item[key] === value;
});

const allowManagement = async () => true;

test("private community notices are filtered before notification pagination and counts", async () => {
  const match = { toUserID: "viewer", type: "post_comment" };
  const database = { query: async () => ({ rows: [{ entity_id: "private-community", member_allowed: false, management_allowed: false }] }) };
  const filter = await notificationAudienceMatch(database, match, "viewer", allowManagement);
  assert.equal(matches(filter, { ...match, fromUserID: "private-community" }), false);
  assert.equal(matches(filter, { ...match, fromUserID: "actor", community_entity_id: "private-community" }), false);
  assert.equal(matches(filter, { ...match, fromUserID: "ordinary" }), true);
});

test("join request audience excludes demoted managers while retaining their ordinary community activity", async () => {
  const database = { query: async () => ({ rows: [
    { entity_id: "managed", member_allowed: true, management_allowed: true },
    { entity_id: "demoted", member_allowed: true, management_allowed: false },
    { entity_id: "inactive", member_allowed: false, management_allowed: false },
  ] }) };
  const filter = await notificationAudienceMatch(database, { toUserID: "viewer" }, "viewer", allowManagement);
  const notice = { toUserID: "viewer", fromUserID: "requester", type: "community_join_request" };
  for (const type of ["community_join_request", "community_admin_activity"]) {
    Object.assign(notice, { activity_snapshot_version: 1, activity_count: 2, isRead: false });
    assert.equal(matches(filter, { ...notice, type, community_entity_id: "managed" }), type !== "community_join_request");
    for (const community of ["demoted", "inactive", "unknown", undefined]) {
      assert.equal(matches(filter, { ...notice, type, community_entity_id: community }), false);
    }
  }
  assert.equal(matches(filter, { ...notice, toUserID: "other", community_entity_id: "managed" }), false);
  assert.equal(matches(filter, { ...notice, type: "post_comment", community_entity_id: "demoted" }), true);
  assert.equal(matches(filter, { ...notice, type: "follow" }), true);
});

test("saved preview sentences remain immutable when read or normalized", async () => {
  for (const [count, communityName, expected] of [
    [1, "Garden Club", "Saved one activity."],
    [3, undefined, "Saved three activities."],
  ]) {
    const item = {
      type: "community_admin_activity", fromUserID: "garden", community_entity_id: "garden",
      community_name: communityName, activity_count: count, activity_revision: 8,
      content: { headline: "Community Activity", details: expected },
      target: { type: "community_notifications", supportingID: "garden-realm" },
    };
    await normalizeCommunityNotifications({ query: async () => ({ rows: [] }) }, [item]);
    assert.equal(item.content.details, expected);
    assert.equal(item.fromUserID, "garden");
    assert.equal(item.activity_revision, 8);
    assert.equal(item.is_anonymous, undefined);
  }
});

test("join request normalization preserves requester, label and management destinations", async () => {
  const item = {
    type: "community_join_request", referenceID: "invite", referenceStatus: false,
    toUserID: "manager", fromUserID: "maya", community_entity_id: "garden",
    content: { headline: "Community Join Request", details: "Maya wants to join Garden Club" },
    target: { type: "community_notifications", supportingID: "garden-realm" },
    redirects: [
      { platform: "web", type: "community_notifications", route: "/realms/garden-realm/notifications" },
      { platform: "android", type: "community_notifications", route: "/realm/garden-realm/manage/notifications" },
      { platform: "ios", type: "community_notifications", route: "/realm/garden-realm/manage/notifications" },
    ],
  };
  const expected = structuredClone(item);
  await normalizeCommunityNotifications({ query: async () => ({ rows: [] }) }, [item]);
  assert.deepEqual(item, expected);
  const { attachNotificationUx } = require("./notificationactions");
  const projected = attachNotificationUx(item);
  assert.deepEqual(projected.redirects, expected.redirects);
  assert.deepEqual(projected.actions, []);
});

test("management stream authorization reads current active community manager roles", async () => {
  for (const allowed of [true, false]) {
    const client = { query: async (sql, params) => {
      assert.deepEqual(params, ["viewer", "garden"]);
      assert.match(sql, /r\.is_active = TRUE/);
      assert.match(sql, /m\.role IN \('owner', 'admin', 'moderator'\)/);
      return { rows: allowed ? [{ id: "garden-realm", entity_id: "garden" }] : [] };
    } };
    assert.equal(await canManageCommunityNotifications(client, "viewer", "garden", allowManagement), allowed);
  }
});

test("management audience honors permission denials without hiding ordinary notices", async () => {
  const database = { query: async () => ({ rows: [
    { id: "garden-realm", entity_id: "garden", member_allowed: true, management_allowed: true },
    { id: "other-realm", entity_id: "other", member_allowed: true, management_allowed: true },
  ] }) };
  const checkPermission = async (actor, permission, realm) => {
    assert.equal(actor, "viewer");
    assert.equal(permission, "realm.request.approve");
    return realm === "other-realm";
  };
  const filter = await notificationAudienceMatch(database, { toUserID: "viewer" }, "viewer", checkPermission);
  for (const type of ["community_join_request", "community_admin_activity"]) {
    assert.equal(matches(filter, { toUserID: "viewer", type, community_entity_id: "garden" }), false);
    assert.equal(matches(filter, { toUserID: "viewer", type, community_entity_id: "other", activity_snapshot_version: 1, activity_count: 2, isRead: false }), type !== "community_join_request");
  }
  assert.equal(matches(filter, { toUserID: "viewer", type: "post_comment", community_entity_id: "garden" }), true);
});

test("management stream rejects explicit permission denial and inactive catalog access", async () => {
  const database = { query: async () => ({ rows: [{ id: "garden-realm", entity_id: "garden" }] }) };
  for (const permission of [false, true]) {
    const allowed = await canManageCommunityNotifications(database, "viewer", "garden", async (actor, name, realm) => {
      assert.deepEqual([actor, name, realm], ["viewer", "realm.request.approve", "garden-realm"]);
      return permission;
    });
    assert.equal(allowed, permission);
  }
  assert.equal(await canManageCommunityNotifications(database, "viewer", "garden", async () => {
    throw new Error("Permission catalog unavailable");
  }), false);
});

test("join request streams reauthorize each event and fail closed after demotion or errors", async () => {
  const delivered = [];
  let allowed = true;
  const stream = authorizedNotificationStream(
    { sse: (event, data) => delivered.push([event, data]) },
    async () => true,
    async (communityID) => {
      assert.equal(communityID, "garden");
      if (allowed === null) throw new Error("database unavailable");
      return allowed;
    },
  );
  const expected = [];
  for (const type of ["community_join_request", "community_admin_activity"]) {
    const payload = { message: "Community notifications changed", result: { type, community_entity_id: "garden", realm_id: "garden-realm" } };
    allowed = true;
    await stream.sse("notifications", payload);
    expected.push(["notifications", payload]);
    allowed = false;
    await stream.sse("notifications", payload);
    allowed = null;
    await stream.sse("notifications", payload);
    await authorizedNotificationStream({ sse: () => assert.fail("unguarded management event") }, async () => true).sse("notifications", payload);
  }
  assert.deepEqual(delivered, expected);
});

test("current named activity uses its actor while anonymized and deleted notices mask stale identities", async () => {
  const destinations = [{ post_id: "post", post_author_id: "owner", community_entity_id: "garden", community_name: "Garden Club" }];
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
  items[0].toUserID = "owner";
  items[1].toUserID = "owner";
  await normalizeCommunityNotifications(client, items);
  assert.equal(items[0].fromUserID, "named-actor");
  assert.equal(items[0].community_entity_id, "garden");
  assert.equal(items[0].community_name, "Garden Club");
  assert.equal(items[0].is_anonymous, false);
  assert.equal(items[0].target.anchor, "named");
  assert.equal(items[0].content.details, "@maya commented on your post in the community.");
  assert.equal(items[1].content.details, "An anonymous member reacted on your post in the community.");
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

test("personal lists exclude legacy, zero, read previews and separate join notices", async () => {
  const database = { query: async () => ({ rows: [{ id: "club", entity_id: "garden", member_allowed: true, management_allowed: true }] }) };
  const filter = await notificationAudienceMatch(database, { toUserID: "viewer" }, "viewer", allowManagement);
  const saved = { toUserID: "viewer", type: "community_admin_activity", community_entity_id: "garden", isRead: false, activity_snapshot_version: 1, activity_count: 3 };
  assert.equal(matches(filter, saved), true);
  for (const changed of [{ isRead: true }, { activity_snapshot_version: undefined }, { activity_count: 0 }, { type: "community_join_request" }]) {
    assert.equal(matches(filter, { ...saved, ...changed }), false);
  }
});

test("delivery authorization propagates resolver failures while reader authorization fails closed", async () => {
  const client = { query: async () => ({ rows: [{ id: "club", entity_id: "garden" }] }) };
  const unavailable = async () => { throw new Error("Permission database offline"); };
  assert.equal(await canManageCommunityNotifications(client, "admin", "garden", unavailable), false);
  await assert.rejects(canManageCommunityNotifications(client, "admin", "garden", unavailable, true), /Permission database offline/);
});
