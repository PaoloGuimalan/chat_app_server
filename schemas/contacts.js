const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema({
    contact_id: {type: Number, required: true},
    list_from: {type: mongoose.Schema.Types.Mixed, required: true },
    contact_username: {type: mongoose.Schema.Types.Mixed, required: true},
    status: {type: String, required: true}
})

module.exports = mongoose.model("Contact", contactSchema, 'contacts');