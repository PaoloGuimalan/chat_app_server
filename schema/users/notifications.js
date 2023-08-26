const mongoose = require("mongoose")

const usernotifications = mongoose.Schema({
    notificationID: { type: mongoose.Schema.Types.Mixed, require: true },
    referenceID: { type: mongoose.Schema.Types.Mixed, require: true },
    refereceStatus: { type: Boolean, require: true },
    toUserID: { type: mongoose.Schema.Types.Mixed, require: true },
    fromUserID: { type: mongoose.Schema.Types.Mixed, require: true },
    content: {
        headline: { type: mongoose.Schema.Types.Mixed, require: true },
        details: { type: mongoose.Schema.Types.Mixed, require: true },
    },
    date: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    type: { type: mongoose.Schema.Types.Mixed, require: true }
})

module.exports = mongoose.model("UserNotifications", usernotifications, "notifications")