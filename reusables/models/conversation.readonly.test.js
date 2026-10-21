// Opt-in Mongo integration tests. $documents supplies fixtures without inserting
// anything; autoIndex and application startup are never invoked.
// CHATTERLOOP_READONLY_TESTS=1 node --test reusables/models/conversation.readonly.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient, ObjectId } = require("mongoose").mongo;
const UserMessage = require("../../schema/messages/message");
const ChatHistory = require("../../schema/messages/chathistory");
const { GetConversationMessages } = require("./conversation");
const { REPLIED_MESSAGE_LOOKUP } = require("../hooks/replyTargets");

const enabled = process.env.CHATTERLOOP_READONLY_TESTS === "1";
const cutoff = new Date("2026-10-01T12:00:00Z");
const oid = (n) => new ObjectId(n.toString(16).padStart(24, "0"));
const message = (n, date, extra = {}) => ({
  _id: oid(n), messageID: `m${n}`, conversationID: "conv", pendingID: "",
  sender: "sender", receivers: ["viewer"], seeners: [], content: `text ${n}`,
  messageDate: new Date(date), isReply: false, replyingTo: "", reactions: [],
  isDeleted: false, messageType: "text", conversationType: "group", ...extra,
});
const messages = [
  message(1, "2026-10-01T11:59:59Z"),
  message(2, cutoff),
  message(3, "2026-10-01T12:00:01Z", { isReply: true, replyingTo: "m1" }),
  message(4, "2026-10-01T12:00:01Z", { isReply: true, replyingTo: { type: "message", id: "m2" } }),
  message(5, "2026-10-01T12:00:02Z", { isReply: true, replyingTo: { type: "post", id: "m1" } }),
  message(6, "2026-10-01T12:00:03Z", { isDeleted: true, content: "deleted text", replyingTo: null }),
  message(7, "2026-10-01T12:00:04Z", { conversationID: "other" }),
];
const history = (cleared_at) => ({
  _id: oid(100), entityID: "viewer", conversationID: "conv", cleared_at,
  isArchived: false, isRestricted: false, __v: 0,
});

// The original guard is independent of the production lookup, so a changed
// guard cannot silently change both the expected and actual reply behavior.
const legacyReplyLookup = {
  $lookup: {
    ...REPLIED_MESSAGE_LOOKUP.$lookup,
    pipeline: [
      { $match: { $expr: { $and: [
        { $gt: ["$$repliedID", ""] },
        { $eq: ["$messageID", "$$repliedID"] },
      ] } } },
      { $limit: 1 },
    ],
  },
};

function fixtureStages(stages, fixtures) {
  return stages.map((stage) => {
    if (!stage.$lookup) return stage;
    const { from, pipeline = [], ...lookup } = stage.$lookup;
    return { $lookup: { ...lookup, pipeline: [{ $documents: fixtures[from] }, ...pipeline] } };
  });
}

test("conversation queries preserve Mongo filtering, pagination, and reply behavior", { skip: !enabled }, async (t) => {
  const client = new MongoClient(require("../../connections").url, {
    serverSelectionTimeoutMS: 6000,
    appName: "chatterloop-readonly-fixture-tests",
  });
  await client.connect();
  t.after(() => client.close());
  const db = client.db();
  const aggregate = (docs, stages, fixtures = { messages }) =>
    db.aggregate([{ $documents: docs }, ...fixtureStages(stages, fixtures)], { maxTimeMS: 5000 }).toArray();

  let histories = [];
  t.mock.method(ChatHistory, "aggregate", (pipeline) => aggregate(histories, pipeline));
  t.mock.method(UserMessage, "aggregate", (pipeline) => aggregate(messages, pipeline));
  t.mock.method(UserMessage, "countDocuments", async (filter) => {
    const result = await aggregate(messages, [{ $match: filter }, { $count: "total" }]);
    return result[0]?.total ?? 0;
  });

  for (const [name, records, expectedTotal, expectedFirst, expectedHistory] of [
    ["no history", [], 6, ["m6", "m5"], false],
    ["null cutoff", [history(null)], 6, ["m6", "m5"], true],
    ["date cutoff", [history(cutoff)], 4, ["m6", "m5"], true],
    ["legacy string cutoff", [history(cutoff.toISOString())], 4, ["m6", "m5"], true],
    ["another entity's cutoff", [{ ...history(cutoff), entityID: "other" }], 6, ["m6", "m5"], false],
    ["array conversation id is not the scalar conversation", [{ ...history(cutoff), conversationID: ["conv"] }], 6, ["m6", "m5"], false],
    ["array entity id is not the scalar viewer", [{ ...history(cutoff), entityID: ["viewer"] }], 6, ["m6", "m5"], false],
    ["duplicate histories", [history(cutoff), { ...history(null), _id: oid(101) }], 10, ["m6", "m6"], true],
  ]) {
    await t.test(name, async () => {
      histories = records;
      const first = await GetConversationMessages("viewer", "conv", "1", "2");
      assert.equal(first.total, expectedTotal);
      assert.deepEqual(first.messages.map((row) => row.messageID), expectedFirst);
      if (records.length > 1) {
        // The original sort has no order between copies of the same message.
        assert.deepEqual(first.messages.map((row) => row.historySetting._id.toHexString()).sort(),
          [oid(100).toHexString(), oid(101).toHexString()]);
      } else if (expectedHistory) {
        assert.deepEqual(first.messages[0].historySetting, records[0]);
      } else {
        assert.equal("historySetting" in first.messages[0], false);
      }
      const second = await GetConversationMessages("viewer", "conv", "2", "2");
      if (records.length === 1 && records[0].cleared_at) {
        assert.deepEqual(second.messages.map((row) => row.messageID), ["m4", "m3"]);
        assert.deepEqual(second.messages.map((row) => row.replyedmessage[0].messageID), ["m2", "m1"]);
      }
      const beyond = await GetConversationMessages("viewer", "conv", "100", "2");
      assert.deepEqual(beyond, { messages: [], total: expectedTotal });
    });
  }

  await t.test("legacy and typed replies keep the original nonempty-id guard for Mixed ids", async () => {
    const foreign = [...messages,
      { _id: oid(200), messageID: null },
      { _id: oid(201), messageID: "" },
      { _id: oid(202), messageID: { legacy: true } },
    ];
    const inputs = ["m1", "", null, { type: "message", id: "m2" },
      { type: "post", id: "m1" }, { type: "message", id: { legacy: true } },
    ].map((replyingTo, n) => message(300 + n, cutoff, { replyingTo }));
    const expected = await aggregate(inputs, [legacyReplyLookup], { messages: foreign });
    const actual = await aggregate(inputs, [REPLIED_MESSAGE_LOOKUP], { messages: foreign });
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.map((row) => row.replyedmessage.length), [1, 0, 0, 1, 0, 1]);
  });

  await t.test("unknown and empty conversations retain an empty page and zero total", async () => {
    histories = [];
    assert.deepEqual(await GetConversationMessages("viewer", "unknown", "1", "20"), { messages: [], total: 0 });
  });
});
