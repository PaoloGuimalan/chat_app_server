const mongoose = require("mongoose");

const statusSchema = mongoose.Schema({
    userID: {type: mongoose.Schema.Types.Mixed, required: true},
    accountStatus: {type: String, required: true},
    onlineStatus: {type: String, required: true},
    offlineStatusDate: {type: String, required: true}
})

module.exports = mongoose.model("Status", statusSchema, "status");