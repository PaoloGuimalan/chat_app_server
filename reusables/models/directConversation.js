/**
 * Finding - or starting - the 1:1 conversation between two entities.
 *
 * The body of POST /m/crtc, shared so that anything that must reach a person
 * or page directly (sending a post to someone you have never messaged, a reply
 * to a moment) gets the same conversation the chat UI would open, instead of
 * being limited to conversations that already exist.
 *
 * Order matters and is crtc's: a Connection's id IS its conversation id, so an
 * existing contact resolves to that first; then an existing connection-less
 * single conversation; only then is a new one created (with no last_message,
 * which keeps it out of the inbox until something is actually sent).
 */

const Conversations = require("../../schema/messages/conversation");
const makeid = require("../hooks/makeID");
const { ConnectionCheck } = require("./users");

const freshConversationID = async () => {
  for (;;) {
    const candidate = makeid(20);
    const taken = await Conversations.exists({ conversationID: candidate });
    if (!taken) return candidate;
  }
};

/**
 * Resolves { conversationID, isNew }. Throws on a missing id or a
 * conversation with yourself.
 */
const findOrCreateDirectConversation = async (entityID, otherEntityID) => {
  if (!entityID || !otherEntityID) {
    throw new Error("Missing entity identifiers for conversation creation.");
  }
  if (String(entityID) === String(otherEntityID)) {
    throw new Error("Cannot initialize a direct conversation with yourself.");
  }

  const connection = await ConnectionCheck(entityID, otherEntityID);
  if (connection) {
    return { conversationID: connection.connection_id, isNew: false };
  }

  const participants = [String(entityID), String(otherEntityID)];
  const existing = await Conversations.findOne({
    // $all + $size: exactly these two, so a group containing both never matches.
    participant_ids: { $all: participants, $size: 2 },
    conversationType: "single",
  });
  if (existing) {
    return { conversationID: existing.conversationID, isNew: false };
  }

  const created = await Conversations.create({
    conversationID: await freshConversationID(),
    participant_ids: participants,
    conversationType: "single",
    last_message: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return { conversationID: created.conversationID, isNew: true };
};

module.exports = { findOrCreateDirectConversation };
