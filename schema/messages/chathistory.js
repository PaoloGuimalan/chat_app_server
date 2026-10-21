const mongoose = require("mongoose");

const chathistory = mongoose.Schema({
  conversationID: { type: mongoose.Schema.Types.Mixed, require: true },
  entityID: { type: mongoose.Schema.Types.Mixed, require: true },
  cleared_at: { type: Date, default: null },
  isArchived: { type: Boolean, default: false },
  isRestricted: { type: Boolean, default: false },
});

// Nonunique to retain existing history records and their behavior.
chathistory.index({ entityID: 1, conversationID: 1 });

module.exports = mongoose.model("ChatHistory", chathistory, "chat_history");
