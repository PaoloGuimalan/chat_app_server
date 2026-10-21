const test = require("node:test");
const assert = require("node:assert/strict");
const UserMessage = require("../../schema/messages/message");
const ChatHistory = require("../../schema/messages/chathistory");
const conversation = require("./conversation");

const cutoff = new Date("2026-10-01T12:00:00Z");
const historySetting = {
  _id: "history-1",
  conversationID: "conversation-1",
  entityID: "viewer-1",
  cleared_at: cutoff,
  isArchived: false,
};

function database(t, histories = []) {
  const queries = { history: [], counts: [], messages: [] };
  t.mock.method(ChatHistory, "aggregate", async (pipeline) => {
    queries.history.push(pipeline);
    return histories;
  });
  t.mock.method(UserMessage, "countDocuments", async (filter) => {
    queries.counts.push(filter);
    return 42;
  });
  t.mock.method(UserMessage, "aggregate", async (pipeline) => {
    queries.messages.push(pipeline);
    assert.ok(!pipeline.some((stage) => stage.$lookup?.from === "chat_history"),
      "history must be fetched once, not joined to every message");
    return pipeline.at(-1).$count ? [{ totalCount: 84 }] : [{ messageID: "message-1" }];
  });
  return queries;
}

test("count filters by this entity's strict cleared-history cutoff without per-message joins", async (t) => {
  const queries = database(t, [{ historySetting, clearedAt: cutoff }]);
  const total = await conversation.GetAllMessageCountInAConversation("viewer-1", "conversation-1");
  assert.equal(total, 42);
  assert.deepEqual(queries.history[0][0], {
    $match: { entityID: "viewer-1", conversationID: "conversation-1" },
  });
  assert.deepEqual(queries.counts, [{ conversationID: "conversation-1", messageDate: { $gt: cutoff } }]);
});

test("a conversation without a history record retains the epoch cutoff", async (t) => {
  const queries = database(t);
  await conversation.GetAllMessageCountInAConversation("viewer-1", "conversation-1");
  assert.deepEqual(queries.counts, [{
    conversationID: "conversation-1", messageDate: { $gt: new Date(0) },
  }]);
});

test("a page shares one history read with its count and limits before reply enrichment", async (t) => {
  const queries = database(t, [{ historySetting, clearedAt: cutoff }]);
  assert.equal(typeof conversation.GetConversationMessages, "function");
  const result = await conversation.GetConversationMessages("viewer-1", "conversation-1", "2", "20");
  assert.deepEqual(result, { messages: [{ messageID: "message-1" }], total: 42 });
  assert.equal(queries.history.length, 1);
  const pipeline = queries.messages[0];
  assert.deepEqual(pipeline.slice(0, 4), [
    { $match: { conversationID: "conversation-1", messageDate: { $gt: cutoff } } },
    { $sort: { messageDate: -1, _id: -1 } },
    { $skip: 20 },
    { $limit: 20 },
  ]);
  assert.ok(pipeline.findIndex((stage) => stage.$lookup?.from === "messages") > 3);
  assert.deepEqual(pipeline[4], { $set: { historySetting: { $literal: historySetting } } });
});

test("a page without history omits historySetting as the old unwind did", async (t) => {
  const queries = database(t);
  assert.equal(typeof conversation.GetConversationMessages, "function");
  await conversation.GetConversationMessages("viewer-1", "conversation-1", "1", "20");
  assert.deepEqual(queries.messages[0][4], { $set: { historySetting: "$$REMOVE" } });
});

test("duplicate history records preserve the old count multiplicity instead of silently choosing one", async (t) => {
  const queries = database(t, [
    { historySetting, clearedAt: cutoff },
    { historySetting: { ...historySetting, _id: "history-2", cleared_at: null }, clearedAt: new Date(0) },
  ]);
  const total = await conversation.GetAllMessageCountInAConversation("viewer-1", "conversation-1");
  assert.equal(total, 84);
  assert.equal(queries.counts.length, 0);
  assert.ok(queries.messages[0].some((stage) => stage.$unwind));
});

test("empty conversations keep an empty page and a zero total", async (t) => {
  database(t);
  t.mock.method(UserMessage, "countDocuments", async () => 0);
  t.mock.method(UserMessage, "aggregate", async () => []);
  assert.equal(typeof conversation.GetConversationMessages, "function");
  assert.deepEqual(await conversation.GetConversationMessages("viewer-1", "empty", "1", "20"), {
    messages: [], total: 0,
  });
});
