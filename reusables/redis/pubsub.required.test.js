const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("required live publishing rejects disconnected Redis while ordinary events remain best effort", async () => {
  const source = fs.readFileSync(require.resolve("./pubsub"), "utf8");
  const start = source.indexOf("async function publish(");
  const end = source.indexOf("async function stop_listen", start);
  const context = { publisher: null, POD_NAME: "test" };
  vm.runInNewContext(`${source.slice(start, end)}; this.send = publish;`, context);
  await context.send("events_member", "notifications", {});
  await assert.rejects(context.send("events_member", "notifications", {}, { required: true }), /Redis/);
  const sent = [];
  context.publisher = { publish: async (channel, frame) => { sent.push([channel, JSON.parse(frame)]); return 0; } };
  await context.send("events_member", "notifications", { id: "stable" }, { required: true });
  assert.equal(sent[0][1].message.id, "stable");
});
