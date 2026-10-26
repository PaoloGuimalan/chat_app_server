const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function broker({ configured = true, failConfirm = false } = {}) {
  const pending = [];
  const messages = [];
  const channel = {
    on() {},
    assertQueue: async (queue, options) => { assert.equal(options.durable, true); },
    sendToQueue(queue, bytes, options, confirm) {
      messages.push({ queue, payload: JSON.parse(bytes.toString()), options });
      pending.push(() => confirm(failConfirm ? new Error("Broker rejected message") : null));
      return false; // Backpressure is not failure; the confirmation decides.
    },
  };
  const context = {
    process: { env: configured ? { RABBITMQ_HOST: "broker" } : {} },
    module: { exports: {} }, Buffer, console: { log() {} },
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "amqplib") return { connect: async () => ({
        on() {}, createConfirmChannel: async () => channel,
      }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./workqueue"), "utf8"), context);
  return { api: context.module.exports, pending, messages };
}

test("required durable queue publishing waits for broker confirmation despite buffer backpressure", async () => {
  const app = broker();
  let complete = false;
  const sent = app.api.publishRequired("send_push", { id: "post" }).then(() => { complete = true; });
  await new Promise(setImmediate);
  assert.equal(complete, false);
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].options.persistent, true);
  app.pending[0]();
  await sent;
  assert.equal(complete, true);
});

test("required publishing rejects missing broker configuration and negative confirmation", async () => {
  const missing = broker({ configured: false });
  await assert.rejects(missing.api.publishRequired("send_push", {}));
  const rejected = broker({ failConfirm: true });
  const sent = rejected.api.publishRequired("send_push", {});
  const assertion = assert.rejects(sent, /Broker rejected/);
  await new Promise(setImmediate);
  rejected.pending[0]();
  await assertion;
});
