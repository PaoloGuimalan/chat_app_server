const mongoose = require("mongoose")

const useraccount = mongoose.Schema({
    userID: {type: mongoose.Schema.Types.Mixed, require: true},
    fullname: {
        firstName: {type: mongoose.Schema.Types.Mixed, require: true},
        middleName: {type: mongoose.Schema.Types.Mixed, require: true},
        lastName: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    email: {type: mongoose.Schema.Types.Mixed, require: true},
    password: {type: mongoose.Schema.Types.Mixed, require: true}
})

module.exports = mongoose.model("UserAccount", useraccount, "useraccount");