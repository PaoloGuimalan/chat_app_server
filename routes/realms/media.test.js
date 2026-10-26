const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function uploadRoute({ type = "community", allowed = true, mismatch = false } = {}) {
  const source = fs.readFileSync(require.resolve("./index"), "utf8");
  const start = source.indexOf('router.post("/upload-media"');
  const end = source.indexOf('router.delete(', start);
  let handler;
  const operations = [];
  const upload = { kind: "image", fileDetails: { data: "https://storage/photo.jpg" } };
  class MediaUploadError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
  }
  const context = {
    router: { post: (_path, _auth, callback) => { handler = callback; } },
    jwtchecker: () => {},
    REALM_MEDIA_COLUMN: { profile: "profile", cover_photo: "cover_photo" },
    MediaUploadError,
    pool: { query: async () => ({ rows: [{ type, entity_id: "community" }] }) },
    hasPermission: async (entity, permission, realm) => {
      operations.push({ permission, entity, realm });
      return allowed;
    },
    resolveUploadByID: async (options) => {
      operations.push({ resolve: { ...options, purposes: Array.from(options.purposes) } });
      if (mismatch) throw new MediaUploadError("Wrong realm");
      return upload;
    },
    applyRealmMedia: async (...args) => { operations.push({ direct: args }); return upload.fileDetails.data; },
    createCommunityMediaPost: async (options) => { operations.push({ post: options }); return { postID: "post" }; },
    console: { log: () => {} },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return {
    operations,
    async request(fields = {}) {
      const response = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
      await handler({
        params: { id: "account", entity_id: "admin" },
        body: { realm_id: "realm", media_type: "profile", uploadID: "upload", caption: "Our new photo", ...fields },
      }, response);
      return response;
    },
  };
}

test("community upload creates exactly one realm-authored media post after permission and upload checks", async () => {
  const app = uploadRoute();
  const response = await app.request({ author_id: "forged", community_entity_id: "forged", is_anonymous: true });
  assert.equal(response.body.status, true);
  assert.equal(response.body.details.post_id, "post");
  assert.deepEqual(app.operations[0], { permission: "realm.media.update", entity: "admin", realm: "realm" });
  assert.deepEqual(app.operations[1].resolve, {
    accountID: "account", uploadID: "upload", purposes: ["avatar"], realmID: "realm",
  });
  const posts = app.operations.filter(({ post }) => post);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].post.realmID, "realm");
  assert.equal(posts[0].post.mediaType, "profile");
  assert.equal(posts[0].post.caption, "Our new photo");
  assert.equal(posts[0].post.author_id, undefined);
  assert.equal(app.operations.some(({ direct }) => direct), false);
});

test("pages keep their existing direct media update behavior", async () => {
  const app = uploadRoute({ type: "page" });
  const response = await app.request();
  assert.equal(response.body.status, true);
  assert.equal(app.operations.filter(({ direct }) => direct).length, 1);
  assert.equal(app.operations.some(({ post }) => post), false);
});

test("unauthorized and mismatched media never mutate a community or create posts", async () => {
  for (const options of [{ allowed: false }, { mismatch: true }]) {
    const app = uploadRoute(options);
    const response = await app.request();
    assert.equal(response.body.status, false);
    assert.equal(app.operations.some(({ post, direct }) => post || direct), false);
  }
});
