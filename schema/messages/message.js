const mongoose = require("mongoose");

const usermessage = mongoose.Schema({
  messageID: { type: mongoose.Schema.Types.Mixed, require: true },
  conversationID: { type: mongoose.Schema.Types.Mixed, require: true },
  pendingID: { type: mongoose.Schema.Types.Mixed, require: true },
  sender: { type: mongoose.Schema.Types.Mixed, require: true },
  receivers: [{ type: mongoose.Schema.Types.Mixed, require: true }],
  seeners: [{ type: mongoose.Schema.Types.Mixed, require: true }],
  content: { type: mongoose.Schema.Types.Mixed, require: true },
  messageDate: { type: Date, default: Date.now, required: true },
  isReply: { type: Boolean, require: true },
  replyingTo: { type: mongoose.Schema.Types.Mixed, require: true },
  reactions: [{ type: mongoose.Schema.Types.Mixed, require: true }],
  isDeleted: { type: Boolean, require: true },
  messageType: { type: mongoose.Schema.Types.Mixed, require: true },
  conversationType: { type: mongoose.Schema.Types.Mixed, require: true },
  senderType: { type: mongoose.Schema.Types.Mixed, default: null },
  authorRealm: { type: mongoose.Schema.Types.Mixed, default: null },
});

module.exports = mongoose.model("UserMessage", usermessage, "messages");
