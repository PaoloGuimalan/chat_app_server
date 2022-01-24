const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    username: {type: mongoose.Schema.Types.Mixed, required: true},
    email: {type: String, required: true},
    password: {type: mongoose.Schema.Types.Mixed, required: true}
})

module.exports = mongoose.model("Register", userSchema, 'users');