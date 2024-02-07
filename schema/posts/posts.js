const mongoose = require("mongoose")

const posts = mongoose.Schema({
    postID: {type: mongoose.Schema.Types.Mixed, require: true},
    userID: {type: mongoose.Schema.Types.Mixed, require: true},
    content: {
        isShared: Boolean,
        references: [{
            name: {type: mongoose.Schema.Types.Mixed, require: true},
            referenceID: {type: mongoose.Schema.Types.Mixed, require: true},
            reference: {type: mongoose.Schema.Types.Mixed, require: true},
            caption: {type: mongoose.Schema.Types.Mixed, require: true},
            referenceMediaType: {type: mongoose.Schema.Types.Mixed, require: true}
        }],
        data: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    type: {
        fileType: {type: mongoose.Schema.Types.Mixed, require: true},
        contentType: {type: mongoose.Schema.Types.Mixed, require: true}
    },
    tagging: {
        isTagged: Boolean,
        users: [{ type: mongoose.Schema.Types.Mixed, require: true }]
    },
    privacy: {
        status: { type: mongoose.Schema.Types.Mixed, require: true },
        users: [{ type: mongoose.Schema.Types.Mixed, require: true }], //userID for filteration depending on status
    }, //public, friends, filtered
    onfeed: { type: mongoose.Schema.Types.Mixed, require: true }, //is on feed, archive, trash, etc.
    isSponsored: Boolean,
    isLive: Boolean,
    isOnMap: {
        status: Boolean,
        isStationary: Boolean
    },
    fromSystem: Boolean,
    dateposted: { type: mongoose.Schema.Types.Mixed, require: true }
});

module.exports = mongoose.model("Posts", posts, 'posts');