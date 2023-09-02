const mongoose = require("mongoose")

const usercontacts = mongoose.Schema({
    contactID: { type: mongoose.Schema.Types.Mixed, require: true },
    actionBy: { type: mongoose.Schema.Types.Mixed, require: true },
    actionDate: {
        date: {type: mongoose.Schema.Types.Mixed, require: true},
        time: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    status: { type: Boolean, require: true },
    type: { type: mongoose.Schema.Types.Mixed, require: true },
    users: [
        {
            userID: { type: mongoose.Schema.Types.Mixed, require: true }
        }
    ]
})

module.exports = mongoose.model("UserContacts", usercontacts, "contacts")