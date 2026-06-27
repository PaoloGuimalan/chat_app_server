const mongoose = require("mongoose");

const conversation = mongoose.Schema(
  {
    conversationID: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      unique: true,
      index: true,
    },
    conversationType: {
      type: String,
      default: "single", // single, group, server (channel), conference
      index: true,
    },
    senderType: {
      type: mongoose.Schema.Types.Mixed,
      default: "user", // user, bot, realm
    },
    authorRealm: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    participant_ids: [
      {
        type: mongoose.Schema.Types.Mixed,
      },
    ],
    last_message: {
      messageID: { type: mongoose.Schema.Types.Mixed, default: null },
      sender: { type: mongoose.Schema.Types.Mixed, default: null },
      text: { type: mongoose.Schema.Types.Mixed, default: "" },
      messageDate: { type: Date, default: Date.now, index: true },
      seeners: [{ type: mongoose.Schema.Types.Mixed, default: [] }],
      messageType: { type: mongoose.Schema.Types.Mixed, default: "text" }, // text, image, video, file, notif
      isDeleted: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

conversation.index({
  participant_ids: 1,
  "last_message.timestamp": -1,
});

module.exports = mongoose.model("Conversation", conversation, "conversations");

