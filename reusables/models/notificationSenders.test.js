const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeCommunityNotifications } = require("./communityNotifications");

test("notification senders retain community kind without changing page identities", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../routes/users/index.js"),
    "utf8",
  );
  const start = source.indexOf("const enrichNotificationSenders =");
  const end = source.indexOf("const attachNotificationSenders =", start);
  let query;
  const resolve = vm.runInNewContext(
    `${source.slice(start, end)}; enrichNotificationSenders;`,
    {
      normalizeCommunityNotifications: require("./communityNotifications").normalizeCommunityNotifications,
      pool: {
        query: async (sql) => {
          query = sql;
          return {
            rows: ["community", "page"].map((kind) => ({
              entity_id: kind,
              type: "realm",
              realm_type: kind,
              display_name: kind,
              handle: kind,
              is_verified: true,
            })),
          };
        },
      },
    },
  );
  const senders = await resolve([[{ fromUserID: "community" }, { fromUserID: "page" }]]);
  assert.match(query, /r\.type AS realm_type/);
  assert.equal(senders.get("community").realm_type, "community");
  assert.equal(senders.get("page").realm_type, "page");
  assert.equal(senders.get("community").is_verified, true);
});

for (const [label, anonymous, storedActorCount, expected] of [
  ["anonymized named actors", true, 2, 1],
  ["currently named legacy community senders", false, 1, 2],
]) {
  test(`community header counts ${label} using current projected identities`, async () => {
    const source = fs.readFileSync(path.join(__dirname, "../../routes/users/index.js"), "utf8");
    const start = source.indexOf("const attachGroupedSenders =");
    const end = source.indexOf("router.get(", start);
    const attach = vm.runInNewContext(`${source.slice(start, end)}; attachGroupedSenders;`, {
      attachNotificationSenders: (items) => items,
    });
    const items = ["maya", "leo"].map((actor) => ({
      type: "post_comment", referenceID: actor, community_entity_id: "garden",
      fromUserID: anonymous ? actor : "garden", target: { type: "post", supportingID: "post" },
    }));
    const client = { query: async (sql) => ({ rows: sql.includes("FROM newsfeed_post p")
      ? [{ post_id: "post", community_entity_id: "garden", community_name: "Garden Club" }]
      : ["maya", "leo"].map((actor) => ({ kind: "comment", reference_id: actor, actor_id: actor, post_id: "post", is_anonymous: anonymous, live: true })) }) };
    await normalizeCommunityNotifications(client, items);
    const group = attach({ groups: [{ family: "community", count: 2, actorCount: storedActorCount, items }] }, new Map()).groups[0];
    assert.equal(group.actorCount, expected);
    assert.equal(group.actorCountIsSample, false);
    const truncated = attach({ groups: [{ family: "community", count: 40, actorCount: 35, items }] }, new Map()).groups[0];
    assert.equal(truncated.actorCount, expected);
    assert.equal(truncated.actorCountIsSample, true);
  });
}
