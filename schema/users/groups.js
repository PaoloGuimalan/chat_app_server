const mongoose = require("mongoose")

const usergroups = mongoose.Schema({
    groupID: { type: mongoose.Schema.Types.Mixed, require: true },
    groupName: { type: mongoose.Schema.Types.Mixed, require: true },
    dateCreated: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    createdBy: {type: mongoose.Schema.Types.Mixed, require: true},
    type: { type: mongoose.Schema.Types.Mixed, require: true }
})

module.exports = mongoose.model("UserGroups", usergroups, "groups")