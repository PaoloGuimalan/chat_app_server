/**
 * One-off: rewrites posts that were sent into chats WITHOUT a note from the
 * old shape to the new one.
 *
 *   old: messageType "text", content "", isReply true,
 *        replyingTo { type: "post", id: <postID> }
 *   new: messageType "post", content <postID>, isReply false, replyingTo ""
 *
 * A send WITH a note stays what it is - a text reply to the post - and is
 * not touched (its content is not empty).
 *
 * Also repoints each affected conversation's `last_message` when that send
 * is still its latest message, so the list keeps reading "Sent a post" with
 * the new type. Replies that QUOTE one of these messages need nothing: they
 * point at the message id, which does not change.
 *
 * Idempotent - a converted message no longer matches the query.
 *
 * Usage:
 *   node scripts/migrateSentPostsToPostMessages.js            # dry run (default)
 *   node scripts/migrateSentPostsToPostMessages.js --apply    # writes
 */
require("dotenv").config();
const mongoose = require("mongoose");
const MongooseConnection = require("../connections/index");
const UserMessage = require("../schema/messages/message");
const Conversation = require("../schema/messages/conversation");

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

// Old-shape sends: an empty (or whitespace) text reply whose target is a post.
const OLD_SHAPE = {
  messageType: "text",
  isReply: true,
  "replyingTo.type": "post",
  "replyingTo.id": { $type: "string", $ne: "" },
  $or: [
    { content: { $exists: false } },
    { content: null },
    { content: { $regex: /^\s*$/ } },
  ],
};

async function run() {
  await mongoose.connect(MongooseConnection.url, MongooseConnection.params);
  console.log(`[post-messages] connected (${APPLY ? "APPLY" : "dry run"})`);

  const total = await UserMessage.countDocuments(OLD_SHAPE);
  console.log(`[post-messages] ${total} message(s) in the old shape`);
  if (!APPLY || total === 0) {
    const sample = await UserMessage.find(OLD_SHAPE)
      .select("messageID conversationID replyingTo messageDate")
      .limit(5)
      .lean();
    for (const m of sample) {
      console.log(
        `  e.g. ${m.messageID} in ${m.conversationID} -> post ${m.replyingTo?.id}`,
      );
    }
    if (!APPLY) console.log("[post-messages] dry run - nothing written. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let converted = 0;
  let lastMessagesFixed = 0;
  for (;;) {
    const batch = await UserMessage.find(OLD_SHAPE)
      .select("_id messageID conversationID replyingTo")
      .limit(BATCH)
      .lean();
    if (batch.length === 0) break;

    const result = await UserMessage.bulkWrite(
      batch.map((m) => ({
        updateOne: {
          // Re-checked in the filter, so a message changed since the read is
          // left alone rather than overwritten.
          filter: { _id: m._id, ...OLD_SHAPE },
          update: {
            $set: {
              messageType: "post",
              content: String(m.replyingTo.id),
              isReply: false,
              replyingTo: "",
            },
          },
        },
      })),
    );
    converted += result.modifiedCount || 0;

    const conversationFix = await Conversation.bulkWrite(
      batch.map((m) => ({
        updateOne: {
          filter: {
            conversationID: m.conversationID,
            "last_message.messageID": m.messageID,
          },
          update: {
            $set: {
              "last_message.messageType": "post",
              "last_message.text": "Sent a post",
            },
          },
        },
      })),
    );
    lastMessagesFixed += conversationFix.modifiedCount || 0;
    console.log(`[post-messages] ${converted}/${total} converted`);
  }

  console.log(
    `[post-messages] done: ${converted} message(s) converted, ${lastMessagesFixed} conversation preview(s) updated`,
  );
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[post-messages] failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
