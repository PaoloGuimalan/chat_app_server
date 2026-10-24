const test = require("node:test");
const assert = require("node:assert/strict");
const { assertMessagingTarget, canUseMessaging } = require("./realmCapabilities");
const fs = require("node:fs");
const vm = require("node:vm");

test("communities cannot be used as conversations", () => {
  assert.equal(canUseMessaging("community"), false);
  for (const type of ["group", "channel", "conference", "single", "page", "voice"]) {
    assert.equal(canUseMessaging(type), true);
  }
});

test("community messaging is rejected before any conversation side effect", async () => {
  const database = { query: async () => ({ rows: [{ type: "community" }] }) };
  await assert.rejects(assertMessagingTarget(database, "community-id"), /messaging/);
  await assert.doesNotReject(
    assertMessagingTarget({ query: async () => ({ rows: [] }) }, "dm-id"),
  );
});

test("a Mongo-only conversation containing a community cannot authorize messaging", async () => {
  const pool = {
    query: async (_sql, params) => ({
      rows: Array.isArray(params?.[0]) && params[0].includes("community-entity")
        ? [{ type: "community" }] : [],
    }),
  };
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === "../database/postgres") return pool;
      if (name === "./messages") return { AddNewMemberToContacts: () => assert.fail("must not add members") };
      if (name === "./realmCapabilities") return { assertMessagingTarget, canUseMessaging };
      return { findOne: async () => ({ conversationType: "single", participant_ids: ["user", "community-entity"] }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./realms"), "utf8"), context);
  await assert.rejects(context.module.exports.isRealmMember("mongo-dm", "user"), /messaging/);
});
