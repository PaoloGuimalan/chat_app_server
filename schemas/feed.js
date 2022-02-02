const mongoose = require("mongoose");

const feedSchema = new mongoose.Schema({
    post_id: {type: Number, required: true},
    username: {type: mongoose.Schema.Types.Mixed, required: true},
    feed: {type: mongoose.Schema.Types.Mixed, required: true},
    privacy: {type: String, required: true},
    allowmapfeed: {type: Boolean, required: true},
    date: {type: String, required: true},
    coordinates: {type: Array, required: true}
})

module.exports = mongoose.model('Feed', feedSchema, 'posts');