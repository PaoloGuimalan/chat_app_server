const test = require("node:test");
const assert = require("node:assert/strict");
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
