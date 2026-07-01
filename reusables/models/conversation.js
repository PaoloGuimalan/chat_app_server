const UserMessage = require("../../schema/messages/message");

const GetAllMessageCountInAConversation = async (entityID, conversationID) => {
  const result = await UserMessage.aggregate([
    {
      $match: {
        conversationID: conversationID,
      },
    },
    // --- LOOKUP HISTORY SETTING FOR THIS USER ---
    {
      $lookup: {
        from: "chat_history",
        let: { msg_conv_id: "$conversationID" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$conversationID", "$$msg_conv_id"] },
                  { $eq: ["$entityID", entityID] },
                ],
              },
            },
          },
        ],
        as: "historySetting",
      },
    },
    {
      $unwind: {
        path: "$historySetting",
        preserveNullAndEmptyArrays: true,
      },
    },
    // --- FILTER MESSAGES NEWER THAN CLEARED_AT ---
    {
      $match: {
        $expr: {
          $gt: [
            "$messageDate",
            {
              $ifNull: [
                {
                  $cond: {
                    if: {
                      $eq: [{ $type: "$historySetting.cleared_at" }, "string"],
                    },
                    then: {
                      $dateFromString: {
                        dateString: "$historySetting.cleared_at",
                      },
                    },
                    else: "$historySetting.cleared_at",
                  },
                },
                new Date(0), // If never cleared, counts all history (older than 1970)
              ],
            },
          ],
        },
      },
    },
    // --- COUNT THE REMAINING MATCHES ---
    {
      $count: "totalCount",
    },
  ]);

  return result.length > 0 ? result[0].totalCount : 0;
};

module.exports = {
  GetAllMessageCountInAConversation,
};
