const mongoose = require("mongoose")

const sessions = mongoose.Schema({
    sessionID: {type: mongoose.Schema.Types.Mixed, require: true},
    userID: {type: mongoose.Schema.Types.Mixed, require: true},
    sessionStatus: Boolean,
    sessiondate: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    }
})

module.exports = mongoose.model("UserSessions", sessions, "sessions");