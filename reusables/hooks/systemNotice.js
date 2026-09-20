/**
 * Saying something in a conversation as the System bot, from this service.
 *
 * WHY NODE AND NOT worker_service
 * -------------------------------
 * worker_service has PostSystemReply and uses it for a built-in command's
 * answer. This is a different moment: the message has just been parsed here,
 * and the thing worth saying - "only the first few commands ran" - is known
 * before any job is published. Publishing a job to report on the jobs would
 * mean inventing a command row for it, and would report the overflow after
 * the commands it is about.
 *
 * The send path already lives in this file's neighbours, so writing one more
 * message from here costs nothing new.
 *
 * WHAT IT DOES AND DELIBERATELY DOES NOT
 * --------------------------------------
 * Stores the message, updates the preview, un-archives the thread and fans
 * out frames - the same reduced path worker_service takes, and for the same
 * reasons. No push (nobody's phone should buzz because they typed one command
 * too many), no mention resolution, no chat score.
 *
 * NEVER THROWS. A notice about a message must not fail the message.
 */

const UserMessage = require("../../schema/messages/message");
const ChatHistory = require("../../schema/messages/chathistory");
const { SaveConversation } = require("../models/messages");
const { MessagesTrigger } = require("./sse");
const makeID = require("./makeID");

/**
 * The System bot, as every service and client agrees on it.
 *
 * A fixed id, the way the moderator has one, so nothing has to look it up or
 * carry it in config. Written by a migration in user_service
 * (bot/migrations/0004_system_bot.py), so it exists wherever the schema does.
 */
const SYSTEM_BOT_ENTITY_ID = "00000000-0000-4000-8000-000000000002";

const postSystemNotice = async ({
  conversationID,
  conversationType = "single",
  content,
  participants = [],
}) => {
  try {
    if (!conversationID || !content) return null;

    const messageID = makeID(30);
    const messageDate = new Date();

    await new UserMessage({
      messageID,
      conversationID,
      // Nothing sent this optimistically, so it gets a pendingID no client
      // can collide with.
      pendingID: `system-${messageID}`,
      sender: SYSTEM_BOT_ENTITY_ID,
      // Empty for the same reason every other path leaves it empty: readers
      // derive recipients from the conversation, and a stored list goes stale
      // the moment somebody joins.
      receivers: [],
      seeners: [],
      content,
      messageDate,
      isReply: false,
      replyingTo: "",
      reactions: [],
      isDeleted: false,
      // "text", never a new type. A client that met an unknown messageType
      // would render nothing at all.
      messageType: "text",
      conversationType,
    }).save();

    // A new message pulls the thread back out of the archive, the way any
    // other message does.
    await ChatHistory.updateMany({ conversationID }, { $set: { isArchived: false } });

    await SaveConversation(
      conversationID,
      conversationType,
      "user",
      null,
      participants,
      messageID,
      SYSTEM_BOT_ENTITY_ID,
      content,
      messageDate,
      "text",
      false,
    );

    for (const receiver of participants) {
      if (!receiver) continue;
      // `mentioner` and `command` are both null: a system notice is neither,
      // so a bot reading this frame sees an ordinary message from an entity
      // that is not addressing it - which is exactly right.
      MessagesTrigger(
        receiver,
        { conversationID, entityID: SYSTEM_BOT_ENTITY_ID, mentioner: null, command: null },
        false,
      );
    }

    return messageID;
  } catch (err) {
    console.log("[system] could not post a notice:", err?.message || err);
    return null;
  }
};

module.exports = { postSystemNotice, SYSTEM_BOT_ENTITY_ID };
