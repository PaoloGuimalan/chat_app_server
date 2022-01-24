const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
    message_id: {type: Number, required: true},
    conversation_id: {type: mongoose.Schema.Types.Mixed, required: true},
    message: {type: mongoose.Schema.Types.Mixed},
    who_sent: {type: mongoose.Schema.Types.Mixed},
    sent_to: {type: mongoose.Schema.Types.Mixed}
})

module.exports = mongoose.model("Message", messageSchema, 'messages');