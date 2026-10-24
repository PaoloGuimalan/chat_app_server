const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const communityPosts = require("../../reusables/models/communityPosts");

// Execute the real creation pipeline with database and queue adapters replaced.
// This exercises validation, the transaction and its side-effect ordering without
// connecting to any of the application's configured services.
function creation({
  member = true,
  communityTag = false,
  sourceCommunity = null,
  sourceOwner = "user",
  failCommit = false,
} = {}) {
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf("const createPostFromPayload =");
  const end = source.indexOf("const sendCreatePostError", start);
  const scoreSource = fs.readFileSync(
    require.resolve("../../reusables/models/posts"),
    "utf8",
  );
  const scoreStart = scoreSource.indexOf("const updateRankingScore =");
  const scoreEnd = scoreSource.indexOf("/**", scoreStart);
  const queries = [];
  const deliveries = [];
  const effects = [];
  const community = { entity_id: "community", realm_id: "realm", is_private: true };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "COMMIT" && failCommit) throw new Error("Commit failed");
      if (sql.includes("FOR SHARE OF r, m")) {
        return { rows: member ? [community] : [] };
      }
      if (sql.includes("SELECT 1 FROM community_realm")) {
        return { rows: communityTag ? [{ id: "community" }] : [] };
      }
      if (sql.includes("SELECT 1 FROM newsfeed_post")) {
        return { rows: [{ exists: 1 }] };
      }
      if (sql.includes("FROM newsfeed_posttag t")) {
        return { rows: sourceCommunity ? [sourceCommunity] : [] };
      }
      if (sql.includes("SELECT ua.username")) {
        return {
          rows: sourceOwner === "page" ? [] : [{
            username: "source-author",
            id: "source-account",
            entityID: "source-author",
          }],
        };
      }
      return { rows: [] };
    },
  };
  const context = {
    ...communityPosts,
    pool: { ...client, getPool: () => ({ connect: async () => client }), releaseClient: () => {} },
    checkPostIDExisting: async () => "post",
    makeID: () => "generated",
    generateUUID: () => "tag-id",
    isEphemeralKind: (kind) => kind !== "feed",
    EPHEMERAL_LIFETIME_MS: 86400000,
    POST_KINDS: { FEED: "feed", THOUGHT: "thought", MOMENT: "moment" },
    EPHEMERAL_AUDIENCES: ["public", "connections"],
    POST_UPLOAD_PURPOSES: ["post_media"],
    normalizeTagging: (tagging) => tagging || { isTagged: false, users: [] },
    resolveAttachable: async () => [],
    CanEntityViewPost: async () => true,
    ResolvePostPrivacyStatus: async () => "connections",
    savePostHashtags: async () => {},
    attachRecords: () => {},
    createPostScore: () => {},
    bulkFanoutToCache: (...args) => {
      assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
      deliveries.push(args);
    },
    queueContentTagging: () => {},
    logPostShare: async () => {},
    QUEUES: { UPDATE_RANKING_SCORE: "ranking" },
    publish: (queue, payload) => {
      effects.push({
        queue,
        payload,
        afterCommit: queries.some(({ sql }) => sql === "COMMIT"),
      });
    },
    interactionScoreBump: (...args) => effects.push({ social: args }),
    followerInteractionScoreBump: (...args) => effects.push({ social: args }),
    checkNotifID: async () => "notification",
    GetSenderDetails: async () => ({ handle: "author" }),
    dateGetter: () => "2026-10-25",
    timeGetter: () => "00:00:00",
    UserNotifications: class {
      constructor(payload) {
        this.payload = payload;
      }
      async save() {
        effects.push({ notification: this.payload });
      }
    },
    badRequest: (message) => Object.assign(new Error(message), { status: 400 }),
    console: { error: () => {} },
  };
  vm.runInNewContext(`${scoreSource.slice(scoreStart, scoreEnd)}
    ${source.slice(start, end)}; this.create = createPostFromPayload;`, context);
  const payload = {
    content: { references: [], data: "Community post", isShared: false },
    type: { fileType: "text", contentType: "text" },
    tagging: { isTagged: false, users: [] },
  };
  return {
    queries,
    deliveries,
    effects,
    create: async (fields = {}, kind = "feed") => {
      const result = await context.create({
        params: { entity_id: "author", id: "account" },
        decodeToken: { ...payload, ...fields },
        kind,
      });
      // The existing share callback is asynchronous; drain it before assertions.
      await new Promise(setImmediate);
      return result;
    },
  };
}

