const mongoose = require("mongoose");

const chathistory = mongoose.Schema({
  conversationID: { type: mongoose.Schema.Types.Mixed, require: true },
  userID: { type: mongoose.Schema.Types.Mixed, require: true },
  cleared_at: { type: Date, default: null },
});

module.exports = mongoose.model("ChatHistory", chathistory, "chat_history");
