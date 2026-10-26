const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { authorizedPostStream } = require("./postActivityStream");

test("an open stream stops delivering immediately after membership is revoked", async () => {
  let allowed = true;
  let closed = 0;
  const delivered = [];
  const stream = authorizedPostStream(
    { sse: (event, data) => delivered.push([event, data]) },
    async () => allowed,
    () => { closed += 1; },
  );
  await stream.sse("post_activity", { id: "first" });
  allowed = false;
  await stream.sse("post_activity", { id: "private" });
  allowed = true;
  await stream.sse("post_activity", { id: "later" });
  assert.deepEqual(delivered, [["post_activity", { id: "first" }]]);
  assert.equal(closed, 1);
});

test("a failed access lookup closes a stream without delivering a frame", async () => {
  let closed = false;
  const stream = authorizedPostStream(
    { sse: () => assert.fail("must not send") },
    async () => { throw new Error("database unavailable"); },
    () => { closed = true; },
  );
  await stream.sse("post_activity", { entity: "secret" });
  assert.equal(closed, true);
});

test("anonymous typing reaches peers without identifying its author or echoing to them", async () => {
  const sender = [];
  const peer = [];
  const makeStream = (viewer, delivered) => authorizedPostStream(
    { sse: (event, data) => delivered.push(data) },
    async () => true,
    () => {},
    viewer,
  );
  const ownStream = makeStream("acting-page", sender);
  const peerStream = makeStream("peer", peer);
  const payload = {
    status: true,
    _sender_entity_id: "acting-page",
    result: { post_id: "post", event_type: "typing", is_anonymous: true, entity: null, parent_id: "thread" },
  };
  await ownStream.sse("post_activity", payload);
  await peerStream.sse("post_activity", payload);
  assert.equal(sender.length, 0);
  assert.deepEqual(peer, [{ status: true, result: payload.result }]);
  assert.equal(JSON.stringify(peer).includes("acting-page"), false);
  assert.equal(payload._sender_entity_id, "acting-page", "shared Redis payload remains intact for other subscribers");
});

test("named typing also suppresses the authenticated acting entity and leaves other activity intact", async () => {
  const delivered = [];
  const stream = authorizedPostStream(
    { sse: (event, data) => delivered.push(data) }, async () => true, () => {}, "page",
  );
  await stream.sse("post_activity", { result: { event_type: "typing", entity: { entity_id: "page" } } });
  await stream.sse("post_activity", { _sender_entity_id: "page", result: { event_type: "comment", comment_id: "new-comment" } });
  assert.deepEqual(delivered, [{ result: { event_type: "comment", comment_id: "new-comment" } }]);
});

test("the typing publisher supplies private routing metadata consumed before SSE delivery", async () => {
  const frames = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sse.js"), "utf8"), {
    module,
    require: (name) => name === "../redis/pubsub"
      ? { publish: (channel, event, payload) => frames.push({ channel, event, payload }) }
      : {},
  });
  module.exports.BroadcastCommentTyping("post", "secret-owner", null, "thread", true);
  assert.equal(frames[0].channel, "post_post");
  assert.equal(frames[0].payload._sender_entity_id, "secret-owner");
  const own = [];
  const peer = [];
  for (const [viewer, delivered] of [["secret-owner", own], ["peer", peer]]) {
    const stream = authorizedPostStream(
      { sse: (event, payload) => delivered.push(payload) }, async () => true, () => {}, viewer,
    );
    await stream.sse(frames[0].event, frames[0].payload);
  }
  assert.equal(own.length, 0);
  assert.equal(peer[0].result.is_anonymous, true);
  assert.equal(peer[0].result.entity, null);
  assert.equal(peer[0].result.parent_id, "thread");
  assert.equal(JSON.stringify(peer).includes("secret-owner"), false);
});
