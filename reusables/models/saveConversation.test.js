/**
 * SaveConversation is ONE atomic upsert. It used to read the conversation,
 * change it and save it - and that save carried a version number, so several
 * at once (a batch of files, two people writing together) all read the same
 * version and every save after the first failed with a VersionError.
 *
 * Run with:  node --test reusables/models/saveConversation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Conversation = require("../../schema/messages/conversation");
const { SaveConversation, AddNewMemberToContacts } = require("./messages");
const pool = require("../database/postgres");

test.beforeEach((t) => {
  t.mock.method(pool, "query", async () => ({ rows: [] }));
});

test("a community participant cannot create or update a conversation", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [{ type: "community" }] }));
  t.mock.method(Conversation, "findOneAndUpdate", () => assert.fail("must not write a conversation"));
  await assert.rejects(
    SaveConversation("ordinary-group", "group", "user", null, ["community-entity"]),
    /Communities do not support messaging/,
  );
});

test("adding a community entity to an ordinary group is rejected before membership insertion", async (t) => {
  const queries = [];
  t.mock.method(pool, "query", async (sql, params) => {
    queries.push(sql);
    return { rows: params[0].includes("community-entity") ? [{ type: "community" }] : [] };
  });
  await assert.rejects(AddNewMemberToContacts("ordinary-group", "community-entity", "actor"), /messaging/);
  assert.equal(queries.some((sql) => sql.includes("INSERT")), false);
});

const capture = () => {
  const calls = [];
  Conversation.findOneAndUpdate = async (filter, update, options) => {
    calls.push({ filter, update, options });
    return {};
  };
  Conversation.findOne = () => {
    throw new Error("SaveConversation must not read-modify-save");
  };
  return calls;
};

test("a new last message is one upsert, never a versioned save", async () => {
  const calls = capture();
  await SaveConversation("conv1", "group", "user", null, ["e1", "e2", "e1"], "m1", "e1", "hi");
  const [{ filter, update, options }] = calls;
  assert.deepEqual(filter, { conversationID: "conv1" });
  assert.deepEqual(options, { upsert: true, new: true, setDefaultsOnInsert: true });
  assert.deepEqual(update.$set.participant_ids, ["e1", "e2"]);
  assert.equal(update.$set.last_message.messageID, "m1");
  assert.deepEqual(update.$set.last_message.seeners, []);
});

test("no participants given leaves the stored ones alone", async () => {
  const calls = capture();
  await SaveConversation("conv1", "single", "user", null, [], "m2", "e1", "x");
  assert.equal("participant_ids" in calls[0].update.$set, false);
});

test("ten at once all go through", async () => {
  const calls = capture();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      SaveConversation("conv1", "group", "user", null, ["e1"], `m${i}`, "e1", "f"),
    ),
  );
  assert.equal(calls.length, 10);
});