test("community creation stores the actual owner, anonymous flag and destination tag atomically", async () => {
  const app = creation();
  await app.create({ community_entity_id: "community", is_anonymous: true });
  const post = app.queries.find(({ sql }) => sql.includes("INSERT INTO newsfeed_post ("));
  assert.equal(post.params[1], "author");
  assert.equal(post.params[12], "public");
  assert.equal(post.params[16], true);
  const tag = app.queries.find(({ sql }) => sql.includes("INSERT INTO newsfeed_posttag"));
  assert.deepEqual(Array.from(tag.params), ["tag-id", "post", "community"]);
  assert.equal(app.deliveries.length, 1);
});

test("ordinary creation keeps its profile audience and a false anonymous default", async () => {
  const app = creation();
  await app.create();
  const post = app.queries.find(({ sql }) => sql.includes("INSERT INTO newsfeed_post ("));
  assert.equal(post.params[12], "connections");
  assert.equal(post.params[16], false);
  assert.equal(app.queries.some(({ sql }) => sql.includes("INSERT INTO newsfeed_posttag")), false);
});

test("nonmembers and ordinary community tags cannot create a post or trigger fanout", async () => {
  for (const [options, fields, status] of [
    [{ member: false }, { community_entity_id: "community" }, 403],
    [{ communityTag: true }, { tagging: { isTagged: true, users: ["community"] } }, 400],
  ]) {
    const app = creation(options);
    await assert.rejects(app.create(fields), { status });
    assert.equal(app.queries.some(({ sql }) => sql.includes("INSERT INTO newsfeed_post (")), false);
    assert.equal(app.deliveries.length, 0);
  }
});

const sharedContent = {
  references: [{ reference: "source-post", referenceMediaType: "post" }],
  data: "Shared post",
  isShared: true,
};

for (const sourceOwner of ["user", "page"]) {
  for (const isAnonymous of [false, true]) {
    test(`sharing a ${sourceOwner} post into a community scores its source once (anonymous: ${isAnonymous})`, async () => {
      const app = creation({ sourceOwner });
      await app.create({
        content: sharedContent,
        community_entity_id: "community",
        is_anonymous: isAnonymous,
      });
      assert.equal(app.effects.length, 1);
      assert.equal(app.effects[0].queue, "ranking");
      assert.deepEqual({ ...app.effects[0].payload }, {
        post_id: "source-post",
        update_type: "share",
        is_decrease: false,
      });
      assert.equal(app.effects[0].afterCommit, true);
    });
  }

  for (const kind of ["feed", "moment"]) {
    test(`sharing a public community ${sourceOwner} post to an ordinary ${kind} scores only its source`, async () => {
      const app = creation({
        sourceOwner,
        sourceCommunity: {
          entity_id: "source-community",
          realm_id: "source-realm",
          is_private: false,
          is_active: true,
          is_member: true,
        },
      });
      await app.create({ content: sharedContent }, kind);
      assert.equal(app.effects.length, 1);
      assert.equal(app.effects[0].queue, "ranking");
      assert.deepEqual({ ...app.effects[0].payload }, {
        post_id: "source-post",
        update_type: "share",
        is_decrease: false,
      });
      assert.equal(app.effects[0].afterCommit, true);
    });

    test(`an ordinary ${kind} share of a ${sourceOwner} post scores its source once`, async () => {
      const app = creation({ sourceOwner });
      await app.create({ content: sharedContent }, kind);
      const scores = app.effects.filter(({ queue }) => queue === "ranking");
      assert.equal(scores.length, 1);
      assert.deepEqual({ ...scores[0].payload }, {
        post_id: "source-post",
        update_type: "share",
        is_decrease: false,
      });
      assert.equal(scores[0].afterCommit, true);
      if (sourceOwner === "user") {
        assert.equal(app.effects.filter(({ social }) => social).length, 2);
        assert.equal(app.effects.filter(({ notification }) => notification).length, 1);
      }
    });
  }
}

test("rejected and uncommitted shares do not score their source", async () => {
  for (const [options, fields, status] of [
    [{ member: false }, { community_entity_id: "community" }, 403],
    [{
      sourceCommunity: {
        entity_id: "private-community",
        is_private: true,
        is_active: true,
      },
    }, {}, 403],
    [{ failCommit: true }, { community_entity_id: "community" }, 500],
  ]) {
    const app = creation(options);
    await assert.rejects(app.create({ ...fields, content: sharedContent }), { status });
    assert.deepEqual(app.effects, []);
  }
});
