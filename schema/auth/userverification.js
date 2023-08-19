const mongoose = require("mongoose")

const userverification = mongoose.Schema({
    verID: {type: mongoose.Schema.Types.Mixed, require: true},
    userID: {type: mongoose.Schema.Types.Mixed, require: true},
    verCode: {type: mongoose.Schema.Types.Mixed, require: true},
    dateGenerated: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    isUsed: Boolean
})

module.exports = mongoose.model("UserVerification", userverification, "userverification")