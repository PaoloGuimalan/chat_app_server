const mongoose = require("mongoose")

const userservers = mongoose.Schema({
    serverID: { type: mongoose.Schema.Types.Mixed, require: true },
    serverName: { type: mongoose.Schema.Types.Mixed, require: true },
    profile: { type: mongoose.Schema.Types.Mixed, require: true },
    dateCreated: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    members: [{type: mongoose.Schema.Types.Mixed, require: true}],
    createdBy: {type: mongoose.Schema.Types.Mixed, require: true},
    // type: { type: mongoose.Schema.Types.Mixed, require: true },
    privacy: { type: mongoose.Schema.Types.Mixed, require: true }
})

module.exports = mongoose.model("UserServers", userservers, "servers")