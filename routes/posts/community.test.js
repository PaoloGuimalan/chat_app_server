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
  mediaRealm = true,
  existingMediaPost = null,
  notificationFailures = 0,
  fanoutFailures = 0,
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
  const adminActivities = [];
  const effects = [];
  let savedMediaPost = existingMediaPost;
  let pendingMediaPost = null;
  const community = {
    entity_id: "community", realm_id: "realm", is_private: false,
    profile: "https://storage/old.jpg", cover_photo: "https://storage/old-cover.jpg",
  };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "COMMIT" && failCommit) throw new Error("Commit failed");
      if (sql === "COMMIT" && pendingMediaPost) savedMediaPost = pendingMediaPost;
      if (sql.includes("INSERT INTO newsfeed_post (") && params[15] === '{"community_media_update":true}') {
        pendingMediaPost = params[0];
      }
      if (sql.includes("SELECT p.post_id") && sql.includes("community_media_update")) {
        return { rows: savedMediaPost ? [{ post_id: savedMediaPost }] : [] };
      }
      if (sql.includes("WHERE r.realm_id = $1")) {
        return { rows: mediaRealm ? [community] : [] };
      }
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
    attachRecords: (records, target) => {
      if (records.length) effects.push({ attachment: { records, target } });
    },
    publishRelease: (releases) => effects.push({ releases }),
    notifyCommunityPostCreated: async (options) => {
      assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
      adminActivities.push(options.postID);
    },
    notifyCommunityMediaUpdate: async (options) => {
      assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
      if (notificationFailures-- > 0) throw new Error("Notification delivery failed");
      effects.push({ mediaNotification: options });
    },
    publishRequired: async (queue, payload) => {
      assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
      if (fanoutFailures-- > 0) throw new Error("Queue unavailable");
      assert.equal(queue, "fanout");
      deliveries.push([payload.current_entity_id, { ...payload.post_data }, payload.type]);
      return true;
    },
    createPostScore: () => {},
    bulkFanoutToCache: (...args) => {
      assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
      deliveries.push(args);
    },
    queueContentTagging: () => {},
    logPostShare: async () => {},
    QUEUES: { UPDATE_RANKING_SCORE: "ranking", BULK_FANOUT_TO_CACHE: "fanout" },
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
    adminActivities,
    deliveries,
    effects,
    create: async (fields = {}, kind = "feed", internal = {}) => {
      const result = await context.create({
        params: { entity_id: "author", id: "account" },
        decodeToken: { ...payload, ...fields },
        kind,
        ...internal,
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

for (const mediaType of ["profile", "cover_photo"]) {
  test(`trusted ${mediaType} updates are authored by the community and attach media to both owners`, async () => {
    const upload = { _id: "upload", fileDetails: { data: "https://storage/new.jpg" } };
    const app = creation();
    await app.create({
      community_entity_id: "community",
      content: { isShared: false, data: "New photo", references: [{
        reference: upload.fileDetails.data, referenceMediaType: "image", name: "photo.jpg",
      }] },
      type: { contentType: mediaType, fileType: "media" },
    }, "feed", { trustedCommunityMedia: { realmID: "realm", upload } });
    const posts = app.queries.filter(({ sql }) => sql.includes("INSERT INTO newsfeed_post ("));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].params[1], "community");
    assert.equal(posts[0].params[10], mediaType);
    assert.equal(posts[0].params[15], '{"community_media_update":true}');
    assert.equal(posts[0].params[16], false);
    const tags = app.queries.filter(({ sql }) => sql.includes("INSERT INTO newsfeed_posttag"));
    assert.equal(tags.length, 1);
    assert.equal(tags[0].params[2], "community");
    const updateIndex = app.queries.findIndex(({ sql }) => sql.includes("WITH target_record"));
    assert.ok(updateIndex > app.queries.findIndex(({ sql }) => sql === "BEGIN"));
    assert.ok(updateIndex < app.queries.findIndex(({ sql }) => sql === "COMMIT"));
    assert.equal(app.queries[updateIndex].params[0], "community");
    assert.equal(app.queries.filter(({ sql }) => sql.includes("newsfeed_postreference (")).length, 1);
    assert.deepEqual(app.effects.filter(({ attachment }) => attachment).map(({ attachment }) => ({
      count: attachment.records.length, target: { ...attachment.target },
    })), [
      { count: 1, target: { type: "post", id: "post" } },
      { count: 1, target: { type: "realm_media", id: "realm" } },
    ]);
    assert.equal(app.effects.filter(({ releases }) => releases).length, 1);
    const notifications = app.effects.filter(({ mediaNotification }) => mediaNotification);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].mediaNotification.community.entity_id, "community");
    assert.equal(notifications[0].mediaNotification.postID, "post");
    assert.deepEqual(Array.from(app.deliveries[0]).slice(0, 2).map((value) =>
      typeof value === "string" ? value : { ...value }), [
      "community", { id: "post", author_id: "community" },
    ]);
  });
}

