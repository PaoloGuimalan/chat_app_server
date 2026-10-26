const test = require("node:test");
const assert = require("node:assert/strict");
const communities = require("./communityPosts");

test("ordinary posts preserve their default identity and reject anonymity", async () => {
  const unusedDatabase = { query: () => assert.fail("ordinary posts need no scope lookup") };
  assert.equal(
    await communities.resolveCommunityDestination(unusedDatabase, "author", {}, "feed"),
    null,
  );
  await assert.rejects(
    communities.resolveCommunityDestination(unusedDatabase, "author", { is_anonymous: true }, "feed"),
    { status: 400 },
  );
});

test("anonymous flags must be booleans even when false-like", () => {
  for (const value of ["false", "true", 0, 1, null, [], {}]) {
    assert.throws(() => communities.parseAnonymousFlag(value), { status: 400 });
  }
  assert.equal(communities.parseAnonymousFlag(undefined), false);
  assert.equal(communities.parseAnonymousFlag(false), false);
  assert.equal(communities.parseAnonymousFlag(true), true);
});

test("posting in a community requires a joined active community and a feed post", async () => {
  const joined = { entity_id: "community", realm_id: "realm", is_private: true };
  const database = { query: async () => ({ rows: [joined] }) };
  const payload = { community_entity_id: "community", is_anonymous: true };
  assert.deepEqual(
    await communities.resolveCommunityDestination(database, "author", payload, "feed"),
    joined,
  );
  await assert.rejects(
    communities.resolveCommunityDestination(database, "author", payload, "moment"),
    { status: 400 },
  );
  await assert.rejects(
    communities.resolveCommunityDestination({ query: async () => ({ rows: [] }) }, "outsider", payload, "feed"),
    { status: 403 },
  );
});

test("community destination must be a single scalar entity ID", async () => {
  for (const value of [[], ["a", "b"], {}, 123, " "]) {
    await assert.rejects(
      communities.resolveCommunityDestination({}, "author", { community_entity_id: value }, "feed"),
      { status: 400 },
    );
  }
});

test("private interactions require membership; public readers can interact", () => {
  assert.throws(
    () => communities.validateCommunityInteraction({ is_private: true, is_member: false }, true),
    { status: 403 },
  );
  assert.throws(() => communities.validateCommunityInteraction(null, true), { status: 400 });
  assert.equal(communities.validateCommunityInteraction({ is_member: true }, true), true);
  assert.equal(communities.validateCommunityInteraction({ is_private: false, is_member: false }, true), true);
  assert.equal(communities.validateCommunityInteraction({ is_private: false, is_member: false }, false), false);
  assert.throws(() => communities.validateCommunityInteraction({ is_active: false, is_member: true }, false), { status: 403 });
});

test("community sharing cannot move a private post outside its destination", () => {
  const source = { entity_id: "private-community", is_private: true, is_active: true };
  assert.throws(() => communities.validateCommunityShare(source, null), { status: 403 });
  assert.throws(
    () => communities.validateCommunityShare(source, { entity_id: "other-community" }),
    { status: 403 },
  );
  assert.doesNotThrow(() => communities.validateCommunityShare(source, source));
  assert.doesNotThrow(() => communities.validateCommunityShare({ ...source, is_private: false }, null));
});
