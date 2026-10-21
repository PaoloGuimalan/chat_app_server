const UserMessage = require("../../schema/messages/message");
const ChatHistory = require("../../schema/messages/chathistory");
const { REPLIED_MESSAGE_LOOKUP } = require("../hooks/replyTargets");

// Let Mongo parse legacy string dates exactly as the original history lookup
// did. Keep the original document too: historySetting is part of the response.
const clearedAtExpression = (field) => ({
  $ifNull: [
    {
      $cond: {
        if: { $eq: [{ $type: field }, "string"] },
        then: { $dateFromString: { dateString: field } },
        else: field,
      },
    },
    new Date(0),
  ],
});

const getHistorySettings = (entityID, conversationID) =>
  ChatHistory.aggregate([
    { $match: { entityID, conversationID } },
    // Mixed ids can contain arrays. Ordinary equality matches their elements;
    // the original lookup required equality with the entire stored value.
    {
      $match: {
        $expr: {
          $and: [
            { $eq: ["$entityID", entityID] },
            { $eq: ["$conversationID", conversationID] },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        historySetting: "$$ROOT",
        clearedAt: clearedAtExpression("$cleared_at"),
      },
    },
  ]);

const messageSelection = (conversationID, histories) => {
  if (histories.length <= 1) {
    return [{
      $match: {
        conversationID,
        messageDate: { $gt: histories[0]?.clearedAt ?? new Date(0) },
      },
    }];
  }

  // The old lookup/unwind returned one copy per matching history record.
  // Preserve that behavior for existing duplicates without repeating a
  // collection lookup for every message. The normal single-record path above
  // can use the conversation/date index for both filtering and sorting.
  return [
    { $match: { conversationID } },
    { $set: { historySetting: { $literal: histories.map((row) => row.historySetting) } } },
    { $unwind: "$historySetting" },
    {
      $match: {
        $expr: { $gt: ["$messageDate", clearedAtExpression("$historySetting.cleared_at")] },
      },
    },
  ];
};

const countMessages = async (selection, histories) => {
  if (histories.length <= 1) {
    return UserMessage.countDocuments(selection[0].$match);
  }
  const result = await UserMessage.aggregate([...selection, { $count: "totalCount" }]);
  return result[0]?.totalCount ?? 0;
};

const GetAllMessageCountInAConversation = async (entityID, conversationID) => {
  const histories = await getHistorySettings(entityID, conversationID);
  return countMessages(messageSelection(conversationID, histories), histories);
};

const GetConversationMessages = async (entityID, conversationID, page, range) => {
  const histories = await getHistorySettings(entityID, conversationID);
  const selection = messageSelection(conversationID, histories);
  const total = await countMessages(selection, histories);
  const messages = await UserMessage.aggregate([
    ...selection,
    // Millisecond ordering across Node and worker writers; _id breaks ties
    // consistently so pagination retains the existing order.
    { $sort: { messageDate: -1, _id: -1 } },
    { $skip: (parseInt(page) - 1) * parseInt(range) },
    { $limit: parseInt(range) },
    ...(histories.length > 1 ? [] : [{
      $set: {
        historySetting: histories.length
          ? { $literal: histories[0].historySetting }
          : "$$REMOVE",
      },
    }]),
    REPLIED_MESSAGE_LOOKUP,
    {
      $project: {
        "reactionsWithInfo._id": 0,
        "reactionsWithInfo.birthdate": 0,
        "reactionsWithInfo.gender": 0,
        "reactionsWithInfo.email": 0,
        "reactionsWithInfo.password": 0,
        "reactionsWithInfo.dateCreated": 0,
      },
    },
  ]);
  return { messages, total };
};

module.exports = {
  GetAllMessageCountInAConversation,
  GetConversationMessages,
};
