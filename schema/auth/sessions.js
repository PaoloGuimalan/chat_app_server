const mongoose = require("mongoose");

const sessions = mongoose.Schema({
  sessionID: { type: mongoose.Schema.Types.Mixed, require: true },
  entityID: { type: mongoose.Schema.Types.Mixed, require: true },
  status: Boolean,
  userAgent: { type: mongoose.Schema.Types.Mixed, require: true },
  deviceType: { type: mongoose.Schema.Types.Mixed, require: true },
  deviceToken: { type: mongoose.Schema.Types.Mixed, require: true },
  browser: { type: mongoose.Schema.Types.Mixed, default: null },
  os: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: mongoose.Schema.Types.Mixed, default: null },
  lastSeen: { type: Date, default: null },
});

module.exports = mongoose.model("UserSessions", sessions, "sessions");
