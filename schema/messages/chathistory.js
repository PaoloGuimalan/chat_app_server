const mongoose = require("mongoose");

const chathistory = mongoose.Schema({
  conversationID: { type: mongoose.Schema.Types.Mixed, require: true },
  userID: { type: mongoose.Schema.Types.Mixed, require: true },
  cleared_at: { type: Date, default: null },
  isArchived: { type: Boolean, default: false },
  isRestricted: { type: Boolean, default: false },
});

module.exports = mongoose.model("ChatHistory", chathistory, "chat_history");
