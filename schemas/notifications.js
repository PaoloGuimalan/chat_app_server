const mongoose = require("mongoose");

const notifSchema = new mongoose.Schema({
    notif_id: {type: Number, required: true},
    notif_description: {type: String, required: true},
    notif_to: {type: String, required: true},
    notif_from: {type: String, required: true},
    notif_date: {type: String, required: true},
    notif_type: {type: String, required: true},
    notif_status: {type: Boolean, required: true}
})

module.exports = mongoose.model("Notif", notifSchema, 'notifications');