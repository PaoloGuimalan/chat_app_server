const mongoose = require("mongoose")

const usermessage = mongoose.Schema({
    messageID: { type: mongoose.Schema.Types.Mixed, require: true },
    conversationID: { type: mongoose.Schema.Types.Mixed, require: true },
    pendingID: { type: mongoose.Schema.Types.Mixed, require: true },
    sender: { type: mongoose.Schema.Types.Mixed, require: true },
    receivers: [{ type: mongoose.Schema.Types.Mixed, require: true }],
    seeners: [{ type: mongoose.Schema.Types.Mixed, require: true }],
    content: { type: mongoose.Schema.Types.Mixed, require: true },
    messageDate: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    isReply: { type: Boolean, require: true },
    replyingTo: { type: mongoose.Schema.Types.Mixed, require: true },
    reactions: [{ type: mongoose.Schema.Types.Mixed, require: true }],
    isDeleted: { type: Boolean, require: true },
    messageType: { type: mongoose.Schema.Types.Mixed, require: true },
    conversationType: { type: mongoose.Schema.Types.Mixed, require: true }
})

module.exports = mongoose.model("UserMessage", usermessage, "messages")