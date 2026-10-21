const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const jwt = require("jsonwebtoken");

// Execute the registered endpoint with only its external services replaced;
// importing the whole router would also load media and messaging services.
function endpoint(overrides = {}) {
  const source = fs.readFileSync(require.resolve("./index"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('router.get(\n  "/initConversation/:conversationID"');
  const end = source.indexOf("\nconst sendMessageInitForGC", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const context = {
    router: { get: (_path, _auth, callback) => { handler = callback; } },
    jwtchecker: () => {},
    isRealmMember: async () => {},
    GetConversationMessages: async () => ({ messages: [], total: 0 }),
    pool: { query: async () => ({ rows: [] }) },
    hydrateReplyTargets: async () => {},
    legacyReplyingTo: (reply) => typeof reply === "string" ? reply
      : reply?.type === "message" ? reply.id : "",
    jwt, JWT_SECRET: "conversation-contract-test", console: { log: () => {} },
    ...overrides,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return async (headers = { page: "1", range: "20" }) => {
    let body;
    let status = 200;
    const res = { status: (value) => { status = value; return res; }, send: (value) => { body = value; } };
    await handler({ params: { entity_id: "viewer", conversationID: "conv" }, headers }, res);
    return { status, body: JSON.parse(JSON.stringify(body)) };
  };
}

test("conversation response retains its signed envelope, order, totals and reply fields", async () => {
  const request = endpoint({
    GetConversationMessages: async (entity, conversation, page, range) => {
      assert.deepEqual([entity, conversation, page, range], ["viewer", "conv", "2", "20"]);
      return { total: 608, messages: [
        { messageID: "newer", isDeleted: true, content: "hidden", reactions: [],
          replyingTo: { type: "post", id: "post-1" }, replyedmessage: [] },
        { messageID: "older", isDeleted: false, content: "hello", reactions: [{ entityID: "reactor" }],
          replyingTo: { type: "message", id: "quoted" },
          replyedmessage: [{ messageID: "quoted", replyingTo: { type: "message", id: "earlier" } }],
          historySetting: { cleared_at: null } },
      ] };
    },
    pool: { query: async () => ({ rows: [{ entityID: "reactor", username: "person" }] }) },
    hydrateReplyTargets: async (messages, viewer) => {
      assert.equal(viewer, "viewer");
      messages[0].replyedtarget = { type: "message", id: "quoted", status: "active" };
    },
  });
  const response = await request({ page: "2", range: "20" });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ["message", "result", "status"]);
  assert.equal(response.body.status, true);
  assert.equal(response.body.message, "OK");
  const decoded = jwt.verify(response.body.result, "conversation-contract-test");
  assert.equal(decoded.total, 608);
  assert.equal(decoded.exp - decoded.iat, 60 * 60 * 24 * 7);
  assert.deepEqual(decoded.messages, [
    { messageID: "older", isDeleted: false, content: "hello", reactions: [{ entityID: "reactor" }],
      replyingTo: "quoted", replyedmessage: [{ messageID: "quoted", replyingTo: "earlier" }],
      historySetting: { cleared_at: null }, reactionsWithInfo: [{ entityID: "reactor", username: "person" }],
      replyedtarget: { type: "message", id: "quoted", status: "active" } },
    { messageID: "newer", isDeleted: true, content: "", reactions: [],
      replyingTo: "", replyedmessage: [], reactionsWithInfo: [] },
  ]);
});

test("membership denial retains the existing 401 response and never loads messages", async () => {
  const request = endpoint({
    isRealmMember: async () => { throw new Error("You do not have access to this conversation"); },
    GetConversationMessages: async () => assert.fail("unauthorized messages must not be loaded"),
  });
  assert.deepEqual(await request(), { status: 401, body: {
    status: false, message: "You do not have access to this conversation",
  } });
});

test("query failures keep the existing error response", async () => {
  const request = endpoint({ GetConversationMessages: async () => { throw new Error("database unavailable"); } });
  assert.deepEqual(await request(), { status: 200, body: {
    status: false, message: "Error generating conversation",
  } });
});