test("client media authorship hints cannot impersonate a community", async () => {
  const app = creation();
  await assert.rejects(app.create({
    community_entity_id: "community",
    trustedCommunityMedia: { realmID: "realm" },
    author_id: "community",
    type: { contentType: "profile", fileType: "media" },
  }), { status: 400 });
  assert.equal(app.queries.some(({ sql }) => sql.includes("INSERT INTO newsfeed_post (")), false);
  assert.equal(app.deliveries.length, 0);
});

test("retrying a committed community media upload reuses its post and resumes delivery", async () => {
  const app = creation({ existingMediaPost: "existing-post" });
  const result = await app.create({
    type: { contentType: "profile", fileType: "media" },
    content: { isShared: false, references: [{ reference: "https://storage/new.jpg" }] },
  }, "feed", { trustedCommunityMedia: {
    realmID: "realm", upload: { _id: "upload", fileDetails: { data: "https://storage/new.jpg" } },
  } });
  assert.equal(result.postID, "existing-post");
  assert.equal(app.queries.some(({ sql }) => sql.includes("INSERT INTO newsfeed_post (")), false);
  assert.ok(app.queries.findIndex(({ sql }) => sql.includes("SELECT p.post_id")) >
    app.queries.findIndex(({ sql }) => sql.includes("FOR UPDATE OF r")));
  assert.equal(app.effects.length, 1);
  assert.equal(app.effects[0].mediaNotification.postID, "existing-post");
  assert.equal(app.deliveries.length, 1);
  assert.equal(app.deliveries[0][1].id, "existing-post");
  assert.equal(app.queries.some(({ sql }) => sql.includes("WITH target_record")), false);
});

for (const failure of ["notificationFailures", "fanoutFailures"]) {
  test(`a committed upload repairs ${failure} on retry without replacing the photo or post`, async () => {
    const app = creation({ [failure]: 1 });
    const fields = {
      type: { contentType: "profile", fileType: "media" },
      content: { isShared: false, references: [{ reference: "https://storage/new.jpg" }] },
    };
    const internal = { trustedCommunityMedia: {
      realmID: "realm", upload: { _id: "upload", fileDetails: { data: "https://storage/new.jpg" } },
    } };
    await assert.rejects(app.create(fields, "feed", internal), { status: 503 });
    assert.equal(app.queries.some(({ sql }) => sql === "ROLLBACK"), false);
    const result = await app.create(fields, "feed", internal);
    assert.equal(result.postID, "post");
    assert.equal(app.queries.filter(({ sql }) => sql.includes("INSERT INTO newsfeed_post (")).length, 1);
    assert.equal(app.queries.filter(({ sql }) => sql.includes("WITH target_record")).length, 1);
    assert.equal(app.effects.filter(({ mediaNotification }) => mediaNotification).length, 1);
    assert.ok(app.deliveries.length >= 1);
  });
}

test("failed community media commits do not attach, release or fan out uploads", async () => {
  const app = creation({ failCommit: true });
  await assert.rejects(app.create({
    type: { contentType: "profile", fileType: "media" },
    content: { isShared: false, references: [{ reference: "https://storage/new.jpg" }] },
  }, "feed", { trustedCommunityMedia: {
    realmID: "realm", upload: { _id: "upload", fileDetails: { data: "https://storage/new.jpg" } },
  } }), { status: 500 });
  assert.deepEqual(app.effects, []);
  assert.equal(app.deliveries.length, 0);
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

test("committed community posts and shares produce admin activity, ordinary/failed posts do not", async () => {
  for (const content of [undefined, sharedContent]) {
    const app = creation();
    await app.create({ community_entity_id: "community", ...(content ? { content } : {}) });
    assert.deepEqual(app.adminActivities, ["post"]);
  }
  const ordinary = creation(); await ordinary.create();
  assert.deepEqual(ordinary.adminActivities, []);
  const failed = creation({ failCommit: true });
  await assert.rejects(failed.create({ community_entity_id: "community" }));
  assert.deepEqual(failed.adminActivities, []);
});
